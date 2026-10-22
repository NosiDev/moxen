import { describe, expect, it } from "vitest";

import { normalizeConfig } from "../../config.js";
import { describeSettings, parseSettingValue, readSetting, settingDescriptor, writeSetting } from "../../configschema.js";
import { autoCompactThreshold } from "../../providers/harness/compactsettings.js";
import { resolveCompactionSettings } from "../../providers/harness/profiles.js";
import type { CliConfig, HarnessProfileConfig } from "../../types.js";
import {
  compactionModeFor,
  compactLineFor,
  driverProviders,
  handoffLineFor,
  handoffModeFor,
  lineText,
  longThreadPolicy,
  parseLine,
  planLongThreadAction,
  type LongThreadSnapshot,
} from "../longthreads.js";

type Config = Pick<CliConfig, "ui" | "providers" | "longThreads">;

const snapshot = (over: Partial<LongThreadSnapshot> = {}): LongThreadSnapshot => ({
  instanceId: "claudeAgent",
  model: "claude-opus-5",
  usedTokens: 120_000,
  maxTokens: 200_000,
  hasReply: true,
  turnRunning: false,
  runningSubthreads: 0,
  runningBackgroundTasks: 0,
  queuedMessages: 0,
  delegated: false,
  lastWasCompact: false,
  usedSinceCompact: null,
  continued: false,
  ...over,
});

describe("a line", () => {
  it("is a share or a size, in powers of two, and reads back as it is written", () => {
    expect(parseLine("70%")).toEqual({ percent: 70 });
    expect(parseLine("32K")).toEqual({ tokens: 32_768 });
    expect(parseLine("32k")).toEqual({ tokens: 32_768 });
    expect(parseLine("1M")).toEqual({ tokens: 1_048_576 });
    expect(parseLine(100_000)).toEqual({ tokens: 100_000 });
    expect(parseLine("100000")).toEqual({ tokens: 100_000 });
    for (const text of ["70%", "32K", "1M", "100000"]) expect(lineText(parseLine(text)!)).toBe(text);
  });

  it("refuses what no window could use", () => {
    for (const bad of ["5%", "99%", "70.5%", "2K", "3M", "soon", "", 1_000]) expect(parseLine(bad)).toBeNull();
  });
});

