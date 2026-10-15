import { describe, expect, it } from "vitest";

import { autoHandoffState, type AutoHandoffInput } from "../autohandoff.js";

const base: AutoHandoffInput = {
  mode: "ask",
  percent: 50,
  usedTokens: 60_000,
  maxTokens: 100_000,
  hasReply: true,
  turnRunning: false,
  runningSubthreads: 0,
  runningBackgroundTasks: 0,
  queuedMessages: 0,
};

describe("auto handoff", () => {
  it("stays quiet below the line, when off, with no reply, or with no known window", () => {
    expect(autoHandoffState({ ...base, usedTokens: 49_000 })).toBeNull();
    expect(autoHandoffState({ ...base, mode: "off" })).toBeNull();
    expect(autoHandoffState({ ...base, hasReply: false })).toBeNull();
    expect(autoHandoffState({ ...base, maxTokens: null })).toBeNull();
  });

  it("is ready past the line when nothing is running", () => {
    expect(autoHandoffState(base)).toEqual({ usedPercent: 60, blockers: [] });
  });

  it("names what holds it back", () => {
    const state = autoHandoffState({ ...base, turnRunning: true, runningSubthreads: 2, runningBackgroundTasks: 1, queuedMessages: 1 });
    expect(state?.blockers).toEqual(["a turn is running", "2 subthreads running", "1 background task running", "messages are queued"]);
  });
});
