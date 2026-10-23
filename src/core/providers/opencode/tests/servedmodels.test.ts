import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { tempDir } from "../../../testing/tmp.js";
import { freeModelsDisabled, freeTierModels, loadServedModels, MODELS_DEV_CACHE_TTL_MS, OPENCODE_SERVED_MODELS_URL } from "../catalog.js";

const LIST = JSON.stringify({ object: "list", data: [{ id: "big-pickle", object: "model" }, { id: "claude-opus-4-6", object: "model" }] });

function fetchStub(answer: () => Response): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return answer();
  }) as typeof fetch;
  return { fetchImpl, urls };
}

describe("the models OpenCode serves", () => {
  it("fetches OpenCode's list and caches it; a fresh cache is read without asking again", async () => {
    const cachePath = path.join(tempDir("moxen-served-"), "served.json");
    const live = fetchStub(() => new Response(LIST));
    const first = await loadServedModels({ cachePath, fetchImpl: live.fetchImpl });
    expect(first).toEqual({ ids: new Set(["big-pickle", "claude-opus-4-6"]), source: "live" });
    expect(live.urls).toEqual([OPENCODE_SERVED_MODELS_URL]);
    const again = await loadServedModels({ cachePath, fetchImpl: live.fetchImpl });
    expect(again.source).toBe("cache");
    expect(live.urls).toHaveLength(1);
  });

  it("offline: an out-of-date cache is used and marked stale; with none, nothing is known", async () => {
    const dir = tempDir("moxen-served-");
    const cachePath = path.join(dir, "served.json");
    const offline = fetchStub(() => {
      throw new Error("offline");
    });
    expect(await loadServedModels({ cachePath, fetchImpl: offline.fetchImpl })).toEqual({ ids: null, source: "none" });
    fs.writeFileSync(cachePath, LIST);
    const later = Date.now() + MODELS_DEV_CACHE_TTL_MS * 2;
    expect(await loadServedModels({ cachePath, fetchImpl: offline.fetchImpl, now: () => later })).toEqual({ ids: new Set(["big-pickle", "claude-opus-4-6"]), source: "stale" });
  });

  it("a refusal or an answer that is not a model list never overwrites the cache", async () => {
    const cachePath = path.join(tempDir("moxen-served-"), "served.json");
    fs.writeFileSync(cachePath, LIST);
    const later = Date.now() + MODELS_DEV_CACHE_TTL_MS * 2;
    await loadServedModels({ cachePath, fetchImpl: fetchStub(() => new Response("<html>", { status: 200 })).fetchImpl, now: () => later });
    await loadServedModels({ cachePath, fetchImpl: fetchStub(() => new Response("no", { status: 503 })).fetchImpl, now: () => later });
    expect(fs.readFileSync(cachePath, "utf8")).toBe(LIST);
  });

  it("the free tier is zero-cost and served; models.dev alone when the list is unknown", () => {
    const model = (id: string, input: number) => ({ id, name: id, reasoningOptions: [], cost: { input, output: input } });
    const models = [model("big-pickle", 0), model("kimi-k2.5-free", 0), model("claude-opus-4-6", 5)];
    expect(freeTierModels(models, new Set(["big-pickle", "claude-opus-4-6"])).map((entry) => entry.id)).toEqual(["big-pickle"]);
    expect(freeTierModels(models, null).map((entry) => entry.id)).toEqual(["big-pickle", "kimi-k2.5-free"]);
  });

  it("reads OPENCODE_DISABLE_FREE_MODELS as OpenCode does: 1 or true", () => {
    expect(freeModelsDisabled({ OPENCODE_DISABLE_FREE_MODELS: "1" })).toBe(true);
    expect(freeModelsDisabled({ OPENCODE_DISABLE_FREE_MODELS: "TRUE" })).toBe(true);
    expect(freeModelsDisabled({ OPENCODE_DISABLE_FREE_MODELS: "0" })).toBe(false);
    expect(freeModelsDisabled({})).toBe(false);
  });
});