describe("an older config", () => {
  // The fixtures the old resolver was tested with (`resolveHandoff`, before MXN-99): the same lines must come out.
  it("hands off where it did: model, provider size, provider share, global size, global share, half", () => {
    const config: Config = {
      ui: { autoHandoffTokens: 65_536, autoHandoffPercent: 25 },
      providers: { claude: { autoHandoffModels: { "claude-opus": 500_000 }, autoHandoffTokens: 100_000 }, opencode: { autoHandoffPercent: 75 } },
    };
    expect(handoffLineFor(config, "claude", "claude-opus").value).toEqual({ tokens: 500_000 });
    expect(handoffLineFor(config, "claude", "claude-haiku").value).toEqual({ tokens: 100_000 });
    // A provider's share beats the global size.
    expect(handoffLineFor(config, "opencode", "gpt").value).toEqual({ percent: 75 });
    expect(handoffLineFor({ ui: { autoHandoffTokens: 65_536, autoHandoffPercent: 25 } }, "claude").value).toEqual({ tokens: 65_536 });
    expect(handoffLineFor({ ui: { autoHandoffPercent: 25 } }, "claude").value).toEqual({ percent: 25 });
    expect(handoffLineFor({}, "claude").value).toEqual({ percent: 50 });
  });

  it("keeps each provider's hand-off mode over the global one", () => {
    const config: Config = { ui: { autoHandoff: "off" }, providers: { opencode: { autoHandoff: "auto" } } };
    expect(handoffModeFor(config, "opencode")).toEqual({ value: "auto", key: "providers.opencode.autoHandoff" });
    expect(handoffModeFor(config, "claude")).toEqual({ value: "off", key: "ui.autoHandoff" });
    expect(handoffModeFor({}, "claude")).toEqual({ value: "ask", key: null });
  });

  it("compacts as its old switches said", () => {
    expect(compactionModeFor({ providers: { claude: { autoCompact: "claude" } } }, "claude").value).toBe("provider");
    expect(compactionModeFor({ providers: { claude: { autoCompact: "auto" } } }, "claude").value).toBe("auto");
    expect(compactionModeFor({}, "claude").value).toBe("ask");
    expect(compactionModeFor({ providers: { opencode: { autoCompact: false } } }, "opencode").value).toBe("off");
    expect(compactionModeFor({ providers: { opencode: { autoCompact: true } } }, "opencode").value).toBe("provider");
    expect(compactionModeFor({}, "opencode").value).toBe("provider");
    expect(compactionModeFor({ providers: { harness: { autoCompact: false } } }, "harness").value).toBe("off");
    expect(compactionModeFor({}, "harness").value).toBe("auto");
  });

  it("compacts a Claude Code thread at its old share, and passes Claude Code its old window", () => {
    expect(longThreadPolicy({ providers: { claude: { autoCompact: "auto", autoCompactPercent: 70 } } }, "claudeAgent").compact).toEqual({ mode: "auto", line: { percent: 70 } });
    expect(longThreadPolicy({}, "claudeAgent").compact).toEqual({ mode: "ask", line: { percent: 80 } });
    const own = driverProviders({ providers: { claude: { autoCompact: "claude", autoCompactWindow: 400_000 } } });
    expect(own?.claude).toMatchObject({ autoCompact: "claude", autoCompactWindow: 400_000 });
    // While Moxen compacts, the window means nothing to Claude Code: it is not sent.
    expect(driverProviders({ providers: { claude: { autoCompact: "ask", autoCompactWindow: 400_000 } } })?.claude?.autoCompactWindow).toBeUndefined();
  });

  it("leaves OpenCode's own switch where it was", () => {
    expect(driverProviders({})?.opencode?.autoCompact).toBeUndefined();
    expect(driverProviders({ providers: { opencode: { autoCompact: true } } })?.opencode?.autoCompact).toBe(true);
    expect(driverProviders({ providers: { opencode: { autoCompact: false } } })?.opencode?.autoCompact).toBe(false);
  });

  it("loads from the file with every old key still there, and a bare token count read as a line", () => {
    const loaded = normalizeConfig({
      ui: { autoHandoff: "auto", autoHandoffPercent: 40 },
      providers: { claude: { autoCompact: "claude", autoCompactWindow: 300_000 }, harness: { autoCompactTokens: 24_576 } },
      longThreads: { compactAt: 65_536, handoffAt: "60%" },
    });
    expect(loaded.ui).toMatchObject({ autoHandoff: "auto", autoHandoffPercent: 40 });
    expect(loaded.providers?.claude).toMatchObject({ autoCompact: "claude", autoCompactWindow: 300_000 });
    expect(loaded.longThreads).toEqual({ compactAt: "64K", handoffAt: "60%" });
    // The global line is newer than the older global keys beside it.
    expect(handoffLineFor(loaded, "claude").value).toEqual({ percent: 60 });
    expect(handoffModeFor(loaded, "claude").value).toBe("auto");
  });
});

