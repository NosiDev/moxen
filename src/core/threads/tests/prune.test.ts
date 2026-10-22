import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ensureStoredProject } from "../../projects/projects.js";
import { pruneFinishedWorktrees } from "../prune.js";
import { provisionWorktree } from "../operations.js";
import { openThreadStore } from "../store.js";
import { archiveThread, createThread } from "../threads.js";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "moxen-prune-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
const DAY = 86_400_000;

/** A repository with an origin, a thread on its own `moxen/…` worktree branch, and the thread archived `agoDays` ago. */
async function finishedThread(name: string, options: { commit?: boolean; merge?: boolean; push?: boolean; agoDays: number }) {
  const origin = path.join(root, `${name}-origin.git`);
  const repo = path.join(root, `${name}-repo`);
  const store = path.join(root, `${name}-store`);
  mkdirSync(repo, { recursive: true });
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(path.join(repo, "a.txt"), "a");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "origin", "main");
  const wt = await provisionWorktree({ projectCwd: repo, baseBranch: "main", startFromOrigin: false, threadId: `${name}-thread`, storeRoot: store, name });
  if (options.commit) {
    writeFileSync(path.join(wt.path, "b.txt"), "b");
    git(wt.path, "add", ".");
    git(wt.path, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "work");
  }
  if (options.push) git(wt.path, "push", "-q", "origin", wt.branch);
  if (options.merge) git(repo, "merge", "-q", "--no-edit", wt.branch);
  const threads = await openThreadStore(store);
  const project = await ensureStoredProject(store, { workspaceRoot: repo });
  const created = await createThread(threads, {
    projectId: project.project.id,
    title: name,
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
    env: { mode: "worktree", path: wt.path, branch: wt.branch },
  });
  await archiveThread(threads, created.id);
  const archivedAt = new Date(Date.now() - options.agoDays * DAY).toISOString();
  const record = (await threads.readThreadRecord(created.id))!;
  await threads.writeThreadRecord({ ...record, archivedAt });
  return { repo, origin, store, threads, wt, branch: wt.branch };
}

const branchesOf = (repo: string) => git(repo, "branch", "--list", "moxen/*");
const remoteBranches = (origin: string) => git(origin, "branch", "--list", "moxen/*");

describe("pruning finished worktree threads", () => {
  it("deletes a merged branch, here and on origin, once the thread is old enough, and frees a leftover checkout", async () => {
    const t = await finishedThread("merged", { commit: true, push: true, merge: true, agoDays: 20 });
    expect(existsSync(t.wt.path)).toBe(true);
    const report = await pruneFinishedWorktrees({ store: t.threads, storeRoot: t.store, config: {} });
    expect(report.worktrees).toBe(1);
    expect(report.branches).toEqual([{ branch: t.branch, remote: true }]);
    expect(existsSync(t.wt.path)).toBe(false);
    expect(branchesOf(t.repo)).toBe("");
    expect(remoteBranches(t.origin)).toBe("");
  });

  it("keeps a branch that is too recent, or that was never merged", async () => {
    const recent = await finishedThread("recent", { commit: true, merge: true, agoDays: 2 });
    const unmerged = await finishedThread("unmerged", { commit: true, push: true, agoDays: 90 });
    await pruneFinishedWorktrees({ store: recent.threads, storeRoot: recent.store, config: {} });
    await pruneFinishedWorktrees({ store: unmerged.threads, storeRoot: unmerged.store, config: {} });
    // Their checkouts are freed either way; the branches stay.
    expect(existsSync(recent.wt.path)).toBe(false);
    expect(branchesOf(recent.repo)).toContain(recent.branch);
    expect(branchesOf(unmerged.repo)).toContain(unmerged.branch);
    expect(remoteBranches(unmerged.origin)).toContain(unmerged.branch);
  });

  it("deletes a branch with no commits of its own, and leaves origin alone when it was never pushed", async () => {
    const t = await finishedThread("empty", { agoDays: 30 });
    const report = await pruneFinishedWorktrees({ store: t.threads, storeRoot: t.store, config: {} });
    expect(report.branches).toEqual([{ branch: t.branch, remote: false }]);
    expect(branchesOf(t.repo)).toBe("");
  });

  it("keeps every branch when pruning is off (0 days), but still frees the checkout", async () => {
    const t = await finishedThread("off", { commit: true, merge: true, agoDays: 400 });
    const report = await pruneFinishedWorktrees({ store: t.threads, storeRoot: t.store, config: { branchPruneDays: 0 } });
    expect(report.branches).toEqual([]);
    expect(existsSync(t.wt.path)).toBe(false);
    expect(branchesOf(t.repo)).toContain(t.branch);
  });
});
