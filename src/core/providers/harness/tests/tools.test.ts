import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseQuestions } from "../tools/ask.js";
import { boundOutput } from "../tools/bash.js";
import { bashTool } from "../tools/bash.js";
import { editTool, findOmissionPlaceholder, readTool, writeTool } from "../tools/files.js";
import { globMatcher, globTool, grepTool } from "../tools/search.js";
import { ReadState, type ToolContext } from "../tools/types.js";
import { validateToolArguments } from "../tools/validate.js";

let dir: string;
let context: ToolContext;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-tools-"));
  context = { cwd: dir, signal: new AbortController().signal, readState: new ReadState(), artifactDir: path.join(dir, ".artifacts") };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const put = (name: string, text: string): string => {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};

describe("read, edit, write", () => {
  it("numbers lines, pages through a long file, and says how to continue", async () => {
    const file = put("a.txt", Array.from({ length: 5 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
    const all = await readTool.run({ file_path: file }, context);
    expect(all.content).toContain("     1\tline 1");
    const part = await readTool.run({ file_path: file, offset: 2, limit: 2 }, context);
    expect(part.content).toContain("     2\tline 2");
    expect(part.content).toContain("offset=4");
    expect((await readTool.run({ file_path: file, offset: 9 }, context)).isError).toBe(true);
  });

  it("hands an image file to a model that can see it, says so to one that cannot, and refuses a file that only has the extension", async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
    const file = path.join(dir, "shot.png");
    fs.writeFileSync(file, png);
    const seen = await readTool.run({ file_path: file }, { ...context, acceptsImages: true });
    expect(seen.images).toEqual([{ name: "shot.png", mimeType: "image/png", data: png.toString("base64") }]);
    const blind = await readTool.run({ file_path: file }, context);
    expect(blind.images).toBeUndefined();
    expect(blind.content).toMatch(/cannot be shown pictures/);
    const fake = put("fake.png", "not really a picture\n");
    expect((await readTool.run({ file_path: fake }, { ...context, acceptsImages: true })).images).toBeUndefined();
  });

  it("refuses to edit a file that was not read, or that changed after it was read", async () => {
    const file = put("b.ts", "const a = 1;\n");
    const unread = await editTool.run({ file_path: file, old_string: "a = 1", new_string: "a = 2" }, context);
    expect(unread).toMatchObject({ isError: true });
    expect(unread.content).toMatch(/not read/);
    await readTool.run({ file_path: file }, context);
    fs.writeFileSync(file, "const a = 1; // changed elsewhere\n");
    const stale = await editTool.run({ file_path: file, old_string: "a = 1", new_string: "a = 2" }, context);
    expect(stale.content).toMatch(/changed since you last read/);
    expect(fs.readFileSync(file, "utf8")).toContain("changed elsewhere");
  });

  it("edits once, rejects an ambiguous or missing match, and replaces all on request", async () => {
    const file = put("c.ts", "x = 1\ny = 1\n");
    await readTool.run({ file_path: file }, context);
    expect((await editTool.run({ file_path: file, old_string: "= 1", new_string: "= 2" }, context)).content).toMatch(/occurs 2 times/);
    expect((await editTool.run({ file_path: file, old_string: "z = 1", new_string: "z = 2" }, context)).content).toMatch(/not found/);
    const done = await editTool.run({ file_path: file, old_string: "= 1", new_string: "= 2", replace_all: true }, context);
    expect(done.isError).toBeUndefined();
    expect(fs.readFileSync(file, "utf8")).toBe("x = 2\ny = 2\n");
    // The edit updated what the model has "read", so a second edit needs no re-read.
    expect((await editTool.run({ file_path: file, old_string: "x = 2", new_string: "x = 3" }, context)).isError).toBeUndefined();
  });

  it("accepts an old_string pasted with read's line-number prefix and in a CRLF file", async () => {
    const file = put("d.txt", "one\r\ntwo\r\n");
    await readTool.run({ file_path: file }, context);
    const result = await editTool.run({ file_path: file, old_string: "     1\tone\n     2\ttwo", new_string: "uno\ndos" }, context);
    expect(result.isError).toBeUndefined();
    expect(fs.readFileSync(file, "utf8")).toBe("uno\r\ndos\r\n");
  });

  it("does not save a placeholder where the model should have written code", async () => {
    const file = put("e.ts", "function a() {\n  return 1;\n}\n");
    await readTool.run({ file_path: file }, context);
    const edit = await editTool.run({ file_path: file, old_string: "return 1;", new_string: "// ... rest of the function unchanged" }, context);
    expect(edit.content).toMatch(/placeholder/);
    const write = await writeTool.run({ file_path: file, content: "function a() {}\n// ... existing code ...\n" }, context);
    expect(write.content).toMatch(/placeholder/);
    expect(fs.readFileSync(file, "utf8")).toContain("return 1;");
    expect(findOmissionPlaceholder("const rest = 1; // the rest is fine")).toBeNull();
  });

  it("writes a new file with its directories, but only overwrites one it has read", async () => {
    const file = path.join(dir, "new", "deep", "f.txt");
    expect((await writeTool.run({ file_path: file, content: "hi\n" }, context)).content).toMatch(/Created/);
    fs.writeFileSync(file, "outside change\n");
    expect((await writeTool.run({ file_path: file, content: "x" }, context)).content).toMatch(/changed since you last read/);
    await readTool.run({ file_path: file }, context);
    expect((await writeTool.run({ file_path: file, content: "x\n" }, context)).content).toMatch(/Overwrote/);
  });
});

describe("glob and grep", () => {
  beforeEach(() => {
    put("src/a.ts", "export const alpha = 1;\n// TODO fix\n");
    put("src/b.js", "const beta = 2;\n");
    put("node_modules/pkg/x.ts", "alpha\n");
    put("README.md", "alpha docs\n");
  });

  it("matches globs the way people write them, and skips dependency folders", async () => {
    expect(globMatcher("*.ts")("src/deep/a.ts")).toBe(true);
    expect(globMatcher("src/**/*.{ts,js}")("src/b.js")).toBe(true);
    expect(globMatcher("src/*.ts")("src/x/a.ts")).toBe(false);
    const found = await globTool.run({ pattern: "**/*.ts" }, context);
    expect(found.content).toBe(path.join(dir, "src/a.ts"));
  });

  it("greps in three output modes with context and a glob filter", async () => {
    const files = await grepTool.run({ pattern: "alpha" }, context);
    expect(files.content.split("\n").sort()).toEqual([path.join(dir, "README.md"), path.join(dir, "src/a.ts")]);
    const content = await grepTool.run({ pattern: "TODO", output_mode: "content", context: 1, glob: "*.ts" }, context);
    expect(content.content).toBe(`${path.join(dir, "src/a.ts")}-1-export const alpha = 1;\n${path.join(dir, "src/a.ts")}:2:// TODO fix`);
    expect((await grepTool.run({ pattern: "alpha", output_mode: "count", glob: "*.ts" }, context)).content).toBe(`${path.join(dir, "src/a.ts")}:1`);
    expect((await grepTool.run({ pattern: "(" }, context)).isError).toBe(true);
    expect((await grepTool.run({ pattern: "nothing-here" }, context)).content).toMatch(/No matches/);
  });
});

describe("bash", () => {
  it("returns output, and marks a failing command as an error with its exit code", async () => {
    expect((await bashTool.run({ command: "echo hi && echo err 1>&2" }, context)).content).toBe("hi\nerr");
    const failed = await bashTool.run({ command: "echo out; exit 3" }, context);
    expect(failed).toMatchObject({ isError: true });
    expect(failed.content).toContain("[exit code 3]");
  });

  it("stops a command that outlives its timeout, and one that is interrupted", async () => {
    const timed = await bashTool.run({ command: "sleep 30", timeout: 1000 }, context);
    expect(timed.content).toMatch(/timed out/);
    const controller = new AbortController();
    const running = bashTool.run({ command: "sleep 30" }, { ...context, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    expect((await running).content).toMatch(/interrupted/);
  }, 15000);

  it("cuts long output to its ends and saves the whole", () => {
    const text = `${"a".repeat(20_000)}${"z".repeat(20_000)}`;
    const bounded = boundOutput(text, path.join(dir, "out"));
    expect(bounded.length).toBeLessThan(text.length);
    expect(bounded).toMatch(/characters omitted\. The full output is saved at /);
    const saved = bounded.match(/saved at (\S+\.log)/)![1]!;
    expect(fs.readFileSync(saved, "utf8")).toBe(text);
  });
});

describe("validateToolArguments", () => {
  const schema = readTool.definition.parameters;

  it("fixes a number sent as a string and says what is wrong otherwise", () => {
    expect(validateToolArguments('{"file_path":"/a","limit":"50"}', schema, "read")).toEqual({ ok: true, args: { file_path: "/a", limit: 50 } });
    expect(validateToolArguments("{}", schema, "read")).toEqual({ ok: false, error: 'read needs the "file_path" argument.' });
    expect(validateToolArguments('{"file_path":"/a","limit":"many"}', schema, "read")).toMatchObject({ ok: false });
    expect(validateToolArguments("{not json", schema, "read")).toMatchObject({ ok: false });
  });
});

describe("ask", () => {
  // The answers come back keyed by the question's text; two equal texts would be one key.
  it("refuses two questions with the same text, and an unbounded list of options", () => {
    expect(parseQuestions([{ question: "Which?" }, { question: "Which?" }])).toMatchObject({ ok: false, error: expect.stringMatching(/must be different/) });
    expect(parseQuestions([{ question: "Which?", options: Array.from({ length: 9 }, (_, i) => ({ label: `o${i}` })) }])).toMatchObject({ ok: false });
    expect(parseQuestions([{ question: "Which?", header: "A very long header indeed" }])).toMatchObject({ ok: true, questions: [{ header: "A very long he", multiSelect: false, options: [] }] });
  });
});
