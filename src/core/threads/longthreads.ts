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
import type { CliConfig, ProvidersConfig } from "../types.js";

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

// -- the line a thread passes ------------------------------------------------

/**
 * Where hand-off or compaction kicks in: a share of the model's window
 * (`70%`) or a size (`256K`), one value with one meaning on every tab. The
 * file keeps it as text (`"70%"`, `"32K"`); a bare number is tokens. K and M
 * count in powers of two, as every token window on the settings page does.
 */
export type ThresholdLine = { readonly percent: number } | { readonly tokens: number };

export const LINE_PERCENT_MIN = 10;
export const LINE_PERCENT_MAX = 95;
export const LINE_TOKENS_MIN = 4_096;
export const LINE_TOKENS_MAX = 2_000_000;

/** The line in `raw` (text or a token count), or null when it is not one or is out of range. */
export function parseLine(raw: unknown): ThresholdLine | null {
  if (typeof raw === "number") return Number.isInteger(raw) && raw >= LINE_TOKENS_MIN && raw <= LINE_TOKENS_MAX ? { tokens: raw } : null;
  if (typeof raw !== "string") return null;
  const match = /^(\d+(?:\.\d+)?)\s*(%|k|m)?$/i.exec(raw.trim());
  if (match === null) return null;
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  if (unit === "%") return Number.isInteger(amount) && amount >= LINE_PERCENT_MIN && amount <= LINE_PERCENT_MAX ? { percent: amount } : null;
  const tokens = Math.round(amount * (unit === "k" ? 1_024 : unit === "m" ? 1_048_576 : 1));
  return tokens >= LINE_TOKENS_MIN && tokens <= LINE_TOKENS_MAX ? { tokens } : null;
}

/** The line as the file and `config set` take it: `70%`, `32K`, or a plain count when it is not a whole K. */
export function lineText(line: ThresholdLine): string {
  if ("percent" in line) return `${line.percent}%`;
  return line.tokens % 1_048_576 === 0 ? `${line.tokens / 1_048_576}M` : line.tokens % 1_024 === 0 ? `${line.tokens / 1_024}K` : String(line.tokens);
}

/** The line as a page writes it: "70% of the window", "32K tokens". */
export function lineLabel(line: ThresholdLine): string {
  return "percent" in line ? `${line.percent}% of the window` : `${lineText(line)} tokens`;
}

/** The line in tokens for a window; null for a share when the window is unknown. */
export function lineTokens(line: ThresholdLine, maxTokens: number | null): number | null {
  if ("tokens" in line) return line.tokens;
  return maxTokens !== null && maxTokens > 0 ? Math.floor((maxTokens * line.percent) / 100) : null;
}

/** The pair `autoHandoffState` takes: a size needs no window, a share does. */
export function lineInput(line: ThresholdLine): { percent: number; tokens: number | null } {
  return "percent" in line ? { percent: line.percent, tokens: null } : { percent: 0, tokens: line.tokens };
}

// -- what is in force, most specific first ------------------------------------

export type LongThreadKind = "claude" | "opencode" | "harness";
export const LONG_THREAD_KINDS: readonly LongThreadKind[] = ["claude", "opencode", "harness"];

/**
 * Who compacts a long thread: the provider itself, Moxen asking first, Moxen
 * on its own, or nobody. The Moxen Harness is Moxen, so it only has on and
 * off; both CLIs run `/compact` as a turn, so the server can drive either.
 */
export type CompactionMode = "provider" | "ask" | "auto" | "off";
export const COMPACTION_MODES: Readonly<Record<LongThreadKind, readonly CompactionMode[]>> = {
  claude: ["provider", "ask", "auto", "off"],
  opencode: ["provider", "ask", "auto", "off"],
  harness: ["auto", "off"],
};
export const DEFAULT_COMPACTION_MODE: Readonly<Record<LongThreadKind, CompactionMode>> = { claude: "ask", opencode: "provider", harness: "auto" };

export const DEFAULT_AUTO_COMPACT_PERCENT = 80;
/** Where Moxen compacts when no tab sets a line; the Harness has its own rule by window size (`compactsettings.ts`). */
export const DEFAULT_COMPACT_LINE: ThresholdLine = { percent: DEFAULT_AUTO_COMPACT_PERCENT };

