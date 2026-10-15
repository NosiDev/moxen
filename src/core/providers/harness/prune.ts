/**
 * The cheap half of compaction: blank old tool results that the model is
 * unlikely to need again, so a thread can often stay under its limit without
 * paying for a summary. Results are replaced in place (never removed), so every
 * tool call keeps its result and the transcript stays valid for any server.
 *
 * The newest results are protected, small ones are not worth the swap, and
 * nothing is changed at all unless it frees a meaningful amount. Output that
 * was too big for the model was already saved to a file when it ran; the
 * placeholder points there when the result says where.
 */
import { estimateTokens, IMAGE_TOKENS } from "./context.js";
import type { ToolCall, TranscriptMessage } from "./types.js";

export interface PruneOptions {
  /** The newest tool output this many tokens is left alone. */
  readonly protectTokens: number;
  /** Pruning that would free less than this is not worth changing the history for. */
  readonly minSavingsTokens: number;
  /** A result shorter than this costs about as much as its placeholder. */
  readonly minResultTokens: number;
}

export const DEFAULT_PRUNE: PruneOptions = { protectTokens: 40_000, minSavingsTokens: 20_000, minResultTokens: 50 };

/** Results whose content the model cannot get back by calling again. */
const NEVER_PRUNED: ReadonlySet<string> = new Set(["skill"]);

export const UNEVENTFUL_PLACEHOLDER = "[Uneventful result elided]";
const CLEARED_PREFIX = "[Old tool output cleared";

export interface PruneResult {
  readonly messages: readonly TranscriptMessage[];
  readonly prunedCount: number;
  readonly savedTokens: number;
  /** False when nothing was worth changing; `messages` is then the input. */
  readonly applied: boolean;
}

const isPlaceholder = (content: string): boolean => content === UNEVENTFUL_PLACEHOLDER || content.startsWith(CLEARED_PREFIX);

/** A search that found nothing says nothing worth keeping. */
const isZeroMatch = (name: string, content: string): boolean => (name === "grep" && content.startsWith("No matches for ")) || (name === "glob" && content.startsWith("No files match "));

function savedPath(content: string): string | null {
  return /full output is saved at (.+?); read it/.exec(content)?.[1] ?? null;
}

function clearedPlaceholder(content: string, tokens: number): string {
  const path = savedPath(content);
  const way = path !== null ? `The full output is saved at ${path}.` : "Run the tool again if you need it.";
  return `${CLEARED_PREFIX} to save space (about ${tokens} tokens). ${way}]`;
}

/** A read that a later identical read supersedes. */
function supersededReads(messages: readonly TranscriptMessage[]): Set<string> {
  const callsById = new Map<string, ToolCall>();
  for (const message of messages) if (message.role === "assistant") for (const call of message.toolCalls ?? []) callsById.set(call.id, call);
  const later = new Set<string>();
  const superseded = new Set<string>();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "tool" || message.name !== "read") continue;
    const call = callsById.get(message.toolCallId);
    if (!call) continue;
    const key = call.arguments.replace(/\s+/g, "");
    if (later.has(key)) superseded.add(message.toolCallId);
    else later.add(key);
  }
  return superseded;
}

export function pruneToolResults(messages: readonly TranscriptMessage[], options: PruneOptions = DEFAULT_PRUNE): PruneResult {
  const superseded = supersededReads(messages);
  const replacements = new Map<number, string>();
  let saved = 0;
  let protectedSoFar = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "tool" || isPlaceholder(message.content) || NEVER_PRUNED.has(message.name)) continue;
    const tokens = estimateTokens(message.content) + (message.images?.length ?? 0) * IMAGE_TOKENS;
    const useless = isZeroMatch(message.name, message.content) || superseded.has(message.toolCallId);
    // A useless result is dropped wherever it sits; anything else only once it is out of the protected window.
    const inWindow = protectedSoFar < options.protectTokens;
    protectedSoFar += tokens;
    if (inWindow && !useless) continue;
    if (!useless && tokens < options.minResultTokens) continue;
    const placeholder = useless ? UNEVENTFUL_PLACEHOLDER : clearedPlaceholder(message.content, tokens);
    const gain = tokens - estimateTokens(placeholder);
    if (gain <= 0) continue;
    replacements.set(index, placeholder);
    saved += gain;
  }

  if (replacements.size === 0 || saved < options.minSavingsTokens) return { messages, prunedCount: 0, savedTokens: 0, applied: false };
  const pruned = messages.map((message, index) => {
    const placeholder = replacements.get(index);
    if (placeholder === undefined || message.role !== "tool") return message;
    // The picture goes with the text it came with.
    const { images: _images, ...rest } = message;
    return { ...rest, content: placeholder };
  });
  return { messages: pruned, prunedCount: replacements.size, savedTokens: saved, applied: true };
}
