/**
 * The long-thread rules (when to hand off, when Moxen compacts a Claude Code
 * thread) live in core (`core/threads/longthreads.ts`), where the server acts
 * on them after every turn. The TUI draws the "ask" card from the same
 * functions; what stays here is how the per-model setting is typed.
 */
export {
  DEFAULT_AUTO_COMPACT_PERCENT,
  DEFAULT_AUTO_HANDOFF_MODE,
  DEFAULT_AUTO_HANDOFF_PERCENT,
  autoHandoffState,
  compactFromConfig,
  handoffOverridesFromConfig,
  resolveCompact,
  resolveHandoff,
  type AutoHandoffInput,
  type AutoHandoffMode,
  type AutoHandoffState,
  type ClaudeCompact,
  type HandoffOverrides,
  type ProviderHandoff,
} from "../../core/threads/longthreads.js";

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

