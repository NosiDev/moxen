import { describe, expect, it } from "vitest";

import { testHarness, type SentTurn } from "../../testing/harness.js";
import type { CliConfig } from "../../types.js";
import { driverForInstance, flushTurnRunners } from "../execute.js";
import { compactHardLine, planLongThreadAction, type LongThreadSnapshot } from "../longthreads.js";
import { actOnLongThread, readLongThreadSnapshot, type OperationContext } from "../operations.js";
import type { ThreadStore } from "../store.js";
import { completeTurn, createThread, sendTurn } from "../threads.js";

const idle: LongThreadSnapshot = {
  instanceId: "claudeAgent",
  model: "claude-opus-5",
  usedTokens: 120_000,
  maxTokens: 200_000,
  hasReply: true,
  turnRunning: false,
  runningSubthreads: 0,
  runningBackgroundTasks: 0,
  queuedMessages: 0,
  delegated: false,
  lastWasCompact: false,
  usedSinceCompact: null,
  continued: false,
};

const claude = (own: Record<string, unknown>): Pick<CliConfig, "ui" | "providers"> => ({ providers: { claude: own } });

describe("planLongThreadAction", () => {
  it("leaves an 'ask' below the hard line to the card", () => {
    // Defaults: hand-off asks at 50%, Moxen's compaction asks at 80%.
    expect(planLongThreadAction({}, { ...idle, usedTokens: 170_000 })).toBeNull();
  });

  it("compacts an unanswered 'ask' past the hard line, and a delegated task at the line", () => {
    expect(compactHardLine(80)).toBe(90);
    expect(planLongThreadAction({}, { ...idle, usedTokens: 181_000 })).toEqual({ kind: "compact", reason: "hard-line" });
    expect(planLongThreadAction({}, { ...idle, usedTokens: 161_000, delegated: true })).toEqual({ kind: "compact", reason: "delegated" });
  });

  it("compacts on 'auto' at the line, once, and only when idle", () => {
    const auto = claude({ autoCompact: "auto" });
    expect(planLongThreadAction(auto, { ...idle, usedTokens: 161_000 })).toEqual({ kind: "compact", reason: "auto" });
    expect(planLongThreadAction(auto, { ...idle, usedTokens: 161_000, lastWasCompact: true })).toBeNull();
    expect(planLongThreadAction(auto, { ...idle, usedTokens: 161_000, turnRunning: true })).toBeNull();
    expect(planLongThreadAction(auto, { ...idle, usedTokens: 161_000, queuedMessages: 1 })).toBeNull();
    // A compaction that left the thread past the line waits until it has dropped below once.
    expect(planLongThreadAction(auto, { ...idle, usedTokens: 165_000, usedSinceCompact: [162_000, 165_000] })).toBeNull();
    expect(planLongThreadAction(auto, { ...idle, usedTokens: 161_000, usedSinceCompact: [40_000, 161_000] })).toEqual({ kind: "compact", reason: "auto" });
    // A running subthread does not hold a compaction up (it does a hand-off).
    expect(planLongThreadAction(auto, { ...idle, usedTokens: 161_000, runningSubthreads: 1 })).toEqual({ kind: "compact", reason: "auto" });
  });

  it("leaves compaction to Claude Code when it is in charge, and to other providers always", () => {
    expect(planLongThreadAction(claude({ autoCompact: "claude" }), { ...idle, usedTokens: 199_000 })).toBeNull();
    expect(planLongThreadAction({}, { ...idle, instanceId: "opencode/anthropic", usedTokens: 199_000 })).toBeNull();
  });

  it("hands off on 'auto' once, never for a delegated task, and not while work runs", () => {
    const auto = { ui: { autoHandoff: "auto" as const } };
    expect(planLongThreadAction(auto, idle)).toEqual({ kind: "handoff" });
    expect(planLongThreadAction(auto, { ...idle, continued: true })).toBeNull();
    expect(planLongThreadAction(auto, { ...idle, runningSubthreads: 1 })).toBeNull();
    expect(planLongThreadAction(auto, { ...idle, runningBackgroundTasks: 2 })).toBeNull();
    // A delegated task is compacted instead: its parent waits on this thread.
    expect(planLongThreadAction(auto, { ...idle, delegated: true })).toBeNull();
    expect(planLongThreadAction(auto, { ...idle, delegated: true, usedTokens: 161_000 })).toEqual({ kind: "compact", reason: "delegated" });
  });
});

