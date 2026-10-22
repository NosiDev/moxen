import { describe, expect, it } from "vitest";

import { resolveModelSelection } from "../../../core/catalog/selection.js";
import type { ProviderSummary } from "../../../core/catalog/summary.js";
import { normalizeConfig } from "../../../core/config.js";
import { describeSettings } from "../../../core/configschema.js";
import type { ModelSelection } from "../../../core/types.js";
import { configuredDefaultModel, settingControl } from "../settings.js";

/**
 * One rule for which model a new thread gets, checked from both ends: what
 * the server resolves a new thread to (`resolveModelSelection`, which
 * `handover`, `threads create` and `thread.create` call), and what the TUI
 * marks as the default in its picker (`configuredDefaultModel`). A row is a
 * config, the project's stored default, and where the thread must land.
 */
const INSTALL: ModelSelection = { instanceId: "claudeAgent", model: "claude-install-default" };

const MATRIX: ReadonlyArray<{ name: string; config: Record<string, unknown>; project?: ModelSelection; expected: ModelSelection }> = [
  { name: "nothing set: the installation default", config: {}, expected: INSTALL },
  { name: "a global Model with no Provider is ignored", config: { model: "gpt-6" }, expected: INSTALL },
  { name: "a global Model with its Provider", config: { provider: "codex", model: "gpt-6" }, expected: { instanceId: "codex", model: "gpt-6" } },
  { name: "the global Provider is another instance of the same driver", config: { provider: "opencode/work", model: "openai/gpt-6" }, expected: { instanceId: "opencode/work", model: "openai/gpt-6" } },
  { name: "the provider tab's Model wins over the global one", config: { provider: "claudeAgent", model: "claude-global", providers: { claude: { model: "claude-tab" } } }, expected: { instanceId: "claudeAgent", model: "claude-tab" } },
  { name: "the provider tab's Model with no global Provider", config: { providers: { claude: { model: "claude-tab" } } }, expected: { instanceId: "claudeAgent", model: "claude-tab" } },
  { name: "another provider's tab does not reach this one", config: { providers: { opencode: { model: "openai/gpt-6" } } }, expected: INSTALL },
  { name: "the project's default beats the global Provider", config: { provider: "claudeAgent", model: "claude-global" }, project: { instanceId: "opencode", model: "openai/gpt-6" }, expected: { instanceId: "opencode", model: "openai/gpt-6" } },
  { name: "the project's model beats the provider tab's", config: { providers: { claude: { model: "claude-tab" } } }, project: { instanceId: "claudeAgent", model: "claude-project" }, expected: { instanceId: "claudeAgent", model: "claude-project" } },
];

describe("which model a new thread gets", () => {
  for (const row of MATRIX) {
    it(row.name, () => {
      const config = normalizeConfig(row.config);
      const resolved = resolveModelSelection(row.project ?? null, config, { prompt: "" }, () => INSTALL);
      expect({ instanceId: resolved.instanceId, model: resolved.model }).toEqual(row.expected);
      // The picker marks the same model: the settings' choice, or (when they name none) the project's or the catalog's.
      const marked = configuredDefaultModel(describeSettings(config), resolved.instanceId);
      const fromSettings = row.project?.instanceId === resolved.instanceId ? row.project.model : (marked ?? (resolved.instanceId === INSTALL.instanceId ? INSTALL.model : undefined));
      expect(fromSettings).toBe(resolved.model);
    });
  }

  it("asks for a model rather than guess one for a provider that has none set", () => {
    expect(() => resolveModelSelection(null, normalizeConfig({ provider: "opencode" }), { prompt: "" }, () => INSTALL)).toThrow(/No model is set/);
  });

  it("does not need the installation default when the settings name a provider and a model", () => {
    const missing = () => {
      throw new Error("Claude Code is not installed");
    };
    expect(resolveModelSelection(null, normalizeConfig({ provider: "codex", model: "gpt-6" }), { prompt: "" }, missing)).toMatchObject({ instanceId: "codex", model: "gpt-6" });
  });
});

describe("the page says when a model setting does not fit", () => {
  const catalog: ProviderSummary[] = [
    {
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      displayName: "Claude Code",
      enabled: true,
      installed: true,
      status: null,
      authStatus: null,
      models: [{ slug: "claude-opus-5-5", name: "Claude Opus 5.5", isCustom: false, isDefault: true, isHidden: false, efforts: [] }],
      supportedRuntimeModes: null,
      usageLimits: null,
      skills: [],
    },
  ];

  it("greys out the global Model while no Provider is set, naming the value it ignores", () => {
    const view = describeSettings(normalizeConfig({ model: "gpt-6" })).find((entry) => entry.descriptor.key === "model")!;
    expect(view.unavailable).toMatch(/Ignored: gpt-6 applies only once Provider/);
    expect(describeSettings(normalizeConfig({ provider: "claudeAgent", model: "gpt-6" })).find((entry) => entry.descriptor.key === "model")!.unavailable).toBeUndefined();
  });

  it("warns when the stored model is not one the provider lists", () => {
    const settings = describeSettings(normalizeConfig({ provider: "claudeAgent", model: "gpt-6" }));
    const view = settings.find((entry) => entry.descriptor.key === "model")!;
    const control = settingControl(view.descriptor, view.value, settings, catalog);
    expect(control.kind === "pick" && control.warning).toMatch(/gpt-6 is not a model Claude Code lists/);
    const fits = describeSettings(normalizeConfig({ provider: "claudeAgent", model: "claude-opus-5-5" }));
    const fine = settingControl(view.descriptor, "claude-opus-5-5", fits, catalog);
    expect(fine.kind === "pick" && fine.warning).toBeUndefined();
  });

  it("names the global Model on a provider's tab when it reaches that provider", () => {
    const effective = (config: Record<string, unknown>) => describeSettings(normalizeConfig(config)).find((entry) => entry.descriptor.key === "providers.claude.model")!.effective;
    expect(effective({ provider: "claudeAgent", model: "claude-global" })).toMatchObject({ value: "claude-global", origin: "from 'Model' on the New threads tab" });
    expect(effective({ model: "claude-global" })).toBeUndefined();
  });

  it("no longer offers the automatic thread environment, and reads an old one as the checkout", () => {
    const settings = describeSettings(normalizeConfig({ threadEnvMode: "auto" }));
    const view = settings.find((entry) => entry.descriptor.key === "threadEnvMode")!;
    expect(view.value).toBe("local");
    const control = settingControl(view.descriptor, view.value, settings, null);
    expect(control.kind === "pick" && control.options.map((entry) => entry.value)).toEqual(["local", "worktree"]);
  });
});
