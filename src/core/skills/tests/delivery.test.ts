import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { describeSettings } from "../../configschema.js";
import { normalizeConfig } from "../../config.js";
import type { CliConfig } from "../../types.js";
import { describeProviderSkills, projectSkillsDelivery, providerDelivery, providerSkillsOf, resolveSessionSkills, skillIds, skillsDeliveryOf, type SkillsProviderKind } from "../delivery.js";

/** A config as the file would load it. */
const c = (raw: Record<string, unknown>): CliConfig => normalizeConfig(raw);

/** What each provider gets from a config, as the session rule sees it before any project. */
const delivered = (raw: Record<string, unknown>, kind: SkillsProviderKind) => {
  const config = c(raw);
  return providerDelivery(skillsDeliveryOf(config).value, providerSkillsOf(config, kind).value);
};

describe("older configs load to the delivery they had", () => {
  it("reads nothing set as copy, everywhere", () => {
    for (const kind of ["claude", "opencode", "harness"] as const) expect(delivered({}, kind)).toBe("copy");
  });

  it("reads installSkills off as serve", () => {
    expect(skillsDeliveryOf(c({ installSkills: false }))).toEqual({ value: "serve", key: "installSkills" });
    for (const kind of ["claude", "opencode", "harness"] as const) expect(delivered({ installSkills: false }, kind)).toBe("serve");
  });

  it("keeps a provider whose older switch was off while skills were served without them, and only then", () => {
    const both = { installSkills: false, providers: { claude: { agentSkills: false }, opencode: { bundledSkills: false } } };
    expect(delivered(both, "claude")).toBe("off");
    expect(delivered(both, "opencode")).toBe("off");
    // The Harness never had a switch: it was always served.
    expect(delivered(both, "harness")).toBe("serve");
    // With copying on, those switches never kept the copies away: nothing changes.
    const copying = { providers: { claude: { agentSkills: false }, opencode: { bundledSkills: false } } };
    expect(delivered(copying, "claude")).toBe("copy");
    expect(delivered(copying, "opencode")).toBe("copy");
  });

  it("lets the new keys win once set", () => {
    const config = { installSkills: false, skills: { moxen: "copy" }, providers: { claude: { agentSkills: false, moxenSkills: true } } };
    expect(skillsDeliveryOf(c(config)).value).toBe("copy");
    expect(delivered(config, "claude")).toBe("copy");
    // A provider switched on while the global is off is served.
    expect(delivered({ skills: { moxen: "off" }, providers: { harness: { moxenSkills: true } } }, "harness")).toBe("serve");
    expect(delivered({ skills: { moxen: "off" } }, "harness")).toBe("off");
  });

  it("accepts the keys in a file and rejects a delivery it does not know", () => {
    expect(normalizeConfig({ skills: { moxen: "serve" }, providers: { opencode: { moxenSkills: false } } })).toMatchObject({ skills: { moxen: "serve" }, providers: { opencode: { moxenSkills: false } } });
    expect(() => normalizeConfig({ skills: { moxen: "sometimes" } })).toThrow();
  });
});

