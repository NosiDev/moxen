import { describe, expect, it } from "vitest";

import { PROVIDER_PRESETS } from "../../../core/providers/harness/presets.js";
import { filterEntries, mcpDocument, profileDocument, tokensShort } from "../addwizard.js";

describe("add wizard documents", () => {
  const ollama = PROVIDER_PRESETS.find((preset) => preset.id === "ollama")!;
  const hosted = PROVIDER_PRESETS.find((preset) => preset.id === "openai")!;

  it("builds a profile with the chosen models and their windows", () => {
    expect(JSON.parse(profileDocument(ollama, { baseUrl: " http://10.0.0.5:11434 ", keyEnv: "", models: [{ id: "a", contextWindow: 8192 }, { id: "b" }] }))).toEqual({
      apiFormat: "chat",
      baseUrl: "http://10.0.0.5:11434",
      models: [{ id: "a", contextWindow: 8192 }, { id: "b" }],
    });
  });

  it("stores only the key's variable name", () => {
    const doc = JSON.parse(profileDocument(hosted, { baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", models: [{ id: "m" }] }));
    expect(doc.apiKeyEnv).toBe("OPENAI_API_KEY");
    expect(doc.apiKey).toBeUndefined();
  });

  it("reads an MCP target as a command with arguments, or an address", () => {
    expect(JSON.parse(mcpDocument("npx -y @modelcontextprotocol/server-filesystem ."))).toEqual({ type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] });
    expect(JSON.parse(mcpDocument("uvx mcp-server-git"))).toEqual({ type: "stdio", command: "uvx", args: ["mcp-server-git"] });
    expect(JSON.parse(mcpDocument("https://example.com/mcp"))).toEqual({ type: "http", url: "https://example.com/mcp" });
  });
});

describe("filterEntries", () => {
  const entries = [{ id: "qwen3-coder:30b" }, { id: "llama3.1:8b" }, { id: "gemma3:27b" }];
  it("keeps entries matching every word, any case", () => {
    expect(filterEntries(entries, "").length).toBe(3);
    expect(filterEntries(entries, "LLAMA").map((entry) => entry.id)).toEqual(["llama3.1:8b"]);
    expect(filterEntries(entries, "3 coder").map((entry) => entry.id)).toEqual(["qwen3-coder:30b"]);
    expect(filterEntries(entries, "zzz")).toEqual([]);
  });
});

describe("tokensShort", () => {
  it("shortens window sizes", () => {
    expect(tokensShort(262_144)).toBe("256k");
    expect(tokensShort(131_072)).toBe("128k");
    expect(tokensShort(1_048_576)).toBe("1M");
  });
});

describe("mcpDocument with a key", () => {
  it("carries the key in env, and nothing when there is none", () => {
    expect(JSON.parse(mcpDocument("npx -y exa-mcp-server", { env: { EXA_API_KEY: "k" } }))).toEqual({ type: "stdio", command: "npx", args: ["-y", "exa-mcp-server"], env: { EXA_API_KEY: "k" } });
    expect(JSON.parse(mcpDocument("https://mcp.exa.ai/mcp", { headers: { "x-api-key": "k" } }))).toEqual({ type: "http", url: "https://mcp.exa.ai/mcp", headers: { "x-api-key": "k" } });
    expect(JSON.parse(mcpDocument("npx -y exa-mcp-server", { env: {} }))).toEqual({ type: "stdio", command: "npx", args: ["-y", "exa-mcp-server"] });
  });
});