/** A value in force and the config key it was read from; `key` null is the built-in default. */
export interface Sourced<T> {
  readonly value: T;
  readonly key: string | null;
}

type LongThreadConfig = Pick<CliConfig, "ui" | "providers" | "longThreads">;

const isHandoffMode = (value: unknown): value is AutoHandoffMode => value === "off" || value === "ask" || value === "auto";

function kindOf(instanceId: string | undefined): LongThreadKind | undefined {
  if (instanceId === undefined) return undefined;
  const kind = driverKindOfInstance(instanceId);
  return kind === "claude" || kind === "opencode" || kind === "harness" ? kind : undefined;
}

/** The first candidate that holds a value. Within one level the newer key comes first, so it wins over the older one beside it. */
function firstOf<T>(candidates: ReadonlyArray<readonly [string, T | null | undefined]>, fallback: T): Sourced<T> {
  for (const [key, value] of candidates) if (value !== undefined && value !== null) return { value, key };
  return { value: fallback, key: null };
}

const percentLine = (value: number | undefined): ThresholdLine | undefined => (value === undefined ? undefined : { percent: value });
const tokensLine = (value: number | undefined): ThresholdLine | undefined => (value === undefined ? undefined : { tokens: value });
const textLine = (value: string | undefined): ThresholdLine | undefined => (value === undefined ? undefined : (parseLine(value) ?? undefined));

/** Hand off: the provider's tab, then the global setting, then Ask. */
export function handoffModeFor(config: LongThreadConfig, kind: LongThreadKind | undefined): Sourced<AutoHandoffMode> {
  const own = kind === undefined ? undefined : config.providers?.[kind];
  const candidates: Array<readonly [string, unknown]> = [
    ...(kind === undefined ? [] : ([[`providers.${kind}.handoff`, own?.handoff], [`providers.${kind}.autoHandoff`, own?.autoHandoff]] as const)),
    ["longThreads.handoff", config.longThreads?.handoff],
    ["ui.autoHandoff", config.ui?.autoHandoff],
  ];
  return firstOf<AutoHandoffMode>(candidates.map(([key, value]) => [key, isHandoffMode(value) ? value : undefined] as const), DEFAULT_AUTO_HANDOFF_MODE);
}

/**
 * Hand off at, whatever the unit: the model's own size, the provider's tab,
 * the global setting, half the window. Older keys sit at their own level, a size
 * before a share as it always was, so an older config resolves as before.
 */
export function handoffLineFor(config: LongThreadConfig, kind: LongThreadKind | undefined, model?: string): Sourced<ThresholdLine> {
  const own = kind === undefined ? undefined : config.providers?.[kind];
  return firstOf<ThresholdLine>(
    [
      ...(kind === undefined
        ? []
        : ([
            [`providers.${kind}.autoHandoffModels`, model === undefined ? undefined : tokensLine(own?.autoHandoffModels?.[model])],
            [`providers.${kind}.handoffAt`, textLine(own?.handoffAt)],
            [`providers.${kind}.autoHandoffTokens`, tokensLine(own?.autoHandoffTokens)],
            [`providers.${kind}.autoHandoffPercent`, percentLine(own?.autoHandoffPercent)],
          ] as const)),
      ["longThreads.handoffAt", textLine(config.longThreads?.handoffAt)],
      ["ui.autoHandoffTokens", tokensLine(config.ui?.autoHandoffTokens)],
      ["ui.autoHandoffPercent", percentLine(config.ui?.autoHandoffPercent)],
    ],
    { percent: DEFAULT_AUTO_HANDOFF_PERCENT },
  );
}

/** Who compacts on `kind`: its tab, else what the older switch meant, else the provider's default. */
export function compactionModeFor(config: Pick<CliConfig, "providers">, kind: LongThreadKind): Sourced<CompactionMode> {
  const own = config.providers?.[kind];
  const set = own?.compaction;
  const legacy = (): CompactionMode | undefined => {
    if (kind === "claude") {
      const old = config.providers?.claude?.autoCompact;
      return old === "claude" ? "provider" : old;
    }
    const old = config.providers?.[kind]?.autoCompact;
    return old === undefined ? undefined : old ? (kind === "harness" ? "auto" : "provider") : "off";
  };
  return firstOf<CompactionMode>(
    [
      [`providers.${kind}.compaction`, set !== undefined && COMPACTION_MODES[kind].includes(set) ? set : undefined],
      [`providers.${kind}.autoCompact`, legacy()],
    ],
    DEFAULT_COMPACTION_MODE[kind],
  );
}