describe("what a provider's tab says is in force", () => {
  it("names the delivery, the provider-only case and the delegation skills left out", () => {
    expect(describeProviderSkills(c({}), "claude", true)).toMatch(/^Copied into a project that has a \.claude or \.agents folder/);
    expect(describeProviderSkills(c({ skills: { moxen: "serve" } }), "claude", true)).toMatch(/^Served by Moxen from its own folder\./);
    expect(describeProviderSkills(c({ skills: { moxen: "off" }, providers: { claude: { moxenSkills: true } } }), "claude", true)).toMatch(/for this provider only/);
    expect(describeProviderSkills(c({}), "opencode", false)).toContain("without moxen-orchestrate and moxen-research (Delegation tools are off)");
  });

  it("says why it is off", () => {
    expect(describeProviderSkills(c({ skills: { moxen: "off" } }), "harness", true)).toBe("Off: the global 'Moxen's skills' is Off.");
    expect(describeProviderSkills(c({ providers: { opencode: { moxenSkills: false } } }), "opencode", true)).toBe("Off: switched off for this provider.");
    expect(describeProviderSkills(c({ installSkills: false, providers: { claude: { agentSkills: false } } }), "claude", true)).toBe("Off: providers.claude.agentSkills is off in the config file.");
  });

  it("is on each provider's row of the settings view, and the Default names where it comes from", () => {
    const views = describeSettings(c({ installSkills: false, providers: { opencode: { orchestration: false } } }));
    const row = views.find((view) => view.descriptor.key === "providers.opencode.moxenSkills")!;
    expect(row.inForce).toMatch(/^In force: Served by Moxen from its own folder, without moxen-orchestrate/);
    expect(row.effective).toMatchObject({ value: true, label: "On" });
    const global = views.find((view) => view.descriptor.key === "skills.moxen")!;
    expect(global.effective).toEqual({ value: "serve", label: "Serve from Moxen", origin: "from installSkills in the config file" });
    // Retired keys stay readable but off the page.
    for (const key of ["installSkills", "providers.opencode.bundledSkills"]) expect(views.find((view) => view.descriptor.key === key)?.descriptor.hidden).toBe(true);
  });
});

describe("a session's skills", () => {
  let root: string;
  let bundled: string;
  let work: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "moxen-delivery-"));
    bundled = path.join(root, "bundled");
    work = path.join(root, "work");
    for (const [folder, name] of [["moxen-threads", "moxen-threads"], ["moxen-orchestrate", "moxen-orchestrate"], ["moxen-research", "moxen-research"], ["use-moxen-cli", "use-moxen"]]) {
      await mkdir(path.join(bundled, folder!), { recursive: true });
      await writeFile(path.join(bundled, folder!, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\nbody\n`);
    }
    await mkdir(work, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const resolve = (raw: Record<string, unknown>, extra: { kind?: SkillsProviderKind; delegated?: boolean; orchestration?: boolean } = {}) =>
    resolveSessionSkills({ config: c(raw), kind: extra.kind ?? "claude", workspaceRoot: work, workingDirectory: work, delegated: extra.delegated ?? false, orchestration: extra.orchestration ?? true, bundledDir: bundled, home: path.join(root, "home") });

  it("answers to a skill's folder and to the name its SKILL.md gives", async () => {
    expect(await skillIds(bundled, ["use-moxen-cli", "moxen-threads"])).toEqual(["moxen-threads", "use-moxen", "use-moxen-cli"]);
  });

  it("reads skills.moxen from the project's moxen.json, over the config", async () => {
    expect(await projectSkillsDelivery(work)).toBeNull();
    await writeFile(path.join(work, "moxen.json"), JSON.stringify({ skills: { moxen: "off" } }));
    expect(await projectSkillsDelivery(work)).toBe("off");
    expect(await resolve({})).toEqual({ mode: "none", hidden: [] });
  });

  it("copies into the project, and hides every copy from a delegated task or a provider switched off", async () => {
    await mkdir(path.join(work, ".agents"));
    expect(await resolve({})).toEqual({ mode: "project", folder: ".agents", hidden: [] });
    const all = ["moxen-orchestrate", "moxen-research", "moxen-threads", "use-moxen", "use-moxen-cli"];
    expect(await resolve({}, { delegated: true })).toEqual({ mode: "none", folder: ".agents", hidden: all });
    expect(await resolve({ providers: { claude: { moxenSkills: false } } })).toEqual({ mode: "none", folder: ".agents", hidden: all });
  });

  it("serves with the delegation skills hidden when the provider has no delegation tools", async () => {
    expect(await resolve({ skills: { moxen: "serve" } }, { orchestration: false })).toEqual({ mode: "served", hidden: ["moxen-orchestrate", "moxen-research"] });
  });
});
