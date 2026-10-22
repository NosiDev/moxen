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
    expect(field("slots")).toMatchObject({ shown: "Default", origin: null });
  });

  it("offers a way back to unset on every field, three ways on a boolean, and typing for a number outside the presets", () => {
    const options = (path: string) => (field(path).control as unknown as { options: Array<{ value: string }> }).options.map((option) => option.value);
    expect(options("preserveThinking")).toEqual(["", "true", "false"]);
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
