/**
 * When a long thread should move to a fresh one, or be compacted. Tool
 * calls start to go wrong well before the window is full, so past a share
 * of it (half by default) the thread is handed off: a new thread opened
 * with a handoff written from this one's ledger. Moxen does it, not the
 * model, and only when nothing is running that the new thread would lose
 * track of.
 *
 * These are pure rules over values, so a client may apply them (the TUI
 * draws the "ask" card from them) — but the server is the one that acts:
 * after every turn settles it reads the thread back (`operations.ts`
 * `actOnLongThread`) and hands off or compacts when the settings say to do
 * it unasked (`planLongThreadAction`). Before, all
 * of it ran in the TUI for the thread on screen, so a thread nobody had
 * open (a delegated task, one driven from the CLI) was never compacted,
 * while Claude Code's own compaction was switched off for it.
 */
import { driverKindOfInstance } from "../types.js";
import type { CliConfig, ProvidersConfig, UiConfig } from "../types.js";

export type AutoHandoffMode = "off" | "ask" | "auto";

export const DEFAULT_AUTO_HANDOFF_MODE: AutoHandoffMode = "ask";
export const DEFAULT_AUTO_HANDOFF_PERCENT = 50;

export interface AutoHandoffInput {
  mode: AutoHandoffMode;
  percent: number;
  /** Hand off once this many tokens are in use; wins over `percent`, and needs no window. */
  tokens?: number | null;
  usedTokens: number | null;
  maxTokens: number | null;
  /** The assistant has said something there is to hand over. */
  hasReply: boolean;
  turnRunning: boolean;
  runningSubthreads: number;
  runningBackgroundTasks: number;
  queuedMessages: number;
}

export interface AutoHandoffState {
  /** Share of the window in use, 0–100; null when the provider does not report the window. */
  usedPercent: number | null;
  usedTokens: number;
  /** What stops a handoff right now, as short phrases; empty when it can go. */
  blockers: string[];
}

/** Null while the thread is below the line (or the feature is off). */
export function autoHandoffState(input: AutoHandoffInput): AutoHandoffState | null {
  if (input.mode === "off" || !input.hasReply || input.usedTokens === null) return null;
  const windowKnown = input.maxTokens !== null && input.maxTokens > 0;
  const usedPercent = windowKnown ? Math.round((input.usedTokens / input.maxTokens!) * 100) : null;
  if (input.tokens !== undefined && input.tokens !== null) {
    if (input.usedTokens < input.tokens) return null;
  } else {
    if (usedPercent === null || usedPercent < input.percent) return null;
  }
  const blockers: string[] = [];
  if (input.turnRunning) blockers.push("a turn is running");
  if (input.runningSubthreads > 0) blockers.push(`${input.runningSubthreads} subthread${input.runningSubthreads === 1 ? "" : "s"} running`);
  if (input.runningBackgroundTasks > 0) blockers.push(`${input.runningBackgroundTasks} background task${input.runningBackgroundTasks === 1 ? "" : "s"} running`);
  if (input.queuedMessages > 0) blockers.push("messages are queued");
  return { usedPercent, usedTokens: input.usedTokens, blockers };
}

/** What each provider's own settings page says about handing off; absent keys follow the global ones. */
export interface ProviderHandoff {
  mode?: AutoHandoffMode;
  tokens?: number;
  percent?: number;
  /** Tokens per model slug. */
  models?: Record<string, number>;
}
export type HandoffOverrides = Partial<Record<"claude" | "opencode" | "harness", ProviderHandoff>>;

/**
 * Moxen's own compaction of a Claude Code thread (Claude Code's is switched
 * off while it is on): past a share of the window, ask or just send
 * `/compact`. Same trigger and blockers as a hand-off, so `autoHandoffState`
 * decides when; this is only which mode and share are in force.
 */
export const DEFAULT_AUTO_COMPACT_PERCENT = 80;
export interface ClaudeCompact {
  mode?: "claude" | "ask" | "auto";
  percent?: number;
}

/** Null where Moxen does not compact (another provider, or the provider's own compaction is in charge). */
export function resolveCompact(own: ClaudeCompact | undefined, instanceId: string | undefined): { mode: "ask" | "auto"; percent: number } | null {
  if (instanceId === undefined || driverKindOfInstance(instanceId) !== "claude") return null;
  const mode = own?.mode ?? "ask";
  if (mode === "claude") return null;
  return { mode, percent: own?.percent ?? DEFAULT_AUTO_COMPACT_PERCENT };
}

export function compactFromConfig(providers: ProvidersConfig | undefined): ClaudeCompact {
  const claude = providers?.claude;
  return { ...(claude?.autoCompact !== undefined ? { mode: claude.autoCompact } : {}), ...(claude?.autoCompactPercent !== undefined ? { percent: claude.autoCompactPercent } : {}) };
}

const HANDOFF_KINDS = ["claude", "opencode", "harness"] as const;

export function handoffOverridesFromConfig(providers: ProvidersConfig | undefined): HandoffOverrides {
  const out: HandoffOverrides = {};
  for (const kind of HANDOFF_KINDS) {
    const own = providers?.[kind];
    if (own === undefined) continue;
    const entry: ProviderHandoff = {
      ...(own.autoHandoff !== undefined ? { mode: own.autoHandoff } : {}),
      ...(own.autoHandoffTokens !== undefined ? { tokens: own.autoHandoffTokens } : {}),
      ...(own.autoHandoffPercent !== undefined ? { percent: own.autoHandoffPercent } : {}),
      ...(own.autoHandoffModels !== undefined ? { models: own.autoHandoffModels } : {}),
    };
    if (Object.keys(entry).length > 0) out[kind] = entry;
  }
  return out;
}

