import { describe, expect, it } from "vitest";

import { effortTones, nearestStop, sliderLayout, stopTones } from "../slider.js";
import { sliderChoices } from "../listeditor.js";
import { compactFromConfig, handoffOverridesFromConfig, resolveCompact, resolveHandoff } from "../autohandoff.js";

describe("sliderLayout", () => {
  it("puts the first label flush left, the last flush right and the rest by position", () => {
    const layout = sliderLayout(["low", "medium", "high", "xhigh", "max"], 60);
    expect(layout.starts[0]).toBe(0);
    expect(layout.starts[4]! + 3).toBe(60);
    expect(layout.fits).toBe(true);
    expect(layout.markers[1]).toBe(layout.starts[1]! + 3);
  });

  it("says when the labels do not fit, so the caller can list them", () => {
    expect(sliderLayout(["30 seconds", "1 minute", "2 minutes", "5 minutes", "10 minutes"], 40).fits).toBe(false);
  });

  it("packs crowded labels instead of giving up, so a narrow pane still gets a slider", () => {
    const labels = ["30s", "1m", "2m", "5m", "10m", "30m", "1h"];
    const layout = sliderLayout(labels, 40);
    expect(layout.fits).toBe(true);
    expect(layout.starts[0]).toBe(0);
    expect(layout.starts[6]! + 2).toBe(40);
    const tight = sliderLayout(["30 seconds", "1 minute", "2 minutes", "5 minutes", "10 minutes", "30 minutes", "1 hour"], 68);
    expect(tight.fits).toBe(true);
    expect(sliderLayout(["30 seconds", "1 minute", "2 minutes", "5 minutes", "10 minutes", "30 minutes", "1 hour"], 67).fits).toBe(false);
  });

  it("finds the stop nearest a click", () => {
    const layout = sliderLayout(["a", "b", "c"], 21);
    expect(nearestStop(layout, 0)).toBe(0);
    expect(nearestStop(layout, 11)).toBe(1);
    expect(nearestStop(layout, 40)).toBe(2);
  });
});

describe("sliderChoices", () => {
  const options = [
    { value: "", label: "Default" },
    { value: "3", label: "3" },
    { value: "4", label: "4" },
    { value: "5", label: "5" },
    { value: "\u0000text", label: "Another value…" },
  ];
  it("takes numbers as stops and keeps the default and typing as actions beside them", () => {
    const slider = sliderChoices(options, 40);
    expect(slider?.stops.map((option) => option.value)).toEqual(["3", "4", "5"]);
    expect(slider?.reset?.label).toBe("Default");
    expect(slider?.custom?.label).toBe("Another value…");
  });
  it("leaves words to a list", () => {
    expect(sliderChoices([{ value: "", label: "Default" }, { value: "a", label: "Adaptive" }, { value: "b", label: "Budget" }], 40)).toBeNull();
  });
});

describe("resolveHandoff", () => {
  it("takes the provider's own tokens, then the global ones, then falls back to the share", () => {
    const overrides = handoffOverridesFromConfig({ opencode: { autoHandoff: "auto", autoHandoffTokens: 131_072 } });
    expect(resolveHandoff({ autoHandoff: "off", autoHandoffTokens: 65_536 }, overrides, "opencode/opencode")).toEqual({ mode: "auto", percent: 50, tokens: 131_072 });
    expect(resolveHandoff({ autoHandoff: "off", autoHandoffTokens: 65_536 }, overrides, "claudeAgent")).toEqual({ mode: "off", percent: 50, tokens: 65_536 });
    expect(resolveHandoff({ autoHandoffPercent: 70 }, {}, "claudeAgent")).toEqual({ mode: "ask", percent: 70, tokens: null });
    expect(resolveHandoff(undefined, {}, "claudeAgent")).toEqual({ mode: "ask", percent: 50, tokens: null });
  });

  it("goes model tokens, provider tokens, provider share, global tokens, global share, half", () => {
    const overrides = handoffOverridesFromConfig({
      claude: { autoHandoffModels: { "claude-opus": 500_000 }, autoHandoffTokens: 100_000 },
      opencode: { autoHandoffPercent: 75 },
    });
    const ui = { autoHandoffTokens: 65_536, autoHandoffPercent: 25 };
    expect(resolveHandoff(ui, overrides, "claudeAgent", "claude-opus").tokens).toBe(500_000);
    expect(resolveHandoff(ui, overrides, "claudeAgent", "claude-haiku").tokens).toBe(100_000);
    // A provider's share beats the global tokens: the line is a share of the window, not the global count.
    expect(resolveHandoff(ui, overrides, "opencode/opencode", "gpt")).toEqual({ mode: "ask", percent: 75, tokens: null });
    expect(resolveHandoff(ui, {}, "claudeAgent", "claude-opus")).toEqual({ mode: "ask", percent: 25, tokens: 65_536 });
    expect(resolveHandoff({ autoHandoffPercent: 25 }, {}, "claudeAgent", "x")).toEqual({ mode: "ask", percent: 25, tokens: null });
  });
});

describe("effortTones", () => {
  it("colours the named levels cool to hot, each its own", () => {
    const tones = effortTones(["low", "medium", "high", "xhigh", "max"]);
    expect(new Set(tones).size).toBe(5);
    expect(effortTones(["max", "low"])).toEqual([tones[4], tones[0]]);
  });
  it("spreads unnamed levels along the same ramp by position", () => {
    const tones = effortTones(["a", "b", "c"]);
    expect(tones).toHaveLength(3);
    expect(new Set(tones).size).toBe(3);
  });
});

describe("stopTones", () => {
  it("gives every stop its own colour along one ramp", () => {
    for (const count of [2, 5, 7]) {
      const tones = stopTones(count);
      expect(tones).toHaveLength(count);
      expect(new Set(tones).size).toBe(count);
      expect(tones.every((tone) => /^#[0-9a-f]{6}$/.test(tone))).toBe(true);
    }
  });
});

describe("resolveCompact", () => {
  it("is Moxen's job on Claude Code threads only, asking at 80% unless set", () => {
    expect(resolveCompact(undefined, "claudeAgent")).toEqual({ mode: "ask", percent: 80 });
    expect(resolveCompact({ mode: "auto", percent: 65 }, "claudeAgent")).toEqual({ mode: "auto", percent: 65 });
    expect(resolveCompact(compactFromConfig({ claude: { autoCompact: "auto", autoCompactPercent: 70 } }), "claudeAgent")).toEqual({ mode: "auto", percent: 70 });
  });

  it("leaves it to Claude Code when asked to, and to other providers' own compaction", () => {
    expect(resolveCompact({ mode: "claude" }, "claudeAgent")).toBeNull();
    expect(resolveCompact(undefined, "opencode/opencode")).toBeNull();
    expect(resolveCompact(undefined, undefined)).toBeNull();
  });
});
