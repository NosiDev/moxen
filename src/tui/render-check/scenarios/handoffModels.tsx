import { act, useState } from "react";
import { testRender } from "@opentui/react/test-utils";

import { SettingsModal } from "../../features/settings/settingsmodal.js";
import type { ProviderSummary } from "../../../core/catalog/summary.js";
import { describeSettings } from "./settingsFixture.js";
import { normalizeConfig, setConfigValue } from "../../../core/config.js";
import { fail } from "../helpers.js";

/**
 * A provider's "Hand off at, per model" row opens a list of that provider's
 * models; enter on one opens a slider of sizes, and d takes the override away.
 * "Compact at, per model" is the same editor, saying compaction.
 */
export async function runHandoffModels(): Promise<void> {
  const model = (slug: string, name: string, isDefault: boolean, isHidden = false) => ({ slug, name, isCustom: false, isDefault, isHidden, efforts: [] });
  const providers: ProviderSummary[] = [
    {
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      displayName: "Claude",
      enabled: true,
      installed: true,
      status: null,
      authStatus: null,
      models: [model("claude-sonnet-5", "Claude Sonnet 5", false), model("claude-opus-5", "Claude Opus 5", true), model("claude-old", "Claude Old", false, true)],
      supportedRuntimeModes: null,
      usageLimits: null,
      skills: [],
    },
  ];
  const initial = normalizeConfig({ providers: { claude: { autoHandoffModels: { "claude-opus-5": 500_000, "gone-model": "300k" }, compactAtModels: { "claude-opus-5": 400_000 } } } });
  const written: Array<{ key: string; value: string }> = [];
  const Host = () => {
    const [config, setConfig] = useState(initial);
    return (
      <SettingsModal
        snapshot={{ path: "/home/dev/.moxen/config.json", exists: true, settings: describeSettings(config) }}
        loading={false}
        saving={null}
        error={null}
        onSet={(key, value) => {
          written.push({ key, value });
          setConfig((current) => setConfigValue(current, key as Parameters<typeof setConfigValue>[1], value));
          return Promise.resolve(true);
        }}
        onDuplicate={() => {}}
        run={null}
        onTest={() => {}}
        onTestMcp={() => {}}
        onProbe={() => {}}
        onDiscover={async () => ({ ok: false, host: null, message: "unused" })}
        onExport={() => {}}
        onImport={() => {}}
        notice={null}
        versions={null}
        latest={null}
        updating={new Set()}
        onUpdate={() => {}}
        providers={providers}
        screenWidth={100}
        screenHeight={60}
        left={2}
        top={1}
        width={96}
        height={58}
        onClose={() => {}}
      />
    );
  };
  const setup = await testRender(<Host />, { width: 100, height: 60, exitOnCtrlC: false });
  const settle = async () => {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
    await setup.flush();
  };
  await settle();

  const side = setup.captureCharFrame().split("\n");
  const claudeRow = side.findIndex((row) => row.includes("Claude Code") && row.includes("│"));
  await act(async () => setup.mockMouse.click(side[claudeRow]!.indexOf("Claude Code") + 1, claudeRow));
  await settle();
  // The row sits under "Long threads", below the fold: step down to it by its place on the page.
  const page = describeSettings(initial).filter((view) => view.descriptor.section === "provider:claude" && view.descriptor.hidden !== true)
    // A row another one switches off is not on the page to step over.
    .filter((view, _at, all) => {
      const when = view.descriptor.visibleWhen;
      return when === undefined || when.in.includes(String(all.find((other) => other.descriptor.key === when.key)?.value ?? ""));
    });
  const place = page.findIndex((view) => view.descriptor.key === "providers.claude.autoHandoffModels");
  if (place < 0) fail("Claude Code's page has no per-model hand-off setting");
  for (let step = 0; step < place; step += 1) await act(async () => setup.mockInput.pressArrow("down"));
  await settle();
  const shown = setup.captureCharFrame();
  if (!shown.split("\n").some((line) => line.includes("Hand off at, per model") && line.includes("2 models"))) fail("the 'Hand off at, per model' row does not count its 2 overrides");
  await act(async () => setup.mockInput.pressEnter());
  await settle();
  const list = setup.captureCharFrame();
  console.log("--- hand off per model ---");
  console.log(list);
  for (const expected of ["Claude Opus 5", "500K", "Claude Sonnet 5", "uses provider setting", "gone-model", "300K"]) {
    if (!list.includes(expected)) fail(`the per-model list is missing "${expected}"`);
  }
  if (list.includes("Claude Old")) fail("a hidden model is listed");

  // Sonnet is second (the default model leads): enter opens its slider, right moves, enter writes beside the other overrides.
  await act(async () => setup.mockInput.pressArrow("down"));
  await act(async () => setup.mockInput.pressEnter());
  await settle();
  const slider = setup.captureCharFrame();
  console.log("--- hand off slider ---");
  console.log(slider);
  for (const expected of ["Claude Sonnet 5", "16K", "128K", "256K", "750K", "1M", "◆", "Nothing chosen here"]) {
    if (!slider.includes(expected)) fail(`the size slider is missing "${expected}"`);
  }
  await act(async () => setup.mockInput.pressArrow("right"));
  await act(async () => setup.mockInput.pressEnter());
  await settle();
  const last = written.at(-1);
  if (last?.key !== "providers.claude.autoHandoffModels" || last.value !== "claude-opus-5=500000, gone-model=300000, claude-sonnet-5=256000") fail(`picking wrote ${JSON.stringify(last)}`);
  if (!setup.captureCharFrame().includes("256K")) fail("the list did not show the size just chosen");

  // d on a model with an override removes it.
  await act(async () => setup.mockInput.pressKey("d"));
  await settle();
  if (written.at(-1)?.value !== "claude-opus-5=500000, gone-model=300000") fail(`d wrote ${JSON.stringify(written.at(-1))}`);

  // Esc closes the editor and nothing else.
  await act(async () => setup.mockInput.pressEscape());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 120)));
  await setup.flush();
  const after = setup.captureCharFrame();
  if (!after.includes("Settings") || after.includes("← back") || after.includes("uses provider setting")) fail("esc did not leave only the editor for the settings page");

  // "Compact at, per model" sits above, under "Compact at": the same editor, with its own overrides and words.
  const compactPlace = page.findIndex((view) => view.descriptor.key === "providers.claude.compactAtModels");
  if (compactPlace < 0 || compactPlace > place) fail("Claude Code's page has no per-model compaction setting above the hand-off one");
  for (let step = compactPlace; step < place; step += 1) await act(async () => setup.mockInput.pressArrow("up"));
  await settle();
  if (!setup.captureCharFrame().split("\n").some((line) => line.includes("Compact at, per model") && line.includes("1 model"))) fail("the 'Compact at, per model' row does not count its override");
  await act(async () => setup.mockInput.pressEnter());
  await settle();
  const compactList = setup.captureCharFrame();
  console.log("--- compact per model ---");
  console.log(compactList);
  for (const expected of ["Claude Opus 5", "400K", "Claude Sonnet 5", "uses provider setting"]) {
    if (!compactList.includes(expected)) fail(`the per-model compaction list is missing "${expected}"`);
  }
  if (compactList.includes("gone-model")) fail("the compaction list shows the hand-off overrides");
  await act(async () => setup.mockInput.pressEnter());
  await settle();
  if (!setup.captureCharFrame().includes("compacted")) fail("the compaction slider does not say it compacts");
  setup.renderer.destroy();
}