/**
 * Compact at, whatever the unit: the provider's setting, the global one, 80%.
 * Null where the line is not Moxen's to draw: off, OpenCode's own compaction
 * (its buffer, `compactBuffer`), Claude Code's own unless its tab names a size
 * (which becomes Claude Code's auto-compact window), and the Harness's own
 * rule by window size when nothing is set.
 */
export function compactLineFor(config: LongThreadConfig, kind: LongThreadKind): Sourced<ThresholdLine> | null {
  const mode = compactionModeFor(config, kind).value;
  if (mode === "off") return null;
  const own = config.providers?.[kind];
  const ownLine: Array<readonly [string, ThresholdLine | undefined]> = [[`providers.${kind}.compactAt`, textLine(own?.compactAt)]];
  if (kind === "claude") {
    const claude = config.providers?.claude;
    ownLine.push(mode === "provider" ? ["providers.claude.autoCompactWindow", tokensLine(claude?.autoCompactWindow)] : ["providers.claude.autoCompactPercent", percentLine(claude?.autoCompactPercent)]);
  }
  if (kind === "harness") {
    const harness = config.providers?.harness;
    ownLine.push(["providers.harness.autoCompactTokens", tokensLine(harness?.autoCompactTokens)], ["providers.harness.autoCompactPercent", percentLine(harness?.autoCompactPercent)]);
  }
  if (mode === "provider") {
    if (kind !== "claude") return null;
    const size = ownLine.find(([, line]) => line !== undefined && "tokens" in line);
    return size === undefined ? null : { value: size[1]!, key: size[0] };
  }
  const found = [...ownLine, ["longThreads.compactAt", textLine(config.longThreads?.compactAt)] as const].find(([, line]) => line !== undefined);
  if (found !== undefined) return { value: found[1]!, key: found[0] };
  return kind === "harness" ? null : { value: DEFAULT_COMPACT_LINE, key: null };
}

/** What the server and a client act on for one thread. `compact` is null where Moxen does not compact it from outside. */
export interface LongThreadPolicy {
  readonly handoff: { readonly mode: AutoHandoffMode; readonly line: ThresholdLine };
  readonly compact: { readonly mode: "ask" | "auto"; readonly line: ThresholdLine } | null;
}

export function longThreadPolicy(config: LongThreadConfig, instanceId: string | undefined, model?: string): LongThreadPolicy {
  const kind = kindOf(instanceId);
  const handoff = { mode: handoffModeFor(config, kind).value, line: handoffLineFor(config, kind, model).value };
  // The Harness compacts inside its own loop; only the CLIs are compacted from outside, by a `/compact` turn.
  if (kind === undefined || kind === "harness") return { handoff, compact: null };
  const mode = compactionModeFor(config, kind).value;
  if (mode !== "ask" && mode !== "auto") return { handoff, compact: null };
  return { handoff, compact: { mode, line: compactLineFor(config, kind)?.value ?? DEFAULT_COMPACT_LINE } };
}

/**
 * The providers section as the drivers read it, with the long-thread rule
 * already applied: each driver keeps reading the one field it always has
 * (Claude Code's `autoCompact` and window, OpenCode's switch, the Harness's
 * `compaction` and `compactAt`), now holding what is in force, global line included.
 */
