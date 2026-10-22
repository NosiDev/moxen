import { describe, expect, it } from "vitest";

import { normalizeConfig, setConfigValue } from "../config.js";
import { describeSettings } from "../configschema.js";
import { routeMcpServers, resolveMcpServers } from "../mcp.js";
import { describeMcpServers } from "../mcpview.js";
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
    // The older "offered to" list is written as what it means: the provider it leaves out has the server switched off.
    expect(config.mcpServers?.files).toMatchObject({ disabledTools: ["delete_file", "write_file"] });
    expect(config.mcpServers?.files).not.toHaveProperty("providers");
    expect(config.providers?.opencode?.mcpExclude).toBe("files");
    expect(config.providers?.claude?.mcpExclude).toBeUndefined();
    expect(() => setConfigValue(config, `${KEY}[files].providers`, "grok")).toThrow(/providers/);

    config = setConfigValue(config, `${KEY}[files]`, "");
    expect(config.mcpServers).toBeUndefined();
  });

  it("routes servers to the providers they are offered to (through each one's checklist), and names the tools to hide", async () => {
    let config = setConfigValue(base, `${KEY}[all]`, JSON.stringify({ command: "a" }));
    config = setConfigValue(config, `${KEY}[claudeonly]`, JSON.stringify({ command: "b", providers: ["claude"], disabledTools: ["rm"] }));
    config = setConfigValue(config, `${KEY}[off]`, JSON.stringify({ command: "c", disabled: true }));
    const specs = await resolveMcpServers(config.mcpServers, null);
    const claude = routeMcpServers(specs, "claude");
    expect(claude.servers.map((server) => server.name)).toEqual(["all", "claudeonly"]);
    expect(claude.disabledTools).toEqual(["mcp__claudeonly__rm"]);
    expect(routeMcpServers(specs, "harness", config.providers?.harness?.mcpExclude).servers.map((server) => server.name)).toEqual(["all"]);
    expect(config.providers?.harness?.mcpExclude).toBe("claudeonly");
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

describe("who gets a server, as the MCP tab shows it", () => {
  it("names each provider's answer and where it is decided, and says what a server called moxen does", () => {
    const config = normalizeConfig({
      mcpServers: { moxen: { command: "my-moxen" }, docs: { command: "docs-mcp" }, off: { command: "x", disabled: true } },
      providers: { claude: { mcpExclude: "docs" } },
    });
    const items = describeMcpServers(config);
    const item = (id: string) => items.find((entry) => entry.id === id)!;
    expect(item("moxen").status).toMatch(/Replaces Moxen's built-in tools/);
    expect(item("docs").resolved).toEqual([
      { label: "Claude Code", value: "No", origin: "switched off under MCP servers on the Claude Code tab" },
      { label: "OpenCode", value: "Gets it", origin: "MCP servers on the OpenCode tab" },
      { label: "Moxen Harness", value: "Gets it", origin: "MCP servers on the Moxen Harness tab" },
    ]);
    expect(item("off").resolved.every((row) => row.value === "No")).toBe(true);
  });
});

