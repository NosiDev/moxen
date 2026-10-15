import { act } from "react";
import { testRender } from "@opentui/react/test-utils";

import { SettingsModal } from "../../features/settings/settingsmodal.js";
import { describeSettings } from "./settingsFixture.js";
import { normalizeConfig } from "../../../core/config.js";
import { fail } from "../helpers.js";

/**
 * The Moxen Harness tab: the profile list, one profile, one of its models.
 * Rendered from the real schema and `describeSettings`, so what a profile's
 * fields are called, which value is in force and where it comes from are the
 * server's words, not this file's.
 */
export async function runHarnessProfiles(): Promise<void> {
  const written: Array<{ key: string; value: string }> = [];
  const probed: string[] = [];
  const config = normalizeConfig({
    providers: {
      harness: {
        autoCompactPercent: 80,
        profiles: [
          {
            id: "colab",
            label: "Colab Qwen",
            baseUrl: "https://example.trycloudflare.com",
            apiKeyEnv: "RENDER_CHECK_UNSET_KEY",
            slots: 1,
            compaction: { fraction: 0.5 },
            models: [{ id: "qwen3.8-flash-next", probed: { at: "2026-10-14T10:00:00.000Z", quirks: { systemFirstOnly: true }, contextWindow: 262144 } }],
          },
        ],
      },
    },
  });
  const snapshot = { path: "/home/dev/.config/moxen/config.json", exists: true, settings: describeSettings(config) };
  const setup = await testRender(
    <SettingsModal
      snapshot={snapshot}
      loading={false}
      saving={null}
      error={null}
      onSet={(key, value) => written.push({ key, value })}
      onDuplicate={() => {}}
      run={null}
      onTest={() => {}}
      onTestMcp={() => {}}
      onProbe={(id, model) => probed.push(`${id}/${model}`)}
      onExport={() => {}}
      onImport={() => {}}
      notice={null}
      versions={null}
      latest={null}
      updating={new Set()}
      onUpdate={() => {}}
      providers={[]}
      screenWidth={100}
      screenHeight={46}
      left={2}
      top={1}
      width={96}
      height={44}
      onClose={() => {}}
    />,
    { width: 100, height: 46, exitOnCtrlC: false },
  );
  await setup.flush();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
  await setup.flush();

  // The tab is second to last (MCP servers follow it): shift-tab from the first section twice.
  for (let step = 0; step < 2; step += 1) await act(async () => setup.mockInput.pressTab({ shift: true }));
  await setup.flush();
  const tab = setup.captureCharFrame();
  console.log("--- harness tab ---");
  console.log(tab);
  for (const expected of ["Moxen Harness", "New threads", "Permissions"]) {
    if (!tab.includes(expected)) fail(`harness tab is missing "${expected}"`);
  }
  if (tab.includes("next start")) fail("the harness settings still say they need a restart, but the driver reads them on every turn");

  // The page is long: walk down it, seeing every heading, and stop on the
  // last row (Profiles), which the cursor clamps to.
  const seen: string[] = [];
  for (let step = 0; step < 24; step += 1) {
    await act(async () => setup.mockInput.pressArrow("down"));
    await setup.flush();
    seen.push(setup.captureCharFrame());
  }
  for (const expected of ["Tools", "Concurrency", "Compaction", "Compact at", "Web", "Model servers", "1 profile"]) {
    if (!seen.some((frame) => frame.includes(expected))) fail(`harness tab never shows "${expected}"`);
  }
  await act(async () => setup.mockInput.pressEnter());
  await setup.flush();
  const list = setup.captureCharFrame();
  console.log("--- harness profiles ---");
  console.log(list);
  for (const expected of ["Colab Qwen", "RENDER_CHECK_UNSET_KEY is not set", "+ Add profile"]) {
    if (!list.includes(expected)) fail(`the profile list is missing "${expected}"`);
  }

  await act(async () => setup.mockInput.pressEnter());
  await setup.flush();
  const profile = setup.captureCharFrame();
  console.log("--- harness profile ---");
  console.log(profile);
  for (const expected of ["Base URL", "API key variable", "Which API the server speaks"]) {
    if (!profile.includes(expected)) fail(`the profile editor is missing "${expected}"`);
  }
  // The key's value is never a thing this screen can show: only the variable's name is a field.
  if (/sk-|Bearer/.test(profile)) fail("the profile editor shows something key-shaped");

  // The back button is clickable and goes up one level, not out of the editor.
  const backRows = profile.split("\n");
  const backRow = backRows.findIndex((row) => row.includes("← Profiles"));
  if (backRow < 0) fail("the profile editor has no back button naming where it goes");
  await act(async () => setup.mockMouse.click(backRows[backRow]!.indexOf("←") + 2, backRow));
  await setup.flush();
  if (!setup.captureCharFrame().includes("+ Add profile")) fail("clicking back did not return to the profile list");
  await act(async () => setup.mockInput.pressEnter());
  await setup.flush();

  // Compaction: the profile's own share is shown; the global percent is not what is in force here.
  const frames: string[] = [];
  for (let step = 0; step < 40; step += 1) {
    await act(async () => setup.mockInput.pressArrow("down"));
    await setup.flush();
    frames.push(setup.captureCharFrame());
  }
  for (const expected of ["qwen3.8-flash-next", "+ Add model"]) {
    if (!frames.some((frame) => frame.includes(expected))) fail(`the profile editor never shows "${expected}"`);
  }
  if (!frames.some((frame) => frame.includes("Compact at (share of window)") && frame.includes("0.5"))) fail("the profile's own compaction share is not shown");

  // Back up to the model and open it: family from the name, the probed window, the probe's finding.
  for (let step = 0; step < 45; step += 1) await act(async () => setup.mockInput.pressArrow("up"));
  // Name, format, address, key, key variable and slots come before the model.
  for (let step = 0; step < 6; step += 1) await act(async () => setup.mockInput.pressArrow("down"));
  await act(async () => setup.mockInput.pressEnter());
  await setup.flush();
  const modelFrame = setup.captureCharFrame();
  console.log("--- harness model ---");
  console.log(modelFrame);
  for (const expected of ["Model family", "qwen3", "the model's name", "262,144", "from a probe", "systemFirstOnly", "probe"]) {
    if (!modelFrame.includes(expected)) fail(`the model editor is missing "${expected}"`);
  }

  // The probe asks before it runs, and says what it does to a one-slot server.
  await act(async () => setup.mockInput.pressKey("p"));
  await setup.flush();
  const warn = setup.captureCharFrame();
  console.log(warn);
  if (!warn.includes("tiny requests") || !warn.includes("one-slot") || probed.length !== 0) fail("p did not ask for confirmation before probing");
  await act(async () => setup.mockInput.pressKey("p"));
  await setup.flush();
  if (probed[0] !== "colab/qwen3.8-flash-next") fail(`the confirmed probe ran for ${JSON.stringify(probed)}`);
  if (written.length !== 0) fail(`looking around wrote config: ${JSON.stringify(written)}`);
  setup.renderer.destroy();
}
