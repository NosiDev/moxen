import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { copySessionState, loadSessionState, saveSessionState, stateFile } from "../sessionstate.js";

describe("session state", () => {
  it("survives a restart, and a fork starts from it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moxen-state-"));
    expect(loadSessionState(dir, "hs_1")).toEqual({ todos: [], allowed: [] });
    saveSessionState(dir, "hs_1", { todos: [{ content: "Write tests", status: "in_progress" }], allowed: ["bash:bun run check"] });
    expect(loadSessionState(dir, "hs_1").allowed).toEqual(["bash:bun run check"]);
    expect(loadSessionState(dir, "hs_1").todos[0]?.content).toBe("Write tests");
    copySessionState(dir, "hs_1", "hs_2");
    expect(loadSessionState(dir, "hs_2").allowed).toEqual(["bash:bun run check"]);
  });

  it("ignores a damaged or foreign file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moxen-state-"));
    fs.mkdirSync(path.dirname(stateFile(dir, "x")), { recursive: true });
    fs.writeFileSync(stateFile(dir, "x"), "{not json");
    expect(loadSessionState(dir, "x")).toEqual({ todos: [], allowed: [] });
    fs.writeFileSync(stateFile(dir, "x"), JSON.stringify({ v: 99, todos: [{ content: "x", status: "pending" }] }));
    expect(loadSessionState(dir, "x").todos).toEqual([]);
    fs.writeFileSync(stateFile(dir, "x"), JSON.stringify({ v: 1, todos: [{ content: "ok", status: "pending" }, { content: 4, status: "pending" }, { content: "bad", status: "weird" }], allowed: ["a", 3] }));
    expect(loadSessionState(dir, "x")).toEqual({ todos: [{ content: "ok", status: "pending" }], allowed: ["a"] });
  });
});
