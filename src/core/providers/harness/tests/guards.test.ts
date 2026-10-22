import { describe, expect, it } from "vitest";

import { LoopGuard, RepeatWatch } from "../guards.js";
import { applyToolDescriptions, builtinTools } from "../tools/index.js";
import { retryAfterOf, retryDelayMs } from "../transport/chat.js";

describe("LoopGuard", () => {
  it("warns and then stops on the same call, whatever the spacing of its arguments", () => {
    const guard = new LoopGuard({ repeatWarn: 3, repeatStop: 5 });
    const verdicts = [1, 2, 3, 4, 5].map(() => guard.record("read", '{"path": "a"}'));
    expect(verdicts).toEqual(["ok", "ok", "warn", "warn", "stop"]);
    expect(guard.record("read", '{"path":"a"}')).toBe("stop");
  });

  it("does nothing when the call check is off", () => {
    const guard = new LoopGuard({ calls: false });
    expect(Array.from({ length: 12 }, () => guard.record("read", "{}")).every((verdict) => verdict === "ok")).toBe(true);
  });

  it("notices a rotation of different calls", () => {
    const guard = new LoopGuard();
    const out: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      out.push(guard.record("read", "{}"));
      out.push(guard.record("edit", "{}"));
    }
    expect(out.indexOf("warn")).toBeGreaterThan(-1);
    expect(out.at(-1)).toBe("stop");
  });

  it("does not count a call that keeps answering differently", () => {
    const guard = new LoopGuard({ repeatWarn: 3, repeatStop: 5 });
    const verdicts: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      verdicts.push(guard.record("bash", '{"command":"npm test"}'));
      guard.observe("bash", '{"command":"npm test"}', `${12 - i} failing`);
    }
    expect(verdicts.every((verdict) => verdict === "ok")).toBe(true);
  });

  it("still catches a call that answers the same every time", () => {
    const guard = new LoopGuard({ repeatWarn: 3, repeatStop: 5 });
    const verdicts: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      verdicts.push(guard.record("bash", '{"command":"npm test"}'));
      guard.observe("bash", '{"command":"npm test"}', "3 failing");
    }
    expect(verdicts).toEqual(["ok", "ok", "warn", "warn", "stop"]);
  });

  it("does not take a read-edit rotation for a loop while the reads keep changing", () => {
    const guard = new LoopGuard();
    const out: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      out.push(guard.record("read", "{}"));
      guard.observe("read", "{}", `version ${i}`);
      out.push(guard.record("edit", `{"step":${i}}`));
      guard.observe("edit", `{"step":${i}}`, "ok");
    }
    expect(out.every((verdict) => verdict === "ok")).toBe(true);
  });

  it("leaves distinct work alone", () => {
    const guard = new LoopGuard();
    for (let i = 0; i < 30; i += 1) expect(guard.record("read", `{"path":"${i}"}`)).toBe("ok");
  });
});

describe("RepeatWatch", () => {
  it("catches a stretch of text coming round again and again", () => {
    const watch = new RepeatWatch(6);
    const unit = "I will now check the configuration file again to be sure. ";
    let hit = false;
    for (let i = 0; i < 30 && !hit; i += 1) hit = watch.push(unit);
    expect(hit).toBe(true);
  });

  it("ignores ordinary prose and layout runs", () => {
    const watch = new RepeatWatch(6);
    expect(watch.push("-".repeat(2000))).toBe(false);
    const prose = Array.from({ length: 400 }, (_, i) => `sentence number ${i} says something quite different from the others`).join(". ");
    expect(watch.push(prose)).toBe(false);
  });
});

describe("retries", () => {
  it("reads Retry-After as seconds, a date or milliseconds", () => {
    expect(retryAfterOf(new Headers({ "retry-after": "7" }))).toBe(7000);
    expect(retryAfterOf(new Headers({ "retry-after-ms": "250" }))).toBe(250);
    expect(retryAfterOf(new Headers({ "retry-after": new Date(10_000).toUTCString() }), 4_000)).toBe(6000);
    expect(retryAfterOf(new Headers({ "retry-after": "soon" }))).toBeNull();
    expect(retryAfterOf(new Headers())).toBeNull();
  });

  it("waits what the server asked, capped, else backs off with jitter", () => {
    expect(retryDelayMs(1, 5000, () => 0)).toBe(5000);
    expect(retryDelayMs(1, 10 * 60_000, () => 0)).toBe(120_000);
    expect(retryDelayMs(3, null, () => 0.5)).toBe(4000);
    expect(retryDelayMs(10, null, () => 1)).toBeLessThanOrEqual(18_750);
  });
});

describe("tool descriptions", () => {
  it("replaces a description, or adds to it with a leading +", () => {
    const tools = builtinTools();
    const read = tools.find((tool) => tool.definition.name === "read")!;
    const [replaced] = applyToolDescriptions([read], { read: "Read a file." });
    expect(replaced!.definition.description).toBe("Read a file.");
    const [added] = applyToolDescriptions([read], { read: "+Always pass an absolute path." });
    expect(added!.definition.description).toBe(`${read.definition.description}\n\nAlways pass an absolute path.`);
    expect(added!.definition.name).toBe("read");
    expect(applyToolDescriptions([read], { nothing: "x" })[0]).toBe(read);
  });
});
