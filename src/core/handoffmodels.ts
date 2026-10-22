/**
 * The per-model hand-off thresholds a provider can carry
 * (`providers.<kind>.autoHandoffModels`): model slug -> tokens of context.
 *
 * The file keeps an object; `config set` and the settings page take the same
 * thing as text, one `slug=tokens` per line or comma-separated, because a
 * slug may hold dots and slashes and so cannot be a dotted key. Tokens may
 * be written `500000`, `500k` or `1m` (thousands, not powers of two).
 */
import { CliError } from "./errors.js";

export const HANDOFF_TOKENS_MIN = 8_192;
export const HANDOFF_TOKENS_MAX = 2_000_000;

function parseTokens(text: string, label: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(text.trim());
  const scale = match?.[2]?.toLowerCase() === "k" ? 1_000 : match?.[2]?.toLowerCase() === "m" ? 1_000_000 : 1;
  const value = match === null ? Number.NaN : Math.round(Number(match[1]) * scale);
  if (!Number.isInteger(value) || value < HANDOFF_TOKENS_MIN || value > HANDOFF_TOKENS_MAX) {
    throw new CliError("INVALID_CONFIG", `${label} must be a token count between ${HANDOFF_TOKENS_MIN} and ${HANDOFF_TOKENS_MAX} (for example 500k or 1m).`);
  }
  return value;
}

/** `slug=tokens` pairs from text; empty text is no overrides. */
export function parseHandoffModels(text: string, label: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of text.split(/[\n,]/)) {
    const entry = part.trim();
    if (entry === "") continue;
    const at = entry.lastIndexOf("=");
    const slug = at < 0 ? "" : entry.slice(0, at).trim();
    if (slug === "") throw new CliError("INVALID_CONFIG", `${label} takes model=tokens pairs, for example claude-opus-4-5=500k.`);
    out[slug] = parseTokens(entry.slice(at + 1), `${label}: ${slug}`);
  }
  return out;
}

/** A value from the file (an object, or the same text `config set` takes) as a clean map; undefined when it holds nothing. */
export function normalizeHandoffModels(raw: unknown, label: string): Record<string, number> | undefined {
  let map: Record<string, number>;
  if (typeof raw === "string") map = parseHandoffModels(raw, label);
  else if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    map = {};
    for (const [slug, tokens] of Object.entries(raw)) {
      if (typeof tokens !== "number" && typeof tokens !== "string") throw new CliError("INVALID_CONFIG", `${label}: ${slug} must be a token count.`);
      map[slug] = parseTokens(String(tokens), `${label}: ${slug}`);
    }
  } else throw new CliError("INVALID_CONFIG", `${label} must be an object of model slug to tokens.`);
  return Object.keys(map).length > 0 ? map : undefined;
}

/** The text form: `slug=tokens`, comma-separated. */
export function formatHandoffModels(map: Record<string, number>): string {
  return Object.entries(map).map(([slug, tokens]) => `${slug}=${tokens}`).join(", ");
}
