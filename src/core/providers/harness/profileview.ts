/**
 * The profile list as a client draws it: every field's value, where each
 * value in force comes from, and the quirks a model ends up with and why.
 * Built in core so the TUI and `moxen harness profile show` say the same
 * thing and neither restates a precedence rule.
 */
import { itemEfforts } from "../../configlist.js";
import type { ListEffective, ListFieldView, ListItemView, ListResolvedRow } from "../../configschema.js";
import type { CliConfig, HarnessModelConfig, HarnessProfileConfig, HarnessProviderConfig } from "../../types.js";
import { compactLineFor, compactionModeFor, driverProviders } from "../../threads/longthreads.js";
import { resolveCompactionSettings, quirkInputs } from "./profiles.js";
import { HARNESS_PROFILE_FIELDS } from "./profileschema.js";
import { detectQuirkFamily, isQuirkFamily, quirkOrigins, resolveQuirks, type ModelQuirks, type QuirkOrigin } from "./quirks.js";

type Scalar = string | number | boolean | undefined;

function leaf(source: unknown, path: string): Scalar {
  let current: unknown = source;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string" || typeof current === "number" || typeof current === "boolean" ? current : undefined;
}

const ORIGIN: Record<QuirkOrigin, string> = {
  default: "default",
  preset: "family preset",
  probe: "probe",
  model: "model setting",
  profile: "preserveThinking in the config file",
  override: "your override",
};

