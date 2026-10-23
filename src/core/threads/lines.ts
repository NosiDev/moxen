/**
 * Where hand-off or compaction kicks in, as pure values (`longthreads.ts`
 * holds the rules that pick one). Kept apart so the Moxen Harness's own
 * compaction settings can read a line without importing those rules.
 */

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

/** The hard line in tokens for a compaction line (see `compactHardLine` in `longthreads.ts`); null when the window is unknown. */
export function compactHardTokens(line: ThresholdLine, maxTokens: number | null): number | null {
  if (maxTokens === null || maxTokens <= 0) return null;
  const at = lineTokens(line, maxTokens)!;
  return Math.min(Math.floor(maxTokens * 0.95), at + Math.ceil((maxTokens - at) / 2));
}
