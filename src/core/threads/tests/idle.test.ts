import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vitest";

import type { CliConfig } from "../../types.js";
import { durationMs, forgetSession, sessionTtlFor, setIdleClock, sweepIdleSessions, touchSession, trackSession, type IdleDriver } from "../idle.js";
import type { ThreadStore } from "../store.js";
import type { StoredTurn } from "../types.js";

let now = 0;
setIdleClock(() => now);

/** A driver whose sessions are a set, and a store whose turns are whatever the test says. */
function world(turns: Partial<StoredTurn>[] = []) {
  const live = new Set<string>(["t1"]);
  const stopped: string[] = [];
  const driver: IdleDriver = {
    hasSession: (threadId) => Effect.succeed(live.has(threadId)),
    stopSession: (threadId) =>
      Effect.sync(() => {
        live.delete(threadId);
        stopped.push(threadId);
      }),
  };
  const store = { readTurns: async () => turns as StoredTurn[] } as unknown as ThreadStore;
  let unwatched = 0;
  const track = (ttlMs: number | null) => trackSession(driver, "t1", { store, ttlMs, unwatch: () => void (unwatched += 1) });
  return { driver, live, stopped, track, unwatched: () => unwatched };
}

const drivers: IdleDriver[] = [];
afterEach(() => {
  for (const driver of drivers.splice(0)) forgetSession(driver, "t1");
  now = 0;
});

describe("idle lifetimes", () => {
  it("reads the setting's own form, and a provider's own over the global one", () => {
    expect(durationMs("45s")).toBe(45_000);
    expect(durationMs("2m")).toBe(120_000);
    expect(durationMs("1h")).toBe(3_600_000);
    expect(durationMs("soon")).toBeNull();
    const config = { sessionTtl: "1h", providers: { harness: { sessionTtl: "8h" } } } as unknown as CliConfig;
    expect(sessionTtlFor(config, "harness")).toBe(8 * 3_600_000);
    expect(sessionTtlFor(config, "claude")).toBe(3_600_000);
  });
});

describe("ending idle sessions", () => {
  it("ends a session nothing happened on for its lifetime, and stops watching it", async () => {
    const w = world();
    drivers.push(w.driver);
    w.track(60_000);
    now = 59_000;
    expect(await sweepIdleSessions()).toEqual([]);
    now = 61_000;
    expect(await sweepIdleSessions()).toEqual(["t1"]);
    expect(w.stopped).toEqual(["t1"]);
    expect(w.unwatched()).toBe(1);
  });

  it("counts from the last thing that happened, and never ends one with background tasks", async () => {
    const w = world();
    drivers.push(w.driver);
    w.track(60_000);
    now = 50_000;
    touchSession(w.driver, "t1", 1);
    now = 200_000;
    expect(await sweepIdleSessions()).toEqual([]);
    touchSession(w.driver, "t1", 0);
    now = 230_000;
    expect(await sweepIdleSessions()).toEqual([]);
    now = 261_000;
    expect(await sweepIdleSessions()).toEqual(["t1"]);
  });

  it("leaves a session with a turn still open, or with no lifetime, alone", async () => {
    const open = world([{ id: "turn", status: "running" }]);
    drivers.push(open.driver);
    open.track(60_000);
    now = 120_000;
    expect(await sweepIdleSessions()).toEqual([]);
    forgetSession(open.driver, "t1");

    const never = world();
    drivers.push(never.driver);
    never.track(null);
    now = 10 * 3_600_000;
    expect(await sweepIdleSessions()).toEqual([]);
    expect(never.stopped).toEqual([]);
  });

  it("forgets a session that ended on its own", async () => {
    const w = world();
    drivers.push(w.driver);
    w.track(60_000);
    w.live.delete("t1");
    now = 120_000;
    expect(await sweepIdleSessions()).toEqual([]);
    expect(w.unwatched()).toBe(1);
  });
});
