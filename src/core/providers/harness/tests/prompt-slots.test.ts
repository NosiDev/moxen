import { describe, expect, it } from "vitest";

import { buildSystemPrompt, subagentSlotsNote } from "../prompt.js";

describe("subagent slots note", () => {
  it("says nothing for an unlimited or unknown server", () => {
    expect(subagentSlotsNote(undefined)).toBe("");
    expect(subagentSlotsNote(Number.POSITIVE_INFINITY)).toBe("");
  });

  it("tells a one-slot model that subagents take turns", () => {
    expect(subagentSlotsNote(1)).toContain("one request at a time");
  });

  it("names the count for several slots", () => {
    expect(subagentSlotsNote(3)).toContain("3 requests at a time");
  });

  it("reaches the system prompt only when the subagent tool exists", () => {
    const base = { cwd: "/tmp", serverSlots: 1 };
    expect(buildSystemPrompt({ ...base, tools: new Set(["subagent"]) })).toContain("one request at a time");
    expect(buildSystemPrompt({ ...base, tools: new Set(["read"]) })).not.toContain("one request at a time");
  });
});
