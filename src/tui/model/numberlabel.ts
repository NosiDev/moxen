/**
 * How the settings pages write a number, so every picker reads the same:
 * small numbers and decimals as they are (`4`, `0.95`), big ones with
 * separators (`15,000`), and token windows that are powers of two as
 * `128K` / `1M`, with 1,000,000 (Claude Code's own ceiling) also `1M`.
 */
export function numberLabel(value: number, binary = false): string {
  if (Number.isInteger(value) && value >= 8192 && value % 1024 === 0) {
    if (value === 1_000_000 || value === 1_048_576) return "1M";
    return value >= 1_048_576 && value % 1_048_576 === 0 ? `${value / 1_048_576}M` : `${value / 1024}K`;
  }
  if (binary && value === 1_000_000) return "1M";
  return value >= 10_000 ? value.toLocaleString("en-US") : String(value);
}
