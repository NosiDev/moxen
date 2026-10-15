import { describe, expect, it } from "vitest";

import { normalizeConfig, setConfigValue } from "../config.js";
import { describeSettings } from "../configschema.js";
import { routeMcpServers, resolveMcpServers } from "../mcp.js";
import { testMcpServer } from "../mcptest.js";
import type { CliConfig } from "../types.js";

const base = normalizeConfig({}) as CliConfig;
const KEY = "mcpServers";

describe("MCP servers as a settings list", () => {
  it("adds a server by name, edits a field, keeps secrets hidden and removes it", () => {
    let config = setConfigValue(base, `${KEY}[files]`, JSON.stringify({ command: "npx", args: ["-y", "fs-mcp"] }));
    expect(config.mcpServers?.files).toEqual({ command: "npx", args: ["-y", "fs-mcp"] });

    config = setConfigValue(config, `${KEY}[files].args`, '-y fs-mcp "/my path"');
    expect(config.mcpServers?.files).toMatchObject({ args: ["-y", "fs-mcp", "/my path"] });

    config = setConfigValue(config, `${KEY}[files].env`, "TOKEN=abc\nREGION=eu");
    expect(config.mcpServers?.files).toMatchObject({ env: { TOKEN: "abc", REGION: "eu" } });
    const view = describeSettings(config).find((entry) => entry.descriptor.key === KEY)!.items![0]!;
    expect(view.fields.find((field) => field.path === "env")?.value).toBe("TOKEN=<hidden>\nREGION=<hidden>");
    expect(JSON.stringify(view)).not.toContain("abc");

    // Typing the marker keeps the stored value; a new value replaces it; a line left out removes it.
    config = setConfigValue(config, `${KEY}[files].env`, "TOKEN=<hidden>\nREGION=us");
    expect(config.mcpServers?.files).toMatchObject({ env: { TOKEN: "abc", REGION: "us" } });
    expect(() => setConfigValue(config, `${KEY}[files].env`, "NEW=<hidden>")).toThrow(/no stored value/);

    config = setConfigValue(config, `${KEY}[files].providers`, "claude, harness");
    config = setConfigValue(config, `${KEY}[files].disabledTools`, "delete_file, write_file");
    expect(config.mcpServers?.files).toMatchObject({ providers: ["claude", "harness"], disabledTools: ["delete_file", "write_file"] });
    expect(() => setConfigValue(config, `${KEY}[files].providers`, "grok")).toThrow(/providers/);

    config = setConfigValue(config, `${KEY}[files]`, "");
    expect(config.mcpServers).toBeUndefined();
  });

  it("routes servers to the providers they are offered to, and names the tools to hide", async () => {
    let config = setConfigValue(base, `${KEY}[all]`, JSON.stringify({ command: "a" }));
    config = setConfigValue(config, `${KEY}[claudeonly]`, JSON.stringify({ command: "b", providers: ["claude"], disabledTools: ["rm"] }));
    config = setConfigValue(config, `${KEY}[off]`, JSON.stringify({ command: "c", disabled: true }));
    const specs = await resolveMcpServers(config.mcpServers, null);
    const claude = routeMcpServers(specs, "claude");
    expect(claude.servers.map((server) => server.name)).toEqual(["all", "claudeonly"]);
    expect(claude.disabledTools).toEqual(["mcp__claudeonly__rm"]);
    expect(routeMcpServers(specs, "harness").servers.map((server) => server.name)).toEqual(["all"]);
  });

  it("tests a server by starting it and listing its tools", async () => {
    const config = setConfigValue(base, `${KEY}[files]`, JSON.stringify({ command: "npx" }));
    const fake = (async () => ({ tools: [{ name: "read" }, { name: "write" }], close: async () => undefined })) as never;
    const good = await testMcpServer("files", config.mcpServers, "/tmp", fake);
    expect(good).toMatchObject({ ok: true, tools: ["read", "write"] });
    expect(good.message).toContain("2 tools");
    const failing = (async () => {
      throw new Error("spawn npx ENOENT");
    }) as never;
    expect(await testMcpServer("files", config.mcpServers, "/tmp", failing)).toMatchObject({ ok: false });
    expect(await testMcpServer("ghost", config.mcpServers, "/tmp", fake)).toMatchObject({ ok: false });
  });
});
