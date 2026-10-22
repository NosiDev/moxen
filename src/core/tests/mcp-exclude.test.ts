import { describe, expect, it } from "vitest";

import { normalizeConfig, setConfigValue } from "../config.js";
import { describeSettings } from "../configschema.js";
import { parseNameList, routeMcpServers, type McpServerSpec } from "../mcp.js";

const stdio = (name: string, extra: Partial<McpServerSpec> = {}): McpServerSpec => ({ name, type: "stdio", command: "x", args: [], env: {}, ...extra }) as McpServerSpec;

describe("per-provider MCP servers", () => {
  const servers = [stdio("fs"), stdio("gh", { providers: ["claude"] }), stdio("off", { disabled: true }), stdio("web")];

  it("drops the servers a provider switched off, on top of the server's own limits", () => {
    expect(routeMcpServers(servers, "claude", "web").servers.map((server) => server.name)).toEqual(["fs", "gh"]);
    expect(routeMcpServers(servers, "harness", "fs, web").servers.map((server) => server.name)).toEqual([]);
    expect(routeMcpServers(servers, "harness").servers.map((server) => server.name)).toEqual(["fs", "web"]);
  });

  it("hides no tool of a server it keeps out", () => {
    const withTools = [stdio("fs", { disabledTools: ["write"] }), stdio("web", { disabledTools: ["post"] })];
    expect(routeMcpServers(withTools, "claude", "web").disabledTools).toEqual(["mcp__fs__write"]);
  });

  it("reads a name list leniently", () => {
    expect(parseNameList(undefined)).toEqual([]);
    expect(parseNameList(" a, b ,,a ")).toEqual(["a", "b"]);
  });

  it("is a setting on each provider's page, set and cleared like any other", () => {
    for (const kind of ["claude", "opencode", "harness"] as const) {
      const key = `providers.${kind}.mcpExclude` as const;
      const set = setConfigValue(normalizeConfig({}), key, "fs,web");
      expect(set.providers?.[kind]?.mcpExclude).toBe("fs,web");
      const view = describeSettings(set).find((entry) => entry.descriptor.key === key);
      expect(view?.value).toBe("fs,web");
      expect(view?.descriptor.section).toBe(`provider:${kind}`);
      expect(setConfigValue(set, key, "").providers?.[kind]?.mcpExclude).toBeUndefined();
    }
  });
});
