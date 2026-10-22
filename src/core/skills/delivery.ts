/**
 * How Moxen's own skills reach a session: one rule, for every provider and client.
 *
 * `skills.moxen` (the project's `moxen.json`, else the config) says how they are delivered:
 *
 *   copy   into the project's `.claude/skills` or `.agents/skills` when it has one of those folders
 *          (`projectskills.ts`), which the providers read; served, as below, when it has neither
 *   serve  each provider is pointed at Moxen's own folder; nothing is written into the project, and
 *          copies Moxen made there earlier are taken out, so no skill loads twice
 *   off    no session gets them
 *
 * `providers.<kind>.moxenSkills` switches them off for one provider, or on for it (served) while the
 * global is off. A delegated task gets none, and a provider whose delegation tools are off does not
 * get the skills that drive them. How each provider is handed them (Claude Code's mod or its own
 * folder, OpenCode's `skills` config and permissions, the Harness's `skill` tool) is the driver's
 * business; which ones reach the session, and from where, is decided here.
 *
 * Older keys still load (the shared migration rule): `installSkills: false` reads as serve, and a
 * provider whose older switch was off while nothing was copied (`providers.claude.agentSkills`,
 * `providers.opencode.bundledSkills`) reads as off for that provider, which is what it got before.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { APP_NAME } from "../config.js";
import type { CliConfig } from "../types.js";
import { prepareProjectSkills, removeProjectSkills, type SkillsFolder } from "./projectskills.js";

export type SkillsDelivery = "copy" | "serve" | "off";
export const SKILLS_DELIVERIES: readonly SkillsDelivery[] = ["copy", "serve", "off"];

export type SkillsProviderKind = "claude" | "opencode" | "harness";

/** Moxen's skills that drive its delegation tools: a provider with those tools off is not given them. */
export const DELEGATION_SKILLS: readonly string[] = ["moxen-orchestrate", "moxen-research"];

/** What a value is, and the key it came from (null: the built-in default). */
export interface Sourced<T> {
  readonly value: T;
  readonly key: string | null;
}

const isDelivery = (value: unknown): value is SkillsDelivery => typeof value === "string" && (SKILLS_DELIVERIES as readonly string[]).includes(value);

/** The configured delivery: `skills.moxen`, else the older `installSkills` (off meant serve), else copy. */
export function skillsDeliveryOf(config: CliConfig): Sourced<SkillsDelivery> {
  const set = config.skills?.moxen;
  if (isDelivery(set)) return { value: set, key: "skills.moxen" };
  if (config.installSkills === false) return { value: "serve", key: "installSkills" };
  return { value: "copy", key: null };
}

