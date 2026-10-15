/**
 * When and how a harness session compacts, resolved from the config. Kept
 * apart from `compact.ts` so config loading can use it without pulling in the
 * transport.
 */

export interface CompactionSettings {
  /** Compact on its own at the threshold; off leaves only the overflow rescue and `/compact`. */
  readonly auto: boolean;
  /** Of the context window. Unset: 0.7 for windows of 128k tokens or more, 0.6 for smaller ones. */
  readonly fraction: number | null;
  /** The threshold in tokens, which wins over `fraction`. */
  readonly tokens: number | null;
  /** The newest part of the conversation kept word for word. */
  readonly keepRecentTokens: number;
  /** Reasoning effort for the summary request, on servers that take one. */
  readonly effort: string;
}

export const DEFAULT_COMPACTION: CompactionSettings = { auto: true, fraction: null, tokens: null, keepRecentTokens: 15_000, effort: "low" };

/** Room always left under the threshold for the next answer and its tool results. */
const MIN_HEADROOM_TOKENS = 16_000;
const LARGE_WINDOW = 128_000;

/** Tokens at which the harness compacts by itself; null when it should not (switched off, or the window is unknown). */
export function autoCompactThreshold(contextWindow: number | null | undefined, settings: CompactionSettings): number | null {
  if (!settings.auto || !contextWindow) return null;
  if (settings.tokens !== null) return Math.min(settings.tokens, Math.floor(contextWindow * 0.95));
  const fraction = settings.fraction ?? (contextWindow >= LARGE_WINDOW ? 0.7 : 0.6);
  const byFraction = Math.floor(contextWindow * fraction);
  // The share and the headroom both apply; on a small window the headroom alone must not eat more than half.
  return Math.min(byFraction, Math.max(Math.floor(contextWindow * 0.5), contextWindow - MIN_HEADROOM_TOKENS));
}