export function driverProviders(config: LongThreadConfig): ProvidersConfig | undefined {
  const providers = config.providers;
  const claudeMode = compactionModeFor(config, "claude").value;
  const claudeLine = compactLineFor(config, "claude");
  const opencodeMode = compactionModeFor(config, "opencode").value;
  const harnessLine = compactLineFor(config, "harness");
  const claudeWindow = claudeMode === "provider" && claudeLine !== null && "tokens" in claudeLine.value ? Math.min(1_000_000, Math.max(100_000, claudeLine.value.tokens)) : undefined;
  const { autoCompactWindow: _window, ...claudeRest } = providers?.claude ?? {};
  const { autoCompact: opencodeOwn, ...opencodeRest } = providers?.opencode ?? {};
  // OpenCode's own switch: on its own compaction, what its older key said (else OpenCode's config decides); otherwise off.
  const opencodeAuto = opencodeMode === "provider" ? (opencodeOwn === true ? true : undefined) : false;
  return {
    ...providers,
    claude: { ...claudeRest, autoCompact: claudeMode === "provider" ? "claude" : claudeMode, ...(claudeWindow !== undefined ? { autoCompactWindow: claudeWindow } : {}) },
    opencode: { ...opencodeRest, ...(opencodeAuto !== undefined ? { autoCompact: opencodeAuto } : {}) },
    harness: {
      ...providers?.harness,
      compaction: compactionModeFor(config, "harness").value === "off" ? "off" : "auto",
      ...(harnessLine !== null ? { compactAt: lineText(harnessLine.value) } : {}),
    },
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
 * - Moxen's compaction of a Claude Code or OpenCode thread on "auto"; on
 *   "ask" too when it is a delegated task or the thread is past the hard
 *   line, because the provider's own compaction is off and nothing else
 *   would do it.
 *
 * When a thread is past both lines, the lower one acts first: a compaction
 * set below the hand-off line runs before the thread is handed off, and is
 * not skipped because hand-off is on Automatic. "Ask" otherwise stays a card
 * for a client to draw.
 */
export function planLongThreadAction(config: Pick<CliConfig, "ui" | "providers" | "longThreads">, snapshot: LongThreadSnapshot): LongThreadAction | null {
  const usage = {
    usedTokens: snapshot.usedTokens,
    maxTokens: snapshot.maxTokens,
    hasReply: snapshot.hasReply,
    turnRunning: snapshot.turnRunning,
    runningSubthreads: snapshot.runningSubthreads,
    runningBackgroundTasks: snapshot.runningBackgroundTasks,
    queuedMessages: snapshot.queuedMessages,
  };
  const policy = longThreadPolicy(config, snapshot.instanceId, snapshot.model);
  const handOff = (): LongThreadAction | null => {
    if (policy.handoff.mode !== "auto" || snapshot.delegated || snapshot.continued) return null;
    const state = autoHandoffState({ ...usage, mode: "auto", ...lineInput(policy.handoff.line) });
    return state !== null && state.blockers.length === 0 ? { kind: "handoff" } : null;
  };
  const compact = (): LongThreadAction | null => {
    const own = policy.compact;
    if (own === null || snapshot.lastWasCompact) return null;
    // A compaction runs as a turn of its own and holds up nothing else, so only a running turn or queued messages wait for it.
    const state = autoHandoffState({ ...usage, runningSubthreads: 0, runningBackgroundTasks: 0, mode: own.mode, ...lineInput(own.line) });
    if (state === null || state.blockers.length > 0) return null;
    // A compaction that left the thread past the line is not repeated until it has dropped below it once.
    const line = lineTokens(own.line, snapshot.maxTokens);
    if (line !== null && snapshot.usedSinceCompact !== null && snapshot.usedSinceCompact.every((used) => used >= line)) return null;
    if (own.mode === "auto") return { kind: "compact", reason: "auto" };
    if (snapshot.delegated) return { kind: "compact", reason: "delegated" };
    const hard = compactHardTokens(own.line, snapshot.maxTokens);
    if (hard !== null && state.usedTokens >= hard) return { kind: "compact", reason: "hard-line" };
    return null;
  };
  return compactsFirst(policy, snapshot.maxTokens) ? (compact() ?? handOff()) : (handOff() ?? compact());
}

/** Whether compaction's line is below hand-off's, so it goes first; a share with no known window cannot be placed, and leaves hand-off first. */
export function compactsFirst(policy: LongThreadPolicy, maxTokens: number | null): boolean {
  if (policy.compact === null) return false;
  const compactAt = lineTokens(policy.compact.line, maxTokens);
  const handoffAt = lineTokens(policy.handoff.line, maxTokens);
  return compactAt !== null && handoffAt !== null && compactAt < handoffAt;
}

/** The hard line in tokens for a compaction line (see `compactHardLine`); null when the window is unknown. */
function compactHardTokens(line: ThresholdLine, maxTokens: number | null): number | null {
  if (maxTokens === null || maxTokens <= 0) return null;
  const at = lineTokens(line, maxTokens)!;
  return Math.min(Math.floor(maxTokens * 0.95), at + Math.ceil((maxTokens - at) / 2));
}