/** `skills.moxen` from `<workspaceRoot>/moxen.json`, or null when it says nothing (or cannot be read). */
export async function projectSkillsDelivery(workspaceRoot: string | null): Promise<SkillsDelivery | null> {
  if (!workspaceRoot) return null;
  try {
    const raw = JSON.parse(await readFile(path.join(workspaceRoot, `${APP_NAME}.json`), "utf8")) as { skills?: { moxen?: unknown } } | null;
    const value = raw?.skills?.moxen;
    return isDelivery(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * One provider's own switch: true or false when it overrides the global delivery, null when it follows it.
 * Unset, an older switch that left the provider without Moxen's skills (it was off while they were served)
 * still does.
 */
export function providerSkillsOf(config: CliConfig, kind: SkillsProviderKind): Sourced<boolean | null> {
  const set = config.providers?.[kind]?.moxenSkills;
  if (set !== undefined) return { value: set, key: `providers.${kind}.moxenSkills` };
  const served = config.skills?.moxen === undefined && config.installSkills === false;
  if (served && kind === "claude" && config.providers?.claude?.agentSkills === false) return { value: false, key: "providers.claude.agentSkills" };
  if (served && kind === "opencode" && config.providers?.opencode?.bundledSkills === false) return { value: false, key: "providers.opencode.bundledSkills" };
  return { value: null, key: null };
}

/** What one provider gets, given the delivery in force and its own switch. */
export function providerDelivery(delivery: SkillsDelivery, own: boolean | null): SkillsDelivery {
  if (own === false) return "off";
  if (delivery === "off") return own === true ? "serve" : "off";
  return delivery;
}

/**
 * The names a skill answers to, for rules that hide it: its folder (OpenCode's id) and the name its
 * `SKILL.md` gives (what Claude Code and the Harness list), when that differs.
 */
export async function skillIds(bundledDir: string | null, folders: readonly string[]): Promise<string[]> {
  const ids = new Set<string>();
  for (const folder of folders) {
    ids.add(folder);
    if (bundledDir === null) continue;
    const text = await readFile(path.join(bundledDir, folder, "SKILL.md"), "utf8").catch(() => "");
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
    const name = /^name:[ \t]*["']?([\w.-]{1,64})["']?[ \t]*$/m.exec(front)?.[1];
    if (name) ids.add(name);
  }
  return [...ids].sort();
}

/** The skills Moxen ships, by folder. */
async function bundledFolders(bundledDir: string | null): Promise<string[]> {
  if (bundledDir === null) return [];
  const entries = await readdir(bundledDir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

/** What a session starts with (`ProviderSessionStartInput.moxenSkills` and the fields beside it). */
export interface SessionSkills {
  /** `project`: copied into `folder`, which the provider reads; `served`: from Moxen's folder; `none`: not given. */
  readonly mode: "project" | "served" | "none";
  /** Where the project's copies are, when it has them (also for `none`, which hides them). */
  readonly folder?: SkillsFolder;
  /** Moxen's skills this session must not offer although the project or Moxen's folder has them, by every name they answer to. */
  readonly hidden: readonly string[];
}

export interface ResolveSessionSkillsInput {
  readonly config: CliConfig;
  /** Null for an instance whose kind is not known: it follows the global delivery. */
  readonly kind: SkillsProviderKind | null;
  /** Where the project's `moxen.json` is. */
  readonly workspaceRoot: string | null;
  /** The thread's checkout, where copies go. Empty: nothing is copied. */
  readonly workingDirectory: string;
  readonly delegated: boolean;
  /** Whether this provider has Moxen's delegation tools (`moxenToolsOf`). */
  readonly orchestration: boolean;
  readonly bundledDir: string | null;
  readonly home?: string;
}

/**
 * Brings the checkout in line with the delivery in force (copies made, refreshed or taken out: they are
 * shared by every provider there, so only the project-wide delivery decides them), then says what this
 * session gets.
 */
export async function resolveSessionSkills(input: ResolveSessionSkillsInput): Promise<SessionSkills> {
  const delivery = (await projectSkillsDelivery(input.workspaceRoot)) ?? skillsDeliveryOf(input.config).value;
  const workingDirectory = input.workingDirectory.trim();
  let folder: SkillsFolder | null = null;
  let copied: readonly string[] = [];
  if (workingDirectory !== "" && input.bundledDir !== null) {
    if (delivery === "copy") {
      const prepared = await prepareProjectSkills({ workingDirectory, bundledDir: input.bundledDir, ...(input.home !== undefined ? { home: input.home } : {}) });
      folder = prepared.target;
      copied = prepared.managed;
    } else {
      await removeProjectSkills(workingDirectory);
    }
  }
  const own = input.kind === null ? delivery : providerDelivery(delivery, providerSkillsOf(input.config, input.kind).value);
  // Copies in the project are read by the provider itself, so a session that must not have them is told to hide them.
  if (input.delegated || own === "off") return { mode: "none", ...(folder !== null ? { folder } : {}), hidden: await skillIds(input.bundledDir, copied) };
  const shipped = await bundledFolders(input.bundledDir);
  const hidden = input.orchestration ? [] : await skillIds(input.bundledDir, DELEGATION_SKILLS.filter((name) => shipped.includes(name)));
  if (folder !== null) return { mode: "project", folder, hidden };
  return { mode: "served", hidden };
}

/** What a provider's tab says is in force, from the config alone (a project's `moxen.json` may say otherwise). */
export function describeProviderSkills(config: CliConfig, kind: SkillsProviderKind, orchestration: boolean): string {
  const delivery = skillsDeliveryOf(config).value;
  const own = providerSkillsOf(config, kind);
  const effective = providerDelivery(delivery, own.value);
  if (effective === "off") {
    const why =
      own.value === false
        ? own.key === `providers.${kind}.moxenSkills` ? "switched off for this provider" : `${own.key} is off in the config file`
        : "'Moxen's skills' on the Turns tab is Off";
    return `Off: ${why}.`;
  }
  const how =
    effective === "copy"
      ? "Copied into a project that has a .claude or .agents folder, served by Moxen from its own folder otherwise"
      : delivery === "off"
        ? "Served by Moxen from its own folder, for this provider only"
        : "Served by Moxen from its own folder";
  const less = orchestration ? "" : `, without ${DELEGATION_SKILLS.join(" and ")} (Delegation tools are off)`;
  return `${how}${less}. A project's moxen.json can choose otherwise.`;
}