/** Shown for objects and numbers too; a quirk row is a statement, not an editor. */
function show(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function isEmpty(value: unknown): boolean {
  return value === null || (typeof value === "object" && Object.keys(value as object).length === 0);
}

function modelResolved(profile: HarnessProfileConfig, model: HarnessModelConfig): ListResolvedRow[] {
  const quirks = resolveQuirks(quirkInputs(profile, model));
  const origins = quirkOrigins(quirkInputs(profile, model));
  const rows: ListResolvedRow[] = [];
  for (const key of Object.keys(quirks) as Array<keyof ModelQuirks>) {
    if (origins[key] === "default" || isEmpty(quirks[key])) continue;
    rows.push({ label: key, value: show(quirks[key]), origin: ORIGIN[origins[key]] });
  }
  rows.push({
    label: "last probe",
    value: model.probed ? model.probed.at.slice(0, 16).replace("T", " ") : "never",
    origin: model.probed ? "probe" : "run `moxen harness probe`",
  });
  return rows;
}

function modelEffective(profile: HarnessProfileConfig, model: HarnessModelConfig): Record<string, ListEffective> {
  const effective: Record<string, ListEffective> = {};
  // The older profile-wide switch speaks for a model that does not say.
  const images = profile.quirks?.images;
  if (model.vision === undefined && (images === "native" || images === "none")) effective.vision = { value: images === "native", origin: "quirks.images in the config file" };
  if (model.contextWindow === undefined && model.probed?.contextWindow !== undefined) {
    effective.contextWindow = { value: model.probed.contextWindow, origin: "the server, from a probe" };
  }
  if (!isQuirkFamily(model.family)) {
    effective.family = { value: detectQuirkFamily(model.id), origin: "the model's name" };
  }
  return effective;
}

function fieldViews(fields: readonly (typeof HARNESS_PROFILE_FIELDS)[number][], raw: unknown, effective: Record<string, ListEffective>, nested: Record<string, readonly ListItemView[]>): ListFieldView[] {
  return fields.map((field) => {
    const items = nested[field.path];
    if (items !== undefined) return { path: field.path, value: undefined, explicit: items.length > 0, items };
    const value = leaf(raw, field.path);
    const inForce = effective[field.path];
    const choices = field.kind.type === "effort" ? itemEfforts(raw as Record<string, unknown>).map((effort) => ({ value: effort, label: effort })) : undefined;
    return { path: field.path, value, explicit: value !== undefined, ...(inForce ? { effective: inForce } : {}), ...(choices ? { choices } : {}) };
  });
}

/** Where each compaction value in force comes from: this profile, the Moxen Harness setting, the global one or the default (`core/threads/longthreads.ts`). */
function compactionEffective(config: CliConfig, profile: HarnessProfileConfig): Record<string, ListEffective> {
  const own = profile.compaction;
  const harness = config.providers?.harness;
  const settings = resolveCompactionSettings(driverProviders(config)?.harness, profile);
  const out: Record<string, ListEffective> = {};
  const place = (key: string | null | undefined): string => (key === null || key === undefined ? "the default" : key.startsWith("longThreads.") ? "the global setting" : "the Moxen Harness setting");
  out["compaction.auto"] = { value: settings.auto, origin: own?.auto !== undefined ? "this profile" : place(compactionModeFor(config, "harness").key) };
  // The older share in the profile still applies while its size is unset: said here, on the one row the page shows.
  if (own?.tokens === undefined && own?.fraction !== undefined) out["compaction.tokens"] = { value: undefined, origin: `${Math.round(own.fraction * 100)}% of the window, from compaction.fraction in the config file` };
  else if (settings.tokens !== null) out["compaction.tokens"] = { value: settings.tokens, origin: own?.tokens !== undefined ? "this profile" : place(compactLineFor(config, "harness")?.key) };
  else if (settings.fraction !== null) out["compaction.tokens"] = { value: undefined, origin: `${Math.round(settings.fraction * 100)}% of the window, ${place(compactLineFor(config, "harness")?.key)}` };
  // The older switch, read while 'Send earlier reasoning back' is unset.
  if (profile.preserveThinking === false && profile.quirks?.reasoningReplay === undefined) out["quirks.reasoningReplay"] = { value: "none", origin: "preserveThinking in the config file" };
  out["compaction.keepRecentTokens"] = { value: settings.keepRecentTokens, origin: own?.keepRecentTokens !== undefined ? "this profile" : harness?.keepRecentTokens !== undefined ? "the Moxen Harness setting" : "the default" };
  out["compaction.effort"] = { value: settings.effort, origin: own?.effort !== undefined ? "this profile" : "the default" };
  return out;
}

function modelView(profile: HarnessProfileConfig, model: HarnessModelConfig): ListItemView {
  const window = model.contextWindow ?? model.probed?.contextWindow;
  const parts = [
    window !== undefined ? `${window.toLocaleString("en-US")} tokens${model.contextWindow === undefined ? " (probed)" : ""}` : "no context window",
    ...(model.vision === true ? ["images"] : []),
    isQuirkFamily(model.family) ? model.family : detectQuirkFamily(model.id),
  ];
  const modelFields = (HARNESS_PROFILE_FIELDS.find((field) => field.path === "models")!.kind as { fields: typeof HARNESS_PROFILE_FIELDS }).fields;
  return {
    id: model.id,
    title: model.id,
    summary: parts.join(" · "),
    status: window === undefined ? "No context window: automatic compaction is off until one is set or probed." : null,
    fields: fieldViews(modelFields, model, modelEffective(profile, model), {}),
    resolved: modelResolved(profile, model),
  };
}

function profileView(config: CliConfig, profile: HarnessProfileConfig, env: NodeJS.ProcessEnv): ListItemView {
  const keyName = profile.apiKeyEnv;
  const keyMissing = profile.apiKey === undefined && keyName !== undefined && (env[keyName] ?? "").trim() === "";
  const models = profile.models.map((model) => modelView(profile, model));
  return {
    id: profile.id,
    title: profile.label ?? profile.id,
    summary: `${profile.baseUrl} · ${profile.models.length} model${profile.models.length === 1 ? "" : "s"}`,
    status: keyMissing ? `${keyName} is not set where Moxen's server runs` : null,
    fields: fieldViews(HARNESS_PROFILE_FIELDS, profile, compactionEffective(config, profile), { models }),
    resolved: [],
  };
}

export function describeHarnessProfiles(config: CliConfig, env: NodeJS.ProcessEnv = process.env): readonly ListItemView[] {
  return (config.providers?.harness?.profiles ?? []).map((profile) => profileView(config, profile, env));
}
