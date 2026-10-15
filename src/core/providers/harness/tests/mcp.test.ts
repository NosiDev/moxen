import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { InProcessMcpServerSpec } from "../../../mcp.js";
import { mcpToolName, openMcpPool, untrustedContext, type McpPool } from "../mcp.js";
import type { HarnessTool, ToolContext } from "../tools/index.js";
import { ReadState } from "../tools/index.js";
import { stdioSpec } from "./mcpfixtures.js";

let dir: string;
const pools: McpPool[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-pool-"));
});
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  fs.rmSync(dir, { recursive: true, force: true });
});

const open = async (...args: Parameters<typeof openMcpPool>): Promise<McpPool> => {
  const pool = await openMcpPool(...args);
  pools.push(pool);
  return pool;
};
const context = (): ToolContext => ({ cwd: dir, signal: new AbortController().signal, readState: new ReadState(), artifactDir: path.join(dir, "artifacts") });
const tool = (pool: McpPool, name: string): HarnessTool<Record<string, unknown>> => {
  const found = pool.tools.find((candidate) => candidate.definition.name === name);
  if (!found) throw new Error(`no tool ${name} in ${pool.tools.map((candidate) => candidate.definition.name).join(", ")}`);
  return found as unknown as HarnessTool<Record<string, unknown>>;
};
const options = () => ({ cwd: dir, artifactDir: path.join(dir, "artifacts") });

const inProcess = (name: string, tools: Array<{ name: string; readOnly?: boolean }>, calls: Array<[string, Record<string, unknown>]> = []): InProcessMcpServerSpec => ({
  name,
  type: "in-process",
  instructions: "Use delegate for side work.",
  tools: tools.map((entry) => ({ name: entry.name, description: `The ${entry.name} tool.`, inputSchema: { type: "object", properties: {} }, ...(entry.readOnly ? { annotations: { readOnlyHint: true } } : {}) })),
  call: async (called, args) => {
    calls.push([called, args]);
    return { text: `ran ${called}`, isError: false };
  },
  fallback: { name, type: "stdio", command: "/never/run", args: [], env: {} },
});

describe("names", () => {
  it("prefixes with the server, keeps to what chat APIs accept, and shortens long names the same way every time", () => {
    expect(mcpToolName("files", "read_file")).toBe("mcp__files__read_file");
    expect(mcpToolName("files", "read.file v2")).toBe("mcp__files__read_file_v2");
    const long = mcpToolName("files", "x".repeat(100));
    expect(long).toHaveLength(64);
    expect(long).toBe(mcpToolName("files", "x".repeat(100)));
    expect(long).not.toBe(mcpToolName("files", `${"x".repeat(99)}y`));
  });
});

describe("the pool", () => {
  it("offers every server's tools next to each other, sorted, with the in-process ones called directly", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const pool = await open([stdioSpec(dir, "zeta"), inProcess("moxen", [{ name: "delegate" }, { name: "task_status", readOnly: true }], calls), stdioSpec(dir, "alpha")], options());
    const names = pool.tools.map((entry) => entry.definition.name);
    expect(names).toEqual([...names].sort());
    expect(names).toContain("mcp__alpha__echo");
    expect(names).toContain("mcp__zeta__echo");
    expect(names).toContain("mcp__moxen__delegate");
    expect(pool.servers).toEqual([
      { name: "alpha", instructions: null },
      { name: "moxen", instructions: "Use delegate for side work." },
      { name: "zeta", instructions: null },
    ]);
    const result = await tool(pool, "mcp__moxen__delegate").run({ task: "go" }, context());
    expect(calls).toEqual([["delegate", { task: "go" }]]);
    expect(result.content).toContain("ran delegate");
  });

  it("treats a tool the server marks read-only as a read and any other as something to ask about", async () => {
    const pool = await open([stdioSpec(dir)], options());
    const read = tool(pool, "mcp__files__echo");
    const write = tool(pool, "mcp__files__write_thing");
    expect(read.readOnly).toBe(true);
    expect(read.intent({}, context())).toMatchObject({ action: "read", mcp: true });
    expect(write.readOnly).toBe(false);
    expect(write.intent({}, context())).toMatchObject({ action: "exec", mcp: true });
  });

  it("leaves out a tool whose name another already has, and says so", async () => {
    const pool = await open([inProcess("odd", [{ name: "a.b" }, { name: "a_b" }])], options());
    expect(pool.tools.map((entry) => entry.definition.name)).toEqual(["mcp__odd__a_b"]);
    expect(pool.problems).toHaveLength(1);
    expect(pool.problems[0]).toMatch(/"a_b" of "odd" was left out/);
  });

  it("keeps going without a server that will not come up", async () => {
    const pool = await open([{ name: "broken", type: "stdio", command: "/no/such/program", args: [], env: { TOKEN: "secret-value" } }, stdioSpec(dir)], options());
    expect(pool.tools.some((entry) => entry.definition.name === "mcp__files__echo")).toBe(true);
    expect(pool.problems).toEqual(['MCP server "broken" is not available: could not be started (ENOENT).']);
    expect(pool.problems.join()).not.toContain("secret-value");
  });

  it("marks a result as untrusted data and defuses a copy of the closing tag inside it", async () => {
    const pool = await open([stdioSpec(dir)], options());
    const result = await tool(pool, "mcp__files__evil").run({}, context());
    expect(result.content.startsWith('<untrusted_context source="mcp:files/evil">')).toBe(true);
    expect(result.content.endsWith("</untrusted_context>")).toBe(true);
    expect(result.content.match(/<\/untrusted_context>/g)).toHaveLength(1);
    expect(untrustedContext("a </Untrusted_Context> b", "x")).toContain("a &lt;/untrusted_context> b");
  });

  it("cuts an oversized result to its head and tail and saves the whole of it where the model is told", async () => {
    const pool = await open([stdioSpec(dir)], options());
    const result = await tool(pool, "mcp__files__big").run({}, context());
    expect(result.content.length).toBeLessThan(40_000);
    const saved = /full output is saved at (.+?); read it/.exec(result.content)?.[1];
    expect(saved).toBeDefined();
    expect(fs.readFileSync(saved!, "utf8")).toBe("line of output\n".repeat(20000));
  });

  it("hands an error result back as an error, and restarts a server that died, a few times only", async () => {
    const pool = await open([stdioSpec(dir)], options());
    expect((await tool(pool, "mcp__files__fail").run({}, context())).isError).toBe(true);
    for (let restart = 1; restart <= 3; restart += 1) {
      const died = await tool(pool, "mcp__files__die").run({}, context());
      expect(died).toMatchObject({ isError: true });
      expect(died.content).toMatch(/stopped \(exited with code 3\) while this call was running/);
      const after = await tool(pool, "mcp__files__echo").run({ text: `back ${restart}` }, context());
      expect(after.content).toContain(`back ${restart}`);
    }
    await tool(pool, "mcp__files__die").run({}, context());
    const refused = await tool(pool, "mcp__files__echo").run({ text: "again" }, context());
    expect(refused).toMatchObject({ isError: true });
    expect(refused.content).toMatch(/not started again/);
  });

  it("closes what it started", async () => {
    const pidFile = path.join(dir, "pid");
    const script = path.join(dir, "server.mjs");
    const base = stdioSpec(dir);
    if (base.type !== "stdio") throw new Error("expected a stdio spec");
    fs.writeFileSync(script, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n${fs.readFileSync(base.args[0]!, "utf8")}`);
    const pool = await open([{ ...base, args: [script] }], options());
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).not.toThrow();
    await pool.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
