import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { childEnvironment, McpClient, McpClosedError } from "../mcpclient.js";
import { fakeHttpServer, stdioSpec, type FakeHttp } from "./mcpfixtures.js";

let dir: string;
const open: McpClient[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-mcp-"));
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((client) => client.close()));
  fs.rmSync(dir, { recursive: true, force: true });
});

const connect = async (...args: Parameters<typeof McpClient.connect>): Promise<McpClient> => {
  const client = await McpClient.connect(...args);
  open.push(client);
  return client;
};
const live = new AbortController().signal;

describe("stdio", () => {
  it("lists a server's tools sorted, with the read-only hint, and round-trips a call", async () => {
    const client = await connect(stdioSpec(dir), dir);
    expect(client.tools.map((tool) => tool.name)).toEqual(["big", "die", "echo", "env", "evil", "fail", "hang", "write_thing"]);
    expect(client.tools.find((tool) => tool.name === "echo")?.readOnly).toBe(true);
    expect(client.tools.find((tool) => tool.name === "write_thing")?.readOnly).toBe(false);
    expect(await client.call("echo", { text: "hello" }, live)).toEqual({ text: "hello", isError: false });
    expect(await client.call("fail", {}, live)).toEqual({ text: "it broke", isError: true });
    // A protocol error is a result the model reads, not a thrown failure.
    expect((await client.call("nope", {}, live)).isError).toBe(true);
  });

  it("starts the server with a small environment: not the harness's own, plus what the spec lists", async () => {
    process.env.MOXEN_TEST_SECRET = "sk-should-not-leak";
    try {
      const client = await connect(stdioSpec(dir, "files", { GIVEN: "yes" }), dir);
      expect(JSON.parse((await client.call("env", {}, live)).text)).toEqual({ secret: null, given: "yes" });
    } finally {
      delete process.env.MOXEN_TEST_SECRET;
    }
    expect(childEnvironment({ A: "1" }, { PATH: "/bin", OPENAI_API_KEY: "k", LC_ALL: "C", XDG_HOME: "x" })).toEqual({ PATH: "/bin", LC_ALL: "C", XDG_HOME: "x", A: "1" });
  });

  it("answers a call whose server dies with an error, and says it is gone afterwards", async () => {
    const client = await connect(stdioSpec(dir), dir);
    await expect(client.call("die", {}, live)).rejects.toThrow(McpClosedError);
    await expect(client.call("die", {}, live)).rejects.toThrow(/not running|exited/);
    expect(client.alive).toBe(false);
  });

  it("gives up on a call that never answers when the turn is interrupted, and on one that outlasts its time", async () => {
    const client = await connect(stdioSpec(dir), dir);
    const controller = new AbortController();
    const pending = client.call("hang", {}, controller.signal);
    setTimeout(() => controller.abort(new Error("interrupted")), 20);
    await expect(pending).rejects.toThrow("interrupted");
    const slow = await client.call("hang", {}, live, 50);
    expect(slow.isError).toBe(true);
    expect(slow.text).toMatch(/did not finish within/);
    expect(client.alive).toBe(true);
  });

  it("reports a command that cannot start without leaking anything, and stops waiting on one that never initialises", async () => {
    await expect(McpClient.connect({ name: "x", type: "stdio", command: "/no/such/program", args: [], env: { SECRET: "s3cret" } }, dir)).rejects.toThrow(/could not be started \(ENOENT\)/);
    const silent = path.join(dir, "silent.mjs");
    fs.writeFileSync(silent, "setInterval(() => {}, 1000);");
    const started = Date.now();
    await expect(McpClient.connect({ name: "x", type: "stdio", command: process.execPath, args: [silent], env: {} }, dir, 150)).rejects.toThrow(/did not answer within/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("stops the child it spawned when closed", async () => {
    const pidFile = path.join(dir, "pid");
    const script = path.join(dir, "pid.mjs");
    fs.writeFileSync(script, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    // The server never speaks MCP; the connect times out, which must also stop it.
    await expect(McpClient.connect({ name: "x", type: "stdio", command: process.execPath, args: [script], env: {} }, dir, 300)).rejects.toThrow();
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe("http", () => {
  let server: FakeHttp;
  beforeEach(async () => {
    server = await fakeHttpServer();
  });
  afterEach(async () => {
    await Promise.all(open.splice(0).map((client) => client.close()));
    await server.close();
  });
  const spec = (headers: Record<string, string>) => ({ name: "docs", type: "http" as const, url: server.url, headers });

  it("lists tools and round-trips a call, in a JSON answer and in an event stream, with the session and headers", async () => {
    const client = await connect(spec({ Authorization: `Bearer ${server.token}` }), dir);
    expect(client.tools.map((tool) => tool.name)).toContain("echo");
    expect(await client.call("echo", { text: "over json" }, live)).toEqual({ text: "over json", isError: false });
    server.setMode("sse");
    expect(await client.call("echo", { text: "over sse" }, live)).toEqual({ text: "over sse", isError: false });
    const last = server.seen.at(-1)!;
    expect(last["mcp-session-id"]).toBe("session-1");
    expect(last["mcp-protocol-version"]).toBe("2025-06-18");
  });

  it("fails a refused connection without echoing the URL or the headers", async () => {
    const error = await McpClient.connect(spec({ Authorization: "Bearer wrong" }), dir).catch((cause: Error) => cause);
    expect((error as Error).message).toBe("answered HTTP 401");
    server.setMode("redirect");
    const redirected = await McpClient.connect(spec({ Authorization: `Bearer ${server.token}` }), dir).catch((cause: Error) => cause);
    expect(String((redirected as Error).message)).not.toMatch(/127\.0\.0\.1|Bearer/);
  });

  it("refuses an answer past the size cap rather than holding it", async () => {
    const client = await connect(spec({ Authorization: `Bearer ${server.token}` }), dir);
    server.setMode("huge");
    await expect(client.call("big", {}, live)).rejects.toThrow(/larger than the limit/);
  });
});