async function claudeThread(store: ThreadStore, cwd: string) {
  return createThread(store, {
    projectId: "p",
    title: "Long one",
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
    env: { mode: "local", path: cwd, branch: null },
  });
}

async function finishedTurn(store: ThreadStore, threadId: string, prompt: string, usedTokens: number): Promise<void> {
  const { turn } = await sendTurn(store, threadId, { prompt });
  await store.appendLedger(threadId, "activity", {
    id: store.newId(),
    threadId,
    turnId: turn.id,
    kind: "context-window.updated",
    summary: `${usedTokens} / 200000 tokens in context`,
    payload: { usedTokens, maxTokens: 200_000 },
    createdAt: store.nowIso(),
  });
  await completeTurn(store, threadId, turn.id, { text: "Done." });
}

describe("readLongThreadSnapshot", () => {
  it("reads the latest reading, the reply, and whether the last turn was a compaction", async () => {
    const harness = await testHarness();
    const thread = await claudeThread(harness.store, harness.work);
    await finishedTurn(harness.store, thread.id, "Read the whole repo.", 100_000);
    await finishedTurn(harness.store, thread.id, "/compact", 30_000);
    const snapshot = await readLongThreadSnapshot(harness.store, thread.id);
    expect(snapshot).toMatchObject({ instanceId: "claudeAgent", usedTokens: 30_000, maxTokens: 200_000, hasReply: true, turnRunning: false, lastWasCompact: true, usedSinceCompact: [30_000], delegated: false, continued: false });
  });
});

describe("actOnLongThread", () => {
  it("compacts a thread no client has open, through an ordinary /compact turn", async () => {
    const sent: SentTurn[] = [];
    const harness = await testHarness({ onSendTurn: (turn) => sent.push(turn) });
    const owner = {};
    const ctx: OperationContext = {
      store: harness.store,
      storeRoot: harness.root,
      config: { ...harness.config, providers: { claude: { autoCompact: "auto" } } },
      driverFor: (instanceId) => driverForInstance(owner, instanceId, harness.drivers),
    };
    const thread = await claudeThread(harness.store, harness.work);
    await finishedTurn(harness.store, thread.id, "Read the whole repo.", 170_000);
    expect(await actOnLongThread(ctx, thread.id)).toEqual({ kind: "compact", reason: "auto" });
    await flushTurnRunners(2000);
    expect(sent.map((turn) => turn.prompt.trim())).toContain("/compact");
    // The compaction turn itself does not set off another one.
    expect(await actOnLongThread(ctx, thread.id)).toBeNull();
  });

  it("hands off on 'auto' with a note the TUI follows", async () => {
    const harness = await testHarness();
    const owner = {};
    const ctx: OperationContext = {
      store: harness.store,
      storeRoot: harness.root,
      config: { ...harness.config, ui: { autoHandoff: "auto" } },
      driverFor: (instanceId) => driverForInstance(owner, instanceId, harness.drivers),
    };
    const thread = await claudeThread(harness.store, harness.work);
    await finishedTurn(harness.store, thread.id, "Read the whole repo.", 120_000);
    expect(await actOnLongThread(ctx, thread.id)).toEqual({ kind: "handoff" });
    await flushTurnRunners(2000);
    const note = (await harness.store.readActivities(thread.id)).find((activity) => activity.kind === "thread.continued");
    expect(note?.payload).toMatchObject({ automatic: true });
    expect(await actOnLongThread(ctx, thread.id)).toBeNull();
  });
});
