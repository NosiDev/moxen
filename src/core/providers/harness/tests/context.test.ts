import { describe, expect, it } from "vitest";

import { contextBreakdownOf, contextUsageOf } from "../context.js";
import type { TranscriptMessage } from "../types.js";

const messages: TranscriptMessage[] = [
  { role: "system", content: "s".repeat(4000) },
  { role: "user", content: "u".repeat(400) },
  { role: "assistant", content: "a".repeat(400), toolCalls: [{ id: "c1", name: "read", arguments: "{}" }] },
  { role: "tool", toolCallId: "c1", name: "read", content: "r".repeat(4000) },
];
const tools = [{ name: "read", description: "d".repeat(400), parameters: {} }];
const reported = { inputTokens: 3000, outputTokens: 100, cachedInputTokens: 2500, reasoningTokens: 0 };

describe("context reading", () => {
  it("takes the total from the server's usage and flags an estimate only when there is none", () => {
    expect(contextUsageOf({ messages, tools, reported, maxTokens: 10000 })).toMatchObject({ usedTokens: 3100, cachedInputTokens: 2500, maxTokens: 10000, estimated: false });
    const guessed = contextUsageOf({ messages, tools, reported: null, maxTokens: null });
    expect(guessed).toMatchObject({ estimated: true, cachedInputTokens: null });
    expect(guessed.usedTokens).toBeGreaterThan(1500);
  });

  it("divides the server's total by category so the shares add up to it, with the free space beside them", () => {
    const breakdown = contextBreakdownOf({ messages, tools, reported, maxTokens: 10000 });
    const used = breakdown.categories.filter((row) => row.kind === "used").reduce((sum, row) => sum + row.tokens, 0);
    expect(Math.abs(used - 3100)).toBeLessThanOrEqual(breakdown.categories.length);
    expect(breakdown.categories.find((row) => row.kind === "free")?.tokens).toBe(6900);
    expect(breakdown.estimated).toBe(true);
    expect(breakdown.tools?.[0]).toMatchObject({ name: "read" });
  });
});
