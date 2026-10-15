/**
 * How full the model's context window is. The total is what the server
 * reported for the last request (prompt plus what it wrote) whenever there is
 * one; with none yet (a resumed thread, a rollback) it is a character count,
 * and the reading says so with `estimated`. The shares by category are always
 * our estimate, scaled so they add up to that total.
 */
import type { ContextBreakdown, ContextWindowUsage } from "../spi.js";
import type { ModelUsage, ToolDefinition, TranscriptMessage } from "./types.js";

const CHARS_PER_TOKEN = 4;

export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

/** A picture costs about this much whatever its size (the base64 text would wildly overcount it). */
export const IMAGE_TOKENS = 1500;

/** What one transcript entry adds to the prompt, by characters. */
export function messageTokens(message: TranscriptMessage): number {
  switch (message.role) {
    case "system":
      return estimateTokens(message.content);
    case "user":
      return estimateTokens(message.content) + (message.images?.length ?? 0) * IMAGE_TOKENS;
    case "assistant":
      return (
        estimateTokens(message.content) +
        estimateTokens(message.reasoning ?? "") +
        estimateTokens(JSON.stringify(message.reasoningItems ?? [])) +
        (message.toolCalls ?? []).reduce((sum, call) => sum + estimateTokens(call.name) + estimateTokens(call.arguments), 0)
      );
    case "tool":
      return estimateTokens(message.content) + (message.images?.length ?? 0) * IMAGE_TOKENS;
  }
}

export const messagesTokens = (messages: readonly TranscriptMessage[]): number => messages.reduce((sum, message) => sum + messageTokens(message), 0);

export interface ContextInput {
  readonly messages: readonly TranscriptMessage[];
  readonly tools: readonly ToolDefinition[];
  /** The newest usage the server reported for this transcript; null when it has none (yet). */
  readonly reported: ModelUsage | null;
  readonly maxTokens: number | null;
  /** Tokens at which the harness compacts on its own; null when it does not (switched off, or no window known). */
  readonly autoCompactThreshold?: number | null;
}

interface Shares {
  system: number;
  tools: number;
  messages: number;
  toolResults: number;
  perTool: Map<string, number>;
}

function estimateShares(input: ContextInput): Shares {
  const shares: Shares = { system: 0, tools: estimateTokens(JSON.stringify(input.tools)), messages: 0, toolResults: 0, perTool: new Map() };
  const addTool = (name: string, tokens: number): void => void shares.perTool.set(name, (shares.perTool.get(name) ?? 0) + tokens);
  for (const message of input.messages) {
    switch (message.role) {
      case "system":
        shares.system += estimateTokens(message.content);
        break;
      case "user":
        shares.messages += estimateTokens(message.content);
        break;
      case "assistant":
        shares.messages += estimateTokens(message.content) + estimateTokens(message.reasoning ?? "");
        for (const call of message.toolCalls ?? []) {
          const tokens = estimateTokens(call.name) + estimateTokens(call.arguments);
          shares.toolResults += tokens;
          addTool(call.name, tokens);
        }
        break;
      case "tool": {
        const tokens = estimateTokens(message.content);
        shares.toolResults += tokens;
        addTool(message.name, tokens);
        break;
      }
    }
  }
  return shares;
}

const sumShares = (shares: Shares): number => shares.system + shares.tools + shares.messages + shares.toolResults;

export function contextUsageOf(input: ContextInput): ContextWindowUsage {
  const reported = input.reported;
  return {
    usedTokens: reported ? reported.inputTokens + reported.outputTokens : sumShares(estimateShares(input)),
    maxTokens: input.maxTokens,
    cachedInputTokens: reported ? reported.cachedInputTokens : null,
    autoCompactThreshold: input.autoCompactThreshold ?? null,
    compactsAutomatically: (input.autoCompactThreshold ?? null) !== null,
    estimated: reported === null,
  };
}

export function contextBreakdownOf(input: ContextInput): ContextBreakdown {
  const usage = contextUsageOf(input);
  const shares = estimateShares(input);
  const total = sumShares(shares);
  // The server's count is the truth; our shares only say how it divides.
  const scale = total > 0 ? usage.usedTokens / total : 1;
  const round = (value: number): number => Math.round(value * scale);
  const used = [
    { name: "System prompt", tokens: round(shares.system) },
    { name: "Tool definitions", tokens: round(shares.tools) },
    { name: "Messages", tokens: round(shares.messages) },
    { name: "Tool calls and results", tokens: round(shares.toolResults) },
  ].filter((row) => row.tokens > 0);
  const categories: ContextBreakdown["categories"] = [
    ...used.map((row) => ({ ...row, kind: "used" as const })),
    ...(usage.maxTokens !== null ? [{ name: "Free space", tokens: Math.max(0, usage.maxTokens - usage.usedTokens), kind: "free" as const }] : []),
  ];
  const tools = [...shares.perTool.entries()]
    .map(([name, tokens]) => ({ name, tokens: round(tokens) }))
    .filter((row) => row.tokens > 0)
    .sort((left, right) => right.tokens - left.tokens);
  return { ...usage, categories, estimated: true, ...(tools.length > 0 ? { tools } : {}) };
}
