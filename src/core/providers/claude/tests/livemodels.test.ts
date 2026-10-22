import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { bundledClaudeModels } from "../catalog.js";
import { liveModelsFile, parseSdkModels, resolveLiveModels } from "../livemodels.js";

const LEVELS = ["low", "medium", "high", "xhigh", "max"];
const SDK = [
  { value: "default", resolvedModel: "claude-sonnet-5-5", displayName: "Default (recommended)", description: "", supportsEffort: true, supportedEffortLevels: LEVELS },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "", supportsEffort: true, supportedEffortLevels: LEVELS },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "" },
  { value: "claude-opus-5", resolvedModel: "claude-opus-5", displayName: "Opus 5", description: "", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
  { value: "weird", resolvedModel: "claude-weird", displayName: "Weird", supportsEffort: true, supportedEffortLevels: ["low", "bogus"] },
];

describe("parseSdkModels", () => {
  it("lists each model once under its resolved id", () => {
    const models = parseSdkModels(SDK, bundledClaudeModels());
    expect(models.map((model) => model.slug)).toEqual(["claude-sonnet-5-5", "claude-haiku-4-5-20251001", "claude-opus-5", "claude-weird"]);
  });

  it("takes effort levels from the SDK, none when unsupported, and drops unknown levels", () => {
    const models = parseSdkModels(SDK, bundledClaudeModels());
    const levels = (slug: string) => models.find((model) => model.slug === slug)?.efforts[0]?.choices.map((choice) => choice.id);
    expect(levels("claude-sonnet-5-5")).toEqual(LEVELS);
    expect(levels("claude-opus-5")).toEqual(["low", "high"]);
    expect(levels("claude-haiku-4-5-20251001")).toBeUndefined();
    expect(levels("claude-weird")).toEqual(["low"]);
  });

  it("keeps bundled names and default levels for known models, names the rest from the SDK", () => {
    const models = parseSdkModels(SDK, bundledClaudeModels());
    expect(models.find((model) => model.slug === "claude-haiku-4-5-20251001")?.name).toBe("Claude Haiku 4.5");
    const opus = models.find((model) => model.slug === "claude-opus-5");
    expect(opus?.efforts[0]?.choices.find((choice) => choice.isDefault === true)?.id).toBe("high");
  });

  it("yields nothing for a malformed answer", () => {
    expect(parseSdkModels(null)).toEqual([]);
    expect(parseSdkModels([{ nope: 1 }, 3])).toEqual([]);
  });
});

describe("resolveLiveModels", () => {
  const store = () => mkdtempSync(path.join(tmpdir(), "moxen-live-models-"));

  it("returns null with no cache and no fetch, so the bundled list stands", async () => {
    expect(await resolveLiveModels({ storeRoot: store() })).toBeNull();
  });

  it("fetches when nothing is cached and caches the answer", async () => {
    const root = store();
    let calls = 0;
    const fetch = async () => { calls += 1; return SDK; };
    const first = await resolveLiveModels({ storeRoot: root, fetch, now: 1000 });
    expect(first?.length).toBe(4);
    const second = await resolveLiveModels({ storeRoot: root, fetch, now: 2000 });
    expect(second?.length).toBe(4);
    expect(calls).toBe(1);
  });

  it("asks again when the cache is stale, and keeps the stale answer if that fails", async () => {
    const root = store();
    writeFileSync(liveModelsFile(root), JSON.stringify({ fetchedAt: 0, models: SDK }));
    const stale = await resolveLiveModels({ storeRoot: root, fetch: async () => null, now: 10 ** 12 });
    expect(stale?.length).toBe(4);
    const fresh = await resolveLiveModels({ storeRoot: root, fetch: async () => SDK.slice(2, 4), now: 10 ** 12 });
    expect(fresh?.map((model) => model.slug)).toEqual(["claude-haiku-4-5-20251001", "claude-opus-5"]);
  });
});
