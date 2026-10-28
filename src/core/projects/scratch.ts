/**
 * Threads without a project. A thread started with no folder runs in its
 * own directory under `<storeRoot>/scratch/<threadId>/` (the store, not the
 * OS temp dir, so a restart can resume it) and belongs to one shared
 * `scratch` project titled "No project". To everything below the registry
 * it is an ordinary local project, so drivers, checkpoints and the wire
 * need no special case.
 */
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { ensureStoredProject, workspaceRootsEqual, type StoredProject } from "./projects.js";

export const SCRATCH_PROJECT_TITLE = "No project";

export function scratchRoot(storeRoot: string): string {
  return path.join(storeRoot, "scratch");
}

export function scratchDirFor(storeRoot: string, threadId: string): string {
  return path.join(scratchRoot(storeRoot), threadId);
}

/** Whether `candidate` is a thread directory directly under the scratch root. */
export function isScratchDir(storeRoot: string, candidate: string): boolean {
  const root = path.resolve(scratchRoot(storeRoot));
  const resolved = path.resolve(candidate);
  return path.dirname(resolved) === root && !workspaceRootsEqual(resolved, root);
}

/** The shared scratch project, created on first use. */
export async function ensureScratchProject(storeRoot: string): Promise<StoredProject> {
  const root = scratchRoot(storeRoot);
  await mkdir(root, { recursive: true });
  const { project } = await ensureStoredProject(storeRoot, {
    workspaceRoot: root,
    title: SCRATCH_PROJECT_TITLE,
    scratch: true,
  });
  return project;
}

/** A new, empty directory for `threadId`. */
export async function createScratchDir(storeRoot: string, threadId: string): Promise<string> {
  const dir = scratchDirFor(storeRoot, threadId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Remove a thread's scratch directory; anything outside the scratch root is left alone. */
export async function removeScratchDir(storeRoot: string, dir: string): Promise<boolean> {
  if (!isScratchDir(storeRoot, dir)) return false;
  await rm(dir, { recursive: true, force: true });
  return true;
}
