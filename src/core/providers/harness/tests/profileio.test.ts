import { describe, expect, it } from "vitest";

import { exportProfileDocument, freeProfileId, parseProfileDocument } from "../profileio.js";
import { normalizeHarnessConfig } from "../profiles.js";

const profile = normalizeHarnessConfig({
  profiles: [
    {
      id: "colab",
      label: "Colab",
      baseUrl: "https://example.trycloudflare.com",
      apiKeyEnv: "COLAB_KEY",
      apiKey: "keychain:harness-colab",
      models: [{ id: "qwen3.8-flash-next", efforts: ["low", "high"], probed: { at: "2026-10-14T10:00:00.000Z", quirks: { systemFirstOnly: true } } }],
    },
  ],
})!.profiles![0]!;

describe("harness profile export and import", () => {
  it("leaves the saved key and the probe results out of the document", () => {
    const text = JSON.stringify(exportProfileDocument(profile));
    expect(text).not.toContain("keychain");
    expect(text).not.toContain("probed");
    expect(text).toContain("COLAB_KEY");
    expect(text).toContain('"efforts":["low","high"]');
  });

  it("reads back what it wrote, and a bare profile object too", () => {
    const document = JSON.stringify(exportProfileDocument(profile));
    expect(parseProfileDocument(document)).toMatchObject({ id: "colab", baseUrl: "https://example.trycloudflare.com", apiKeyEnv: "COLAB_KEY" });
    expect(parseProfileDocument(JSON.stringify({ id: "x", baseUrl: "http://h", models: [{ id: "m" }] })).id).toBe("x");
  });

  it("ignores a key reference or probe block a hand-edited file carries", () => {
    const parsed = parseProfileDocument(JSON.stringify({ id: "x", baseUrl: "http://h", apiKey: "keychain:other", models: [{ id: "m", probed: { at: "2026-10-14T10:00:00.000Z", quirks: {} } }] }));
    expect(parsed.apiKey).toBeUndefined();
    expect(parsed.models[0]?.probed).toBeUndefined();
  });

  it("refuses what is not a profile, naming the problem", () => {
    expect(() => parseProfileDocument("nope")).toThrow(/not a JSON file/);
    expect(() => parseProfileDocument("[]")).toThrow(/one JSON object/);
    expect(() => parseProfileDocument(JSON.stringify({ kind: "something.else", profile: {} }))).toThrow(/not an exported harness profile/);
    expect(() => parseProfileDocument(JSON.stringify({ id: "x", baseUrl: "http://u:p@h", models: [{ id: "m" }] }))).toThrow(/without credentials/);
    expect(() => parseProfileDocument(JSON.stringify({ id: "x", baseUrl: "http://h", apiKeyEnv: "sk-abcdefghijklmnopqrstuvwxyz0123456789", models: [{ id: "m" }] }))).toThrow();
  });

  it("finds a free id when one is taken", () => {
    expect(freeProfileId("colab", new Set())).toBe("colab");
    expect(freeProfileId("colab", new Set(["colab", "colab-2"]))).toBe("colab-3");
  });
});
