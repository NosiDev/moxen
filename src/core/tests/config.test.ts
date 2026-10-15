import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, normalizeConfig, setConfigValue } from "../config.js";

describe("config", () => {
  it("applies documented defaults", () => {
    expect(normalizeConfig({})).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG).toMatchObject({ runtimeMode: "full-access" });
    expect(DEFAULT_CONFIG).not.toHaveProperty("provider");
    expect(DEFAULT_CONFIG).not.toHaveProperty("model");
    expect(DEFAULT_CONFIG).not.toHaveProperty("speedMode");
    expect(DEFAULT_CONFIG).not.toHaveProperty("thinkingEffort");
  });

  it("validates project and workspace policy", () => {
    expect(setConfigValue(DEFAULT_CONFIG, "projectPolicy", "existing").projectPolicy).toBe("existing");
    expect(setConfigValue(DEFAULT_CONFIG, "workspaceMode", "folder").workspaceMode).toBe("folder");
    expect(() => setConfigValue(DEFAULT_CONFIG, "projectPolicy", "sometimes")).toThrow(
      "projectPolicy must be one of: create, existing.",
    );
  });

  it("normalizes model selection overrides", () => {
    const config = normalizeConfig({
      provider: " claudeAgent ",
      model: " claude-sonnet-4-6 ",
      speedMode: "standard",
      thinkingEffort: " high ",
    });

    expect(config).toMatchObject({
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      speedMode: "standard",
      thinkingEffort: "high",
    });
    expect(() => normalizeConfig({ speedMode: "turbo" })).toThrow("speedMode must be standard or fast");
  });

  it("keeps the harness compaction defaults through the config file, with or without profiles", () => {
    expect(normalizeConfig({ providers: { harness: { autoCompact: false, autoCompactPercent: 80, keepRecentTokens: 9000 } } }).providers?.harness).toEqual({
      autoCompact: false,
      autoCompactPercent: 80,
      keepRecentTokens: 9000,
    });
    expect(() => normalizeConfig({ providers: { harness: { autoCompact: "sometimes" } } })).toThrow(/autoCompact/);
  });

  it("keeps the harness web settings, and refuses a search backend it does not have", () => {
    const web = { webSearch: "exa", webSearchKeyEnv: "EXA_API_KEY", searxngUrl: "http://localhost:8888", webBrowser: "off", webBrowserPath: "/usr/bin/chromium", webPrivateNetwork: true };
    expect(normalizeConfig({ providers: { harness: web } }).providers?.harness).toEqual(web);
    expect(() => normalizeConfig({ providers: { harness: { webSearch: "bing" } } })).toThrow(/webSearch must be one of/);
    expect(() => normalizeConfig({ providers: { harness: { webBrowser: "always" } } })).toThrow(/webBrowser/);
  });
});