describe("precedence", () => {
  // Specificity only: model, provider, global, built-in, whatever unit each level is written in.
  const cases: ReadonlyArray<{ name: string; config: Config; model?: string; line: unknown }> = [
    { name: "built-in", config: {}, line: { percent: 50 } },
    { name: "global share", config: { longThreads: { handoffAt: "40%" } }, line: { percent: 40 } },
    { name: "global size", config: { longThreads: { handoffAt: "64K" } }, line: { tokens: 65_536 } },
    { name: "provider share over global size", config: { longThreads: { handoffAt: "64K" }, providers: { claude: { handoffAt: "70%" } } }, line: { percent: 70 } },
    { name: "provider size over global share", config: { longThreads: { handoffAt: "40%" }, providers: { claude: { handoffAt: "128K" } } }, line: { tokens: 131_072 } },
    { name: "older provider share over global size", config: { longThreads: { handoffAt: "64K" }, providers: { claude: { autoHandoffPercent: 30 } } }, line: { percent: 30 } },
    { name: "provider over older provider", config: { providers: { claude: { handoffAt: "70%", autoHandoffTokens: 100_000 } } }, line: { percent: 70 } },
    { name: "model over provider share", config: { providers: { claude: { handoffAt: "70%", autoHandoffModels: { m: 300_000 } } } }, model: "m", line: { tokens: 300_000 } },
    { name: "another model follows the provider", config: { providers: { claude: { handoffAt: "70%", autoHandoffModels: { m: 300_000 } } } }, model: "n", line: { percent: 70 } },
  ];
  it.each(cases)("hand off at: $name", ({ config, model, line }) => {
    expect(handoffLineFor(config, "claude", model).value).toEqual(line);
  });

  it("compact at goes provider, global, 80%; the Harness keeps its own rule when nothing is set", () => {
    expect(compactLineFor({}, "claude")?.value).toEqual({ percent: 80 });
    expect(compactLineFor({ longThreads: { compactAt: "32K" } }, "claude")?.value).toEqual({ tokens: 32_768 });
    expect(compactLineFor({ longThreads: { compactAt: "32K" }, providers: { claude: { compactAt: "60%" } } }, "claude")?.value).toEqual({ percent: 60 });
    expect(compactLineFor({}, "harness")).toBeNull();
    expect(compactLineFor({ longThreads: { compactAt: "24K" } }, "harness")?.value).toEqual({ tokens: 24_576 });
    expect(compactLineFor({ longThreads: { compactAt: "24K" }, providers: { harness: { autoCompactPercent: 50 } } }, "harness")).toEqual({ value: { percent: 50 }, key: "providers.harness.autoCompactPercent" });
    // The provider's own compaction draws its own line; off has none.
    expect(compactLineFor({ longThreads: { compactAt: "60%" }, providers: { opencode: { compaction: "provider" } } }, "opencode")).toBeNull();
    expect(compactLineFor({ providers: { claude: { compaction: "off", compactAt: "60%" } } }, "claude")).toBeNull();
  });
});

describe("the Harness", () => {
  const profile: HarnessProfileConfig = { id: "local", baseUrl: "http://localhost:1234/v1", models: [{ id: "m", contextWindow: 32_768 }] } as HarnessProfileConfig;

  it("lets a 32K model compact at a share or a size from the global line", () => {
    const share = resolveCompactionSettings(driverProviders({ longThreads: { compactAt: "60%" } })?.harness, profile);
    // 60% is 19,660 tokens, but 16K always stays free under the line.
    expect(autoCompactThreshold(32_768, share)).toBe(16_768);
    const size = resolveCompactionSettings(driverProviders({ longThreads: { compactAt: "24K" } })?.harness, profile);
    expect(autoCompactThreshold(32_768, size)).toBe(24_576);
  });

  it("puts a profile's own line first, then the tab's, whatever their units", () => {
    const tab = driverProviders({ providers: { harness: { compactAt: "16K" } } })?.harness;
    expect(resolveCompactionSettings(tab, { ...profile, compaction: { fraction: 0.5 } })).toMatchObject({ fraction: 0.5, tokens: null });
    expect(resolveCompactionSettings(tab, profile)).toMatchObject({ fraction: null, tokens: 16_384 });
    expect(resolveCompactionSettings(driverProviders({ providers: { harness: { compaction: "off" } } })?.harness, profile).auto).toBe(false);
  });
});

