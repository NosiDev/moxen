/**
 * Moving a harness profile between machines or people: one JSON document per
 * profile. What it leaves out is on purpose. A saved API key lives in the OS
 * keychain and never travels (the receiver types their own, or names an
 * environment variable); a model's `probed` block describes one server's chat
 * template and would mislead on another, so it is dropped and the receiver
 * probes for themselves.
 */
import { CliError } from "../../errors.js";
import type { HarnessProfileConfig } from "../../types.js";
import { normalizeHarnessConfig } from "./profiles.js";

export const PROFILE_DOCUMENT_KIND = "moxen.harness-profile";

export interface ProfileDocument {
  readonly kind: typeof PROFILE_DOCUMENT_KIND;
  readonly version: 1;
  readonly profile: Record<string, unknown>;
}

/** The shareable form of a profile, as plain JSON. */
export function exportProfileDocument(profile: HarnessProfileConfig): ProfileDocument {
  const plain = JSON.parse(JSON.stringify(profile)) as Record<string, unknown>;
  delete plain.apiKey;
  if (Array.isArray(plain.models)) {
    for (const model of plain.models as Array<Record<string, unknown>>) delete model.probed;
  }
  return { kind: PROFILE_DOCUMENT_KIND, version: 1, profile: plain };
}

/**
 * A profile out of exported text: the document, or a bare profile object.
 * Checked by the same code that checks the config file, so a bad file fails
 * here with the field named instead of half-applying. Any key reference or
 * probe result in it is ignored.
 */
export function parseProfileDocument(text: string): HarnessProfileConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CliError("INVALID_CONFIG", "That is not a JSON file.");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new CliError("INVALID_CONFIG", "A profile file holds one JSON object.");
  const record = raw as Record<string, unknown>;
  if ("kind" in record && record.kind !== PROFILE_DOCUMENT_KIND) throw new CliError("INVALID_CONFIG", `This file is a "${String(record.kind)}", not an exported harness profile.`);
  const body = "kind" in record ? record.profile : record;
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new CliError("INVALID_CONFIG", "The file has no profile in it.");
  const clean = { ...(body as Record<string, unknown>) };
  delete clean.apiKey;
  if (Array.isArray(clean.models)) {
    clean.models = (clean.models as unknown[]).map((model) => {
      if (typeof model !== "object" || model === null || Array.isArray(model)) return model;
      const { probed: _probed, ...rest } = model as Record<string, unknown>;
      return rest;
    });
  }
  const parsed = normalizeHarnessConfig({ profiles: [clean] })?.profiles?.[0];
  if (!parsed) throw new CliError("INVALID_CONFIG", "The file has no profile in it.");
  return parsed;
}

/** `id`, or `id-2`, `id-3`… when it is taken. */
export function freeProfileId(id: string, taken: ReadonlySet<string>): string {
  if (!taken.has(id)) return id;
  for (let n = 2; ; n += 1) {
    const next = `${id}-${n}`;
    if (!taken.has(next)) return next;
  }
}
