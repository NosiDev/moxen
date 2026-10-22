/**
 * Housekeeping for finished worktree threads. Every worktree thread leaves a
 * checkout (with its gitignored build output, often gigabytes) and a
 * `moxen/…` branch. Archiving frees the checkout at once; this catches the
 * ones that predate that, and deletes the branch once the thread has been
 * archived or deleted for a while — locally and, if it was pushed, on `origin`.
 *
 * Nothing unique is ever deleted: a branch goes only when it is already part
 * of the project's own branch, and its remote copy only when it points at the
 * very same commit. Every step is best effort; a failure leaves things as they
 * were.
 */
import { existsSync } from "node:fs";

import { runProcess } from "../infra/process.js";
import { listStoredProjects } from "../projects/projects.js";
import type { CliConfig } from "../types.js";
import { removeThreadWorktree } from "./operations.js";
import type { ThreadStore } from "./store.js";

/** Days after archiving before a merged branch goes, unless configured. */
export const DEFAULT_BRANCH_PRUNE_DAYS = 14;

export interface PruneReport {
  /** Worktree checkouts removed from disk. */
  readonly worktrees: number;
  /** Branches deleted, and whether the copy on origin went too. */
  readonly branches: ReadonlyArray<{ readonly branch: string; readonly remote: boolean }>;
}

async function git(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    return (await runProcess("git", [...args], { cwd, timeoutMs: 30_000 })).stdout.trim();
  } catch {
    return null;
  }
}

/** The branches work lands on: origin's default, then `main` / `master`; the checked-out one only when the repository has none of those. */
async function mergeTargets(repo: string): Promise<string[]> {
  const targets: string[] = [];
  const originHead = await git(repo, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead) targets.push(originHead);
  for (const name of ["main", "master"]) {
    if ((await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])) !== null) targets.push(name);
  }
  return targets.length > 0 ? targets : ["HEAD"];
}

async function isMerged(repo: string, branch: string, targets: readonly string[]): Promise<boolean> {
  for (const target of targets) {
    if ((await git(repo, ["merge-base", "--is-ancestor", branch, target])) !== null) return true;
  }
  return false;
}

export async function pruneFinishedWorktrees(
  input: { readonly store: ThreadStore; readonly storeRoot: string; readonly config: Pick<CliConfig, "branchPruneDays"> },
  now: number = Date.now(),
): Promise<PruneReport> {
  const days = input.config.branchPruneDays ?? DEFAULT_BRANCH_PRUNE_DAYS;
  const projects = await listStoredProjects(input.storeRoot).catch(() => []);
  let worktrees = 0;
  const branches: Array<{ branch: string; remote: boolean }> = [];
  for (const threadId of await input.store.listThreadIds().catch(() => [] as string[])) {
    const thread = await input.store.readThreadRecord(threadId).catch(() => null);
    const finishedAt = thread?.deletedAt ?? thread?.archivedAt ?? null;
    if (!thread || thread.env.mode !== "worktree" || finishedAt === null) continue;
    if (existsSync(thread.env.path) && (await removeThreadWorktree(input.storeRoot, thread))) worktrees += 1;
    const branch = thread.env.branch;
    if (days === 0 || !branch?.startsWith("moxen/") || existsSync(thread.env.path)) continue;
    if (now - Date.parse(finishedAt) < days * 86_400_000) continue;
    const repo = projects.find((project) => project.id === thread.projectId)?.workspaceRoot;
    if (!repo || !existsSync(repo)) continue;
    const tip = await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (tip === null) continue;
    if (!(await isMerged(repo, branch, await mergeTargets(repo)))) continue;
    // The copy on origin, if the branch was ever pushed: only when it is the same commit.
    let remote = false;
    if ((await git(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`])) === tip) {
      remote = (await git(repo, ["push", "origin", "--delete", branch])) !== null;
    }
    if ((await git(repo, ["branch", "-D", branch])) !== null) branches.push({ branch, remote });
  }
  return { worktrees, branches };
}
