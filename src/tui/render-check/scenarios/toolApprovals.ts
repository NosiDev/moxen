import { act } from "react";
import type { TestRendererSetup } from "@opentui/core/testing";

import { fail } from "../helpers.js";
import { emitLiveRef, permissionRequestedFrame } from "../fixtures.js";

/** A tool approval arriving live: the inline panel names the command, takes
    the composer's slot, and a number key answers it. */
export async function runToolApprovals(setup: TestRendererSetup): Promise<void> {
  await act(async () => {
    emitLiveRef.current?.(permissionRequestedFrame("perm_live1"));
  });
  await setup.flush();
  console.log("--- tool approval (inline) ---");
  const panel = setup.captureCharFrame();
  console.log(panel);
  if (!panel.includes("Run shell command")) fail("the tool approval panel did not open");
  if (!panel.includes("bun run check")) fail("the tool approval panel does not show the command");
  if (!panel.includes("Do you want to proceed?")) fail("the tool approval panel has no question");

  // Answering hides the panel at once (the server's resolved row confirms).
  await act(async () => setup.mockInput.pressKey("1"));
  await new Promise((resolve) => setTimeout(resolve, 150));
  await setup.flush();
  console.log("--- tool approval (answered) ---");
  if (setup.captureCharFrame().includes("Do you want to proceed?")) fail("answering did not close the tool approval panel");
}
