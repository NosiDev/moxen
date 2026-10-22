import { describe, expect, it } from "vitest";

import { normalizeConfig } from "../../../core/config.js";
import { describeSettings } from "../../../core/configschema.js";
import { TEXT_OPTION, itemRows, selectable } from "../listeditor.js";

const config = normalizeConfig({
  providers: { harness: { autoCompactTokens: 131072, profiles: [{ id: "p", baseUrl: "http://h", compaction: { keepRecentTokens: 33000 }, models: [{ id: "my-qwen3-tune" }] }] } },
});
const view = describeSettings(config).find((entry) => entry.descriptor.key === "providers.harness.profiles")!;
const kind = view.descriptor.kind as Extract<typeof view.descriptor.kind, { type: "list" }>;
const rows = itemRows(kind.fields, view.items![0]!);
const field = (path: string) => rows.find((row) => row.kind === "field" && row.path === path) as Extract<(typeof rows)[number], { kind: "field" }>;

describe("list editor rows", () => {
  it("shows an unset field's value in force and where it comes from, and an explicit one as its own", () => {
    expect(field("compaction.tokens")).toMatchObject({ shown: "128K", origin: "the Moxen Harness setting", explicit: false });
    expect(field("compaction.fraction")).toBeUndefined();
    expect(field("compaction.keepRecentTokens")).toMatchObject({ shown: "33,000", origin: null, explicit: true });
    // What applies unset is said on the row, from the schema, not in the description.
    expect(field("slots")).toMatchObject({ shown: "Default", origin: "the Moxen Harness's own Requests at once" });
    expect(field("loopGuard.repeatWarn")).toMatchObject({ shown: "4", origin: "the default" });
  });

  it("offers a way back to unset on every field, three ways on a boolean, and typing for a number outside the presets", () => {
    const options = (path: string) => (field(path).control as unknown as { options: Array<{ value: string }> }).options.map((option) => option.value);
    expect(options("titles")).toEqual(["", "true", "false"]);
    expect(options("slots")[0]).toBe("");
    expect(options("slots").at(-1)).toBe(TEXT_OPTION);
    expect(field("baseUrl").control.kind).toBe("text");
  });

  it("lists the models as rows to open, with an add row, and the family the name implies when none is set", () => {
    const child = rows.find((row) => row.kind === "child");
    expect(child).toMatchObject({ id: "my-qwen3-tune", summary: expect.stringContaining("qwen3") });
    expect(rows.some((row) => row.kind === "addChild" && row.noun === "model")).toBe(true);
    expect(rows.filter(selectable).every((row) => row.kind !== "heading" && row.kind !== "resolved")).toBe(true);
    const model = view.items![0]!.fields.find((entry) => entry.path === "models")!.items![0]!;
    const modelFields = (kind.fields.find((entry) => entry.path === "models")!.kind as { fields: typeof kind.fields }).fields;
    const modelRows = itemRows(modelFields, model);
    expect(modelRows.find((row) => row.kind === "field" && row.path === "family")).toMatchObject({ shown: "qwen3", origin: "the model's name" });
  });
});

describe("one control per behaviour", () => {
  it("offers neither older switch, says the quirk advice once under its heading, and names the profile's instructions", () => {
    expect(field("preserveThinking")).toBeUndefined();
    expect(field("quirks.images")).toBeUndefined();
    const heading = rows.find((row) => row.kind === "heading" && row.label === "Template quirks");
    expect(heading).toMatchObject({ description: expect.stringContaining("Most servers need none of these") });
    expect(field("quirks.omitToolChoice").description).not.toContain("Most servers need none");
    expect(field("systemPromptAppend").label).toBe("Profile instructions");
    expect(field("slots").label).toBe("Requests at once");
  });

  it("shows what the older switches still decide, on the controls that replaced them", () => {
    const older = normalizeConfig({ providers: { harness: { profiles: [{ id: "p", baseUrl: "http://h", preserveThinking: false, quirks: { images: "native" }, models: [{ id: "m" }] }] } } });
    const item = describeSettings(older).find((entry) => entry.descriptor.key === "providers.harness.profiles")!.items![0]!;
    const own = itemRows(kind.fields, item);
    expect(own.find((row) => row.kind === "field" && row.path === "quirks.reasoningReplay")).toMatchObject({ origin: "preserveThinking in the config file" });
    const modelFields = (kind.fields.find((entry) => entry.path === "models")!.kind as { fields: typeof kind.fields }).fields;
    const model = item.fields.find((entry) => entry.path === "models")!.items![0]!;
    expect(itemRows(modelFields, model).find((row) => row.kind === "field" && row.path === "vision")).toMatchObject({ shown: "On", origin: "quirks.images in the config file" });
  });
});

describe("fields that depend on another field of the same item", () => {
  const rowsFor = (profile: Record<string, unknown>) => {
    const settings = describeSettings(normalizeConfig({ providers: { harness: { profiles: [{ id: "p", baseUrl: "http://h", models: [{ id: "m" }], ...profile }] } } }));
    const list = settings.find((entry) => entry.descriptor.key === "providers.harness.profiles")!;
    const fields = (list.descriptor.kind as Extract<typeof list.descriptor.kind, { type: "list" }>).fields;
    return itemRows(fields, list.items![0]!).flatMap((row) => (row.kind === "field" ? [row.path] : []));
  };

  it("hides the loop-guard counts while their switch is off, and shows them while it is on or unset", () => {
    expect(rowsFor({})).toEqual(expect.arrayContaining(["loopGuard.repeatWarn", "loopGuard.repeatStop", "loopGuard.textRepeats"]));
    const off = rowsFor({ loopGuard: { calls: false, text: false } });
    expect(off).not.toContain("loopGuard.repeatWarn");
    expect(off).not.toContain("loopGuard.repeatStop");
    expect(off).not.toContain("loopGuard.textRepeats");
    expect(off).toContain("loopGuard.calls");
  });

  it("offers only the template quirks the profile's API format reads", () => {
    const chat = rowsFor({});
    expect(chat).toEqual(expect.arrayContaining(["quirks.systemRole", "quirks.reasoningField", "quirks.mergeAdjacentRoles"]));
    expect(chat).not.toContain("quirks.cacheControl");
    expect(chat).not.toContain("quirks.sendReasoning");
    const anthropic = rowsFor({ apiFormat: "anthropic" });
    expect(anthropic).toEqual(expect.arrayContaining(["quirks.cacheControl", "quirks.anthropicThinking", "quirks.reasoningReplay", "quirks.parallelToolCalls"]));
    expect(anthropic).not.toContain("quirks.systemRole");
    expect(rowsFor({ apiFormat: "responses" })).toContain("quirks.sendReasoning");
  });
});
