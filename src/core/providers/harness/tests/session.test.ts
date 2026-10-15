import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HarnessTranscript } from "../session.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-session-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("HarnessTranscript", () => {
  it("resumes what was written, ignoring a last line a crash cut short", () => {
    const file = HarnessTranscript.pathFor(dir, "s1");
    const first = HarnessTranscript.open(file);
    first.append({ role: "user", content: "hi" });
    first.append({ role: "assistant", content: "hello" });
    fs.appendFileSync(file, '{"v":1,"m":{"role":"user","con');
    expect(HarnessTranscript.open(file).messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("drops the last prompts and everything after them on rollback", () => {
    const transcript = HarnessTranscript.open(HarnessTranscript.pathFor(dir, "s2"));
    transcript.append({ role: "system", content: "S" });
    for (const n of [1, 2, 3]) {
      transcript.append({ role: "user", content: `q${n}` });
      transcript.append({ role: "assistant", content: `a${n}` });
    }
    expect(transcript.rollback(2)).toBe(2);
    expect(transcript.messages.map((m) => (m.role === "system" ? "S" : m.content))).toEqual(["S", "q1", "a1"]);
    // What is on disk matches, so a restart sees the rolled-back thread.
    expect(HarnessTranscript.open(transcript.file).messages).toHaveLength(3);
  });
});
