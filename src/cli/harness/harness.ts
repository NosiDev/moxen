import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ListItemView } from "../../core/configschema.js";
import { CliError } from "../../core/errors.js";
import type { CliConfig } from "../../core/types.js";
import { cliClient } from "../infra/client.js";

/** What a harness command needs: the launch config for routing, and the file its edits go to and are read back from. */
export interface HarnessContext {
  readonly config: CliConfig;
  readonly configPath: string;
}

/** The setting that holds the profiles; every edit below is a `settings.set` on a key into it. */
const PROFILES = "providers.harness.profiles";

const keyFor = (id: string, field?: string): string => `${PROFILES}[${id}]${field ? `.${field}` : ""}`;

async function profileItems(ctx: HarnessContext): Promise<{ path: string; items: readonly ListItemView[] }> {
  const snapshot = await (await cliClient(ctx.config, undefined, ctx.configPath)).query({ type: "settings.read" });
  const view = snapshot.settings.find((entry) => entry.descriptor.key === PROFILES);
  return { path: snapshot.path, items: view?.items ?? [] };
}

function fieldValue(item: ListItemView, path: string): string | number | boolean | null {
  return item.fields.find((field) => field.path === path)?.value ?? null;
}

function brief(item: ListItemView) {
  const models = item.fields.find((field) => field.path === "models")?.items ?? [];
  return {
    id: item.id,
    label: item.title,
    baseUrl: fieldValue(item, "baseUrl"),
    apiKeyEnv: fieldValue(item, "apiKeyEnv"),
    models: models.map((model) => model.id),
    status: item.status,
  };
}

export async function listProfiles(ctx: HarnessContext) {
  const { path, items } = await profileItems(ctx);
  return { path, profiles: items.map(brief) };
}

export async function showProfile(ctx: HarnessContext, id: string) {
  const { items } = await profileItems(ctx);
  const item = items.find((entry) => entry.id === id.toLowerCase());
  if (!item) throw new CliError("PROVIDER_UNKNOWN", `No harness profile "${id}".`);
  return { profile: item };
}

async function setKey(ctx: HarnessContext, key: string, value: string) {
  return await (await cliClient(ctx.config, undefined, ctx.configPath)).dispatch({ type: "settings.set", key, value });
}

export async function addProfile(
  ctx: HarnessContext,
  options: { id: string; baseUrl: string; label?: string; apiKeyEnv?: string; apiFormat?: string; models: readonly string[]; slots?: number },
) {
  const { items } = await profileItems(ctx);
  if (items.some((entry) => entry.id === options.id.toLowerCase())) {
    throw new CliError("INVALID_CONFIG", `A harness profile "${options.id}" already exists. Use \`harness profile edit\`.`);
  }
  const item = {
    baseUrl: options.baseUrl,
    ...(options.apiFormat ? { apiFormat: options.apiFormat } : {}),
    ...(options.label ? { label: options.label } : {}),
    ...(options.apiKeyEnv ? { apiKeyEnv: options.apiKeyEnv } : {}),
    ...(options.slots !== undefined ? { slots: options.slots } : {}),
    models: options.models.map((id) => ({ id })),
  };
  await setKey(ctx, keyFor(options.id), JSON.stringify(item));
  return await showProfile(ctx, options.id);
}

/** `field=value` pairs, then model additions and removals, applied in order; the first the server refuses stops the rest. */
export async function editProfile(
  ctx: HarnessContext,
  id: string,
  options: { sets: readonly string[]; unsets: readonly string[]; addModels: readonly string[]; removeModels: readonly string[] },
) {
  await showProfile(ctx, id);
  const applied: string[] = [];
  for (const model of options.addModels) {
    await setKey(ctx, keyFor(id, `models[${model}]`), "{}");
    applied.push(`+model ${model}`);
  }
  for (const entry of options.sets) {
    const at = entry.indexOf("=");
    if (at <= 0) throw new CliError("INVALID_CONFIG", `--set takes field=value, got "${entry.split("=")[0]}".`, { exitCode: 2 });
    await setKey(ctx, keyFor(id, entry.slice(0, at)), entry.slice(at + 1));
    applied.push(`set ${entry.slice(0, at)}`);
  }
  for (const field of options.unsets) {
    await setKey(ctx, keyFor(id, field), "");
    applied.push(`unset ${field}`);
  }
  for (const model of options.removeModels) {
    await setKey(ctx, keyFor(id, `models[${model}]`), "");
    applied.push(`-model ${model}`);
  }
  return { applied, ...(await showProfile(ctx, id)) };
}

export async function duplicateProfile(ctx: HarnessContext, id: string, newId: string) {
  await (await cliClient(ctx.config, undefined, ctx.configPath)).dispatch({ type: "settings.duplicate", key: PROFILES, id, newId });
  return await showProfile(ctx, newId);
}

/** A profile as an exportable JSON document: written to `out`, or returned for the caller to print. Nothing secret is in it. */
export async function exportProfile(ctx: HarnessContext, id: string, options: { out?: string }) {
  const { id: profileId, text } = await (await cliClient(ctx.config, undefined, ctx.configPath)).query({ type: "harness.profile.export", profileId: id });
  if (options.out === undefined) return { id: profileId, text, path: null };
  const target = path.resolve(options.out);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text, "utf8");
  return { id: profileId, text, path: target };
}

/** Add a profile from an exported file. An id already in use is an error unless `replace` says to overwrite it. */
export async function importProfile(ctx: HarnessContext, file: string, options: { id?: string; replace?: boolean }) {
  let text: string;
  try {
    text = await readFile(path.resolve(file), "utf8");
  } catch {
    throw new CliError("INVALID_CONFIG", `Cannot read ${file}.`);
  }
  const { id } = await (await cliClient(ctx.config, undefined, ctx.configPath)).dispatch({
    type: "harness.profile.import",
    text,
    ...(options.id !== undefined ? { id: options.id } : {}),
    onConflict: options.replace === true ? "replace" : "error",
  });
  return await showProfile(ctx, id);
}

export async function removeProfile(ctx: HarnessContext, id: string) {
  await showProfile(ctx, id);
  await setKey(ctx, keyFor(id), "");
  return { removed: id.toLowerCase() };
}

export async function testProfile(ctx: HarnessContext, id: string, model?: string) {
  return await (await cliClient(ctx.config, undefined, ctx.configPath)).dispatch({ type: "harness.profile.test", profileId: id, ...(model ? { model } : {}) });
}

export async function probeProfile(ctx: HarnessContext, id: string, options: { model?: string; dryRun?: boolean }) {
  return await (await cliClient(ctx.config, undefined, ctx.configPath)).dispatch({
    type: "harness.profile.probe",
    profileId: id,
    ...(options.model ? { model: options.model } : {}),
    ...(options.dryRun === true ? { dryRun: true } : {}),
  });
}
