/**
 * When a long thread should move to a fresh one. Tool calls start to go
 * wrong well before the window is full, so past a share of it (half by
 * default) the thread is handed off: a new thread opened with a handoff
 * written from this one's ledger. Moxen does it, not the model, and only
 * when nothing is running that the new thread would lose track of.
 */
import { driverKindOfInstance } from "../../core/types.js";
import type { ProvidersConfig, UiConfig } from "../../core/types.js";

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

/** The per-model setting as a snapshot carries it (`slug=tokens, …`, tokens plain numbers; core has already validated it). */
export function handoffModelsFromText(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of text.split(/[\n,]/)) {
    const at = part.lastIndexOf("=");
    const tokens = Number(part.slice(at + 1));
    if (at > 0 && Number.isFinite(tokens)) out[part.slice(0, at).trim()] = tokens;
  }
  return out;
}

/** The per-model map as the setting takes it back: `slug=tokens` pairs, comma-separated; empty when none are left (which clears the setting). */
export function handoffModelsToText(models: Readonly<Record<string, number>>): string {
  return Object.entries(models).map(([slug, tokens]) => `${slug}=${tokens}`).join(", ");
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