describe("hand-off and compaction together", () => {
  const both = (handoffAt: string, compactAt: string, handoff: "ask" | "auto" = "auto"): Config => ({
    providers: { claude: { compaction: "auto", compactAt, handoff, handoffAt } },
  });

  it("compacts first when compaction's line is lower, even with hand-off on Automatic", () => {
    expect(planLongThreadAction(both("80%", "60%"), snapshot({ usedTokens: 170_000 }))).toEqual({ kind: "compact", reason: "auto" });
  });

  it("hands off first when hand-off's line is lower", () => {
    expect(planLongThreadAction(both("60%", "80%"), snapshot({ usedTokens: 170_000 }))).toEqual({ kind: "handoff" });
  });

  it("hands off when a compaction did not bring the thread back below its line", () => {
    expect(planLongThreadAction(both("80%", "60%"), snapshot({ usedTokens: 170_000, lastWasCompact: true }))).toEqual({ kind: "handoff" });
  });

  it("compares a share and a size in tokens", () => {
    // 64K is below 50% of a 200K window, so compaction goes first.
    expect(planLongThreadAction(both("50%", "64K"), snapshot({ usedTokens: 110_000 }))).toEqual({ kind: "compact", reason: "auto" });
  });

  it("compacts an OpenCode thread too once Moxen does it", () => {
    const config: Config = { providers: { opencode: { compaction: "auto" } } };
    expect(planLongThreadAction(config, snapshot({ instanceId: "opencode/anthropic", usedTokens: 161_000 }))).toEqual({ kind: "compact", reason: "auto" });
    expect(driverProviders(config)?.opencode?.autoCompact).toBe(false);
  });
});

describe("the settings page", () => {
  const view = (config: CliConfig, key: string) => describeSettings(config).find((entry) => entry.descriptor.key === key)!;

  it("shows the same five rows on every provider tab, and hides the older keys", () => {
    for (const kind of ["claude", "opencode", "harness"] as const) {
      const rows = describeSettings(normalizeConfig({}))
        .filter((entry) => entry.descriptor.section === `provider:${kind}` && entry.descriptor.group === "Long threads" && entry.descriptor.hidden !== true)
        .map((entry) => entry.descriptor.label);
      expect(rows).toEqual(["Compaction", "Compact at", ...(kind === "harness" ? ["Kept word for word"] : []), "Hand off", "Hand off at", "Hand off at, per model"]);
    }
  });

  it("names what applies, and where it comes from", () => {
    const config = normalizeConfig({ ui: { autoHandoffTokens: 65_536 }, providers: { claude: { autoCompact: "claude" } } });
    expect(view(config, "providers.claude.handoffAt").effective).toEqual({ value: "64K", label: "64K tokens", origin: "from ui.autoHandoffTokens in the config file" });
    expect(view(config, "providers.claude.compaction").effective).toMatchObject({ value: "provider", label: "Claude Code" });
    expect(view(config, "providers.claude.compactAt").effective?.label).toBe("Claude Code's own, tuned per model");
    expect(view(normalizeConfig({ longThreads: { handoffAt: "40%" } }), "providers.opencode.handoffAt").effective).toEqual({ value: "40%", label: "40% of the window", origin: "from 'Hand off at' on the Long threads tab" });
  });

  it("takes an older key through `config set` and writes the one that replaced it too", () => {
    let config = normalizeConfig({});
    config = writeSetting(config, "providers.claude.autoCompactPercent", 70);
    expect(readSetting(config, "providers.claude.autoCompactPercent")).toBe(70);
    expect(readSetting(config, "providers.claude.compactAt")).toBe("70%");
    config = writeSetting(config, "providers.claude.autoCompact", "claude");
    expect(readSetting(config, "providers.claude.compaction")).toBe("provider");
    config = writeSetting(config, "ui.autoHandoffTokens", 131_072);
    expect(readSetting(config, "longThreads.handoffAt")).toBe("128K");
    // Clearing the older key clears the newer one it wrote, while that still says the same.
    config = writeSetting(config, "providers.claude.autoCompactPercent", "");
    expect(readSetting(config, "providers.claude.compactAt")).toBeUndefined();
  });

  it("refuses a line no window could use", () => {
    const descriptor = settingDescriptor("longThreads.compactAt")!;
    for (const bad of ["5%", "2K", "soon"]) expect(() => parseSettingValue(descriptor, bad)).toThrow(/share of the window/);
    expect(parseSettingValue(descriptor, "24k")).toBe("24K");
  });
});