/**
 * The mode and threshold in force for a thread on `instanceId` running
 * `model`. The mode is the provider's own, else the global one, else the
 * default. The threshold, most specific first: the model's own tokens, the
 * provider's tokens, the provider's share of the window, the global tokens,
 * the global share, half the window. A share is returned with `tokens: null`
 * so the window the provider reports decides the line.
 */
export function resolveHandoff(
  ui: UiConfig | null | undefined,
  overrides: HandoffOverrides,
  instanceId: string | undefined,
  model?: string,
): { mode: AutoHandoffMode; percent: number; tokens: number | null } {
  const own = instanceId === undefined ? undefined : overrides[driverKindOfInstance(instanceId) as keyof HandoffOverrides];
  const modelTokens = model === undefined ? undefined : own?.models?.[model];
  const tokens = modelTokens ?? own?.tokens ?? (own?.percent !== undefined ? null : (ui?.autoHandoffTokens ?? null));
  return {
    mode: own?.mode ?? ui?.autoHandoff ?? DEFAULT_AUTO_HANDOFF_MODE,
    percent: own?.percent ?? ui?.autoHandoffPercent ?? DEFAULT_AUTO_HANDOFF_PERCENT,
    tokens,
  };
}

// -- what the server does on its own --------------------------------------------

/** The prompt that asks a provider to compact its conversation (the server interprets it as a maintenance turn). */
export const COMPACT_PROMPT = "/compact";

/**
 * Where an unanswered "ask" stops waiting: halfway from the line to a full
 * window (80% -> 90%). Moxen switched Claude Code's own compaction off, so
 * a card nobody answers must not let the thread run into the wall.
 */
export function compactHardLine(percent: number): number {
  return Math.min(95, percent + Math.ceil((100 - percent) / 2));
}

/** What the server reads back from a thread after a turn, to decide whether to act. */
export interface LongThreadSnapshot {
  readonly instanceId: string;
  readonly model: string;
  readonly usedTokens: number | null;
  readonly maxTokens: number | null;
  readonly hasReply: boolean;
  readonly turnRunning: boolean;
  readonly runningSubthreads: number;
  readonly runningBackgroundTasks: number;
  readonly queuedMessages: number;
  /** A delegated task: no one is there to answer a card, and its parent waits on this very thread. */
  readonly delegated: boolean;
  /** The last turn was a compaction, so the reading may predate it: never compact twice in a row. */
  readonly lastWasCompact: boolean;
  /**
   * Context readings recorded since the last compaction started, oldest first;
   * null when the thread was never compacted. While every one is still past the
   * line, that compaction did not help and is not tried again.
   */
  readonly usedSinceCompact: readonly number[] | null;
  /** The thread was already continued in a new one. */
  readonly continued: boolean;
}

export type LongThreadAction =
  | { readonly kind: "handoff" }
  | { readonly kind: "compact"; readonly reason: "auto" | "delegated" | "hard-line" };

/**
 * What the server does unasked once a turn has settled, or null.
 *
 * - Hand-off on "auto", never for a delegated task (its parent waits on this
 *   thread's id) and once per thread.
 * - Moxen's compaction of a Claude Code thread on "auto"; on "ask" too when
 *   it is a delegated task or the thread is past the hard line, because
 *   Claude Code's own compaction is off and nothing else would do it.
 *
 * "Ask" otherwise stays a card for a client to draw.
 */
export function planLongThreadAction(config: Pick<CliConfig, "ui" | "providers">, snapshot: LongThreadSnapshot): LongThreadAction | null {
  const usage = {
    usedTokens: snapshot.usedTokens,
    maxTokens: snapshot.maxTokens,
    hasReply: snapshot.hasReply,
    turnRunning: snapshot.turnRunning,
    runningSubthreads: snapshot.runningSubthreads,
    runningBackgroundTasks: snapshot.runningBackgroundTasks,
    queuedMessages: snapshot.queuedMessages,
  };
  const handoff = resolveHandoff(config.ui, handoffOverridesFromConfig(config.providers), snapshot.instanceId, snapshot.model);
  if (handoff.mode === "auto" && !snapshot.delegated && !snapshot.continued) {
    const state = autoHandoffState({ ...usage, mode: "auto", percent: handoff.percent, tokens: handoff.tokens });
    if (state !== null && state.blockers.length === 0) return { kind: "handoff" };
  }
  const compact = resolveCompact(compactFromConfig(config.providers), snapshot.instanceId);
  if (compact === null || snapshot.lastWasCompact) return null;
  // A compaction runs as a turn of its own and holds up nothing else, so only a running turn or queued messages wait for it.
  const state = autoHandoffState({ ...usage, runningSubthreads: 0, runningBackgroundTasks: 0, mode: compact.mode, percent: compact.percent });
  if (state === null || state.blockers.length > 0) return null;
  // A compaction that left the thread past the line is not repeated until it has dropped below it once.
  const line = snapshot.maxTokens === null ? null : (snapshot.maxTokens * compact.percent) / 100;
  if (line !== null && snapshot.usedSinceCompact !== null && snapshot.usedSinceCompact.every((used) => used >= line)) return null;
  if (compact.mode === "auto") return { kind: "compact", reason: "auto" };
  if (snapshot.delegated) return { kind: "compact", reason: "delegated" };
  if (state.usedPercent !== null && state.usedPercent >= compactHardLine(compact.percent)) return { kind: "compact", reason: "hard-line" };
  return null;
}
