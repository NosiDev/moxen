/**
 * Addressing and editing a structured list inside the config: the harness
 * profiles today.
 *
 * A dotted path cannot name an array element, and an index would break the
 * moment two clients disagree about order, so list items are addressed by the
 * id they carry:
 *
 *   providers.harness.profiles                          the list
 *   providers.harness.profiles[colab]                   one item (JSON when set; empty removes it)
 *   providers.harness.profiles[colab].baseUrl           a field
 *   providers.harness.profiles[colab].sampling.topK     a dotted field
 *   providers.harness.profiles[colab].models[qwen3:8b].contextWindow
 *
 * Everything between `[` and `]` is the id, dots and colons included. Flat
 * keys never contain `[`, so they are unaffected. Values cross as text like
 * every other setting; what a value *means* (ranges, URL shape, which fields
 * may combine) stays with the list's owner — for profiles, `normalizeConfig`
 * runs the whole result through `providers/harness/profiles.ts`, so the error
 * names the field and no client restates a rule.
 */
import { CliError } from "./errors.js";
import { isSecretRef } from "./secrets.js";
import type { ListField, ListKind, SettingDescriptor, SettingValue } from "./configschema.js";
import type { CliConfig } from "./types.js";

export type ListDescriptor = SettingDescriptor & { readonly kind: ListKind };

/** What a key addresses inside a list. */
export interface ListTarget {
  readonly list: ListDescriptor;
  /** The item's id; null when the key names the list itself. */
  readonly id: string | null;
  /** Fields walked below the item, outermost first. Empty for the item. */
  readonly trail: ReadonlyArray<{ readonly field: ListField; readonly childId: string | null }>;
}

interface Segment {
  readonly name: string;
  readonly id: string | null;
}

function badKey(key: string, why: string): never {
  throw new CliError("INVALID_CONFIG_KEY", `${key}: ${why}`);
}

/** `name`, `name[id]` pieces separated by dots; an id may hold dots. */
function segments(text: string, key: string): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  while (at < text.length) {
    let name = "";
    while (at < text.length && text[at] !== "." && text[at] !== "[") name += text[at++];
    if (name === "") badKey(key, "a field name is empty.");
    let id: string | null = null;
    if (text[at] === "[") {
      const close = text.indexOf("]", at);
      if (close < 0) badKey(key, "a '[' has no closing ']'.");
      id = text.slice(at + 1, close);
      if (id === "") badKey(key, "an id between [ and ] is empty.");
      at = close + 1;
    }
    out.push({ name, id });
    if (at < text.length) {
      if (text[at] !== ".") badKey(key, `unexpected "${text[at]}" after a ]`);
      at += 1;
      if (at >= text.length) badKey(key, "ends with a '.'.");
    }
  }
  return out;
}

/** The list item or field a key addresses, or null when it is not a list key at all. */
export function resolveListKey(key: string, lists: readonly ListDescriptor[]): ListTarget | null {
  const list = lists.find((entry) => key === entry.key || key.startsWith(`${entry.key}[`));
  if (!list) return null;
  const rest = key.slice(list.key.length);
  if (rest === "") return { list, id: null, trail: [] };
  const open = rest.indexOf("]");
  if (open < 0) badKey(key, "a '[' has no closing ']'.");
  const rawId = rest.slice(1, open);
  if (rawId === "") badKey(key, "an id between [ and ] is empty.");
  const id = list.kind.lowercaseIds === true ? rawId.toLowerCase() : rawId;
  const tail = rest.slice(open + 1);
  if (tail === "") return { list, id, trail: [] };
  if (!tail.startsWith(".")) badKey(key, `unexpected "${tail[0]}" after a ]`);

  const parts = segments(tail.slice(1), key);
  const trail: Array<{ field: ListField; childId: string | null }> = [];
  let fields = list.kind.fields;
  let names: string[] = [];
  parts.forEach((part, index) => {
    names.push(part.name);
    if (part.id === null && index < parts.length - 1) return;
    const path = names.join(".");
    const field = fields.find((entry) => entry.path === path);
    if (!field) {
      badKey(key, `${list.kind.noun} has no field "${path}". Fields: ${fields.map((entry) => entry.path).join(", ")}.`);
    }
    trail.push({ field, childId: part.id });
    names = [];
    if (part.id !== null) {
      if (field.kind.type !== "list") badKey(key, `"${path}" is not a list, so it has no [id].`);
      fields = field.kind.fields;
    }
  });
  return { list, id, trail };
}

// -- reading -------------------------------------------------------------------

function walk(source: unknown, path: readonly string[]): unknown {
  let current: unknown = source;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A keyed list (an object of entries by name) as the array of `{ id, … }` the rest of this file works on. */
function recordToItems(value: unknown): Record<string, unknown>[] {
  const record = recordOf(value);
  return record === null ? [] : Object.entries(record).flatMap(([id, entry]) => (recordOf(entry) ? [{ ...(entry as Record<string, unknown>), id }] : []));
}

function itemsToRecord(items: readonly Record<string, unknown>[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of items) {
    const { id, ...rest } = item;
    if (typeof id === "string") out[id] = rest;
  }
  return out;
}

function itemsOf(root: unknown, list: ListDescriptor): Record<string, unknown>[] {
  const value = walk(root, list.key.split("."));
  if (list.kind.keyed === true) return recordToItems(value);
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

/** The raw value a key addresses: the list, an item, a nested item, or a field. Undefined when absent. */
export function readListValue(config: CliConfig, target: ListTarget): unknown {
  if (target.id === null) return itemsOf(config, target.list);
  let current: unknown = itemsOf(config, target.list).find((item) => item.id === target.id);
  for (const step of target.trail) {
    const value = walk(current, step.field.path.split("."));
    if (step.childId === null) {
      current = value;
      continue;
    }
    current = Array.isArray(value) ? (value as Record<string, unknown>[]).find((item) => item.id === step.childId) : undefined;
  }
  return current;
}

// -- parsing a field's text -----------------------------------------------------

/** One field's text as the value the config stores. Empty clears (undefined). Ranges are the owner's to check. */
export function parseListFieldValue(field: ListField, raw: string, key: string, existing?: unknown, item?: Record<string, unknown>): string | number | boolean | string[] | Record<string, string> | undefined {
  const text = raw.trim();
  if (text === "") return undefined;
  const kind = field.kind;
  switch (kind.type) {
    case "string":
      return text;
    case "integer": {
      const value = Number(text);
      if (!Number.isInteger(value)) throw new CliError("INVALID_CONFIG", `${key} must be a whole number.`);
      return value;
    }
    case "number": {
      const value = Number(text);
      if (!Number.isFinite(value)) throw new CliError("INVALID_CONFIG", `${key} must be a number.`);
      return value;
    }
    case "boolean": {
      if (text === "true") return true;
      if (text === "false") return false;
      throw new CliError("INVALID_CONFIG", `${key} must be true or false.`);
    }
    case "enum": {
      if (!kind.choices.some((choice) => choice.value === text)) {
        throw new CliError("INVALID_CONFIG", `${key} must be one of: ${kind.choices.map((choice) => choice.value).join(", ")}.`);
      }
      return text;
    }
    case "secret": {
      if (isSecretRef(text)) return text;
      throw new CliError("INVALID_CONFIG", `${key} holds a secret, which is kept in the OS keychain, not in the config. Set it with \`moxen config set ${key} <value>\` or on the settings page.`);
    }
    case "words": {
      const words = kind.separator === "comma" ? text.split(/[,\s]+/).filter((word) => word !== "") : splitShell(text, key);
      return words.length > 0 ? words : undefined;
    }
    case "pairs": {
      const previous = recordOf(existing) ?? {};
      const pairs: Record<string, string> = {};
      for (const line of raw.split("\n")) {
        const entry = line.trim();
        if (entry === "") continue;
        const at = entry.indexOf("=");
        if (at <= 0) throw new CliError("INVALID_CONFIG", `${key}: each line must be NAME=value (got "${entry.slice(0, 40)}").`);
        const name = entry.slice(0, at).trim();
        const value = entry.slice(at + 1).trim();
        if (kind.secret === true && value === HIDDEN_VALUE) {
          const kept = previous[name];
          if (typeof kept !== "string") throw new CliError("INVALID_CONFIG", `${key}: ${name} has no stored value to keep; type its value.`);
          pairs[name] = kept;
        } else {
          pairs[name] = value;
        }
      }
      return Object.keys(pairs).length > 0 ? pairs : undefined;
    }
    case "list":
      throw new CliError("INVALID_CONFIG", `${key} is a list; address one entry as ${field.path}[<id>].`);
    case "effort": {
      const offered = itemEfforts(item);
      if (offered.includes(text)) return text;
      throw new CliError(
        "INVALID_CONFIG",
        offered.length === 0
          ? `${key}: none of this entry's models lists reasoning efforts. Add them to a model's efforts first.`
          : `${key} must be one of the efforts its models list: ${offered.join(", ")}.`,
      );
    }
  }
}

/** The efforts an item's models list (`models[].efforts`), in order, once each. */
export function itemEfforts(item: Record<string, unknown> | undefined): string[] {
  const models = Array.isArray(item?.models) ? (item.models as unknown[]) : [];
  const out: string[] = [];
  for (const model of models) {
    const efforts = recordOf(model)?.efforts;
    if (!Array.isArray(efforts)) continue;
    for (const effort of efforts) if (typeof effort === "string" && !out.includes(effort)) out.push(effort);
  }
  return out;
}

/** The placeholder a secret map shows in place of a value (see `mcpview.ts`). */
export const HIDDEN_VALUE = "<hidden>";

/** Words split like a shell would: spaces separate, quotes keep a word together, a backslash escapes. */
function splitShell(text: string, key: string): string[] {
  const words: string[] = [];
  let current = "";
  let started = false;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < text.length) current += text[++i];
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (ch === "\\" && i + 1 < text.length) {
      current += text[++i];
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) words.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (quote !== null) throw new CliError("INVALID_CONFIG", `${key}: a quote is not closed.`);
  if (started) words.push(current);
  return words;
}

function parseObject(raw: string, key: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError("INVALID_CONFIG", `${key} must be set to a JSON object.`);
  }
  const value = recordOf(parsed);
  if (!value) throw new CliError("INVALID_CONFIG", `${key} must be set to a JSON object.`);
  return value;
}

// -- writing -------------------------------------------------------------------

function upsert(array: Record<string, unknown>[], id: string, value: Record<string, unknown> | undefined, key: string): void {
  const at = array.findIndex((item) => item.id === id);
  if (value === undefined) {
    if (at >= 0) array.splice(at, 1);
    return;
  }
  if (value.id !== undefined && value.id !== id) {
    throw new CliError("INVALID_CONFIG", `${key}: the id in the value ("${String(value.id)}") must match the one in the key.`);
  }
  const next = { ...value, id };
  if (at >= 0) array[at] = next;
  else array.push(next);
}

/** A dotted field inside an item object, set or (when `value` is undefined) removed, with emptied parents pruned. */
function setPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  const [head, ...tail] = path;
  if (head === undefined) return;
  if (tail.length === 0) {
    if (value === undefined) delete target[head];
    else target[head] = value;
    return;
  }
  const child = recordOf(target[head]) ? { ...(target[head] as Record<string, unknown>) } : {};
  setPath(child, tail, value);
  if (Object.keys(child).length === 0) delete target[head];
  else target[head] = child;
}

/**
 * The config with one list item or field changed. For an item `raw` is JSON
 * (the item is created or replaced; empty removes it); for a field it is that
 * field's text (empty clears). Nothing here validates beyond shape: the caller
 * normalises the result, which is where the list's own rules run.
 */
function writeListValueArray(config: CliConfig, target: ListTarget, raw: string, key: string): CliConfig {
  const next = structuredClone(config) as unknown as Record<string, unknown>;
  const path = target.list.key.split(".");
  let cursor = next;
  for (const segment of path.slice(0, -1)) {
    const child = recordOf(cursor[segment]) ?? {};
    cursor[segment] = child;
    cursor = child;
  }
  const leaf = path[path.length - 1]!;
  const items: Record<string, unknown>[] = Array.isArray(cursor[leaf]) ? (cursor[leaf] as Record<string, unknown>[]) : [];
  cursor[leaf] = items;

  if (target.id === null) {
    let parsed: unknown;
    try {
      parsed = raw.trim() === "" ? [] : JSON.parse(raw);
    } catch {
      throw new CliError("INVALID_CONFIG", `${key} must be set to a JSON list.`);
    }
    if (!Array.isArray(parsed)) throw new CliError("INVALID_CONFIG", `${key} must be set to a JSON list.`);
    cursor[leaf] = parsed;
    return next as unknown as CliConfig;
  }

  if (target.trail.length === 0) {
    upsert(items, target.id, raw.trim() === "" ? undefined : parseObject(raw, key), key);
    return next as unknown as CliConfig;
  }

  const item = items.find((entry) => entry.id === target.id);
  if (!item) {
    throw new CliError("INVALID_CONFIG_KEY", `No ${target.list.kind.noun} "${target.id}". Create it first: moxen config set '${target.list.key}[${target.id}]' '{...}'.`);
  }
  // Walk down to the object the last step edits.
  let holder: Record<string, unknown> = item;
  for (const step of target.trail.slice(0, -1)) {
    const fieldPath = step.field.path.split(".");
    const array = walk(holder, fieldPath);
    const child = Array.isArray(array) ? (array as Record<string, unknown>[]).find((entry) => entry.id === step.childId) : undefined;
    if (!child) throw new CliError("INVALID_CONFIG_KEY", `${key}: there is no "${step.childId}" to edit.`);
    holder = child;
  }
  const last = target.trail[target.trail.length - 1]!;
  const fieldPath = last.field.path.split(".");
  if (last.field.kind.type === "list") {
    const parentPath = fieldPath;
    const existing = walk(holder, parentPath);
    const array: Record<string, unknown>[] = Array.isArray(existing) ? (existing as Record<string, unknown>[]) : [];
    if (last.childId === null) {
      let parsed: unknown;
      try {
        parsed = raw.trim() === "" ? undefined : JSON.parse(raw);
      } catch {
        throw new CliError("INVALID_CONFIG", `${key} must be set to a JSON list.`);
      }
      if (parsed !== undefined && !Array.isArray(parsed)) throw new CliError("INVALID_CONFIG", `${key} must be set to a JSON list.`);
      setPath(holder, parentPath, parsed);
    } else {
      upsert(array, last.childId, raw.trim() === "" ? undefined : parseObject(raw, key), key);
      setPath(holder, parentPath, array);
    }
    return next as unknown as CliConfig;
  }
  setPath(holder, fieldPath, parseListFieldValue(last.field, raw, key, walk(holder, fieldPath), holder));
  return next as unknown as CliConfig;
}

/** Same as above, for a keyed list: the entries are worked on as `{ id, … }` items and stored back by name. */
export function writeListValue(config: CliConfig, target: ListTarget, raw: string, key: string): CliConfig {
  if (target.list.kind.keyed !== true) return writeListValueArray(config, target, raw, key);
  const path = target.list.key.split(".");
  const leaf = path[path.length - 1]!;
  const holderOf = (root: Record<string, unknown>): Record<string, unknown> => {
    let cursor = root;
    for (const segment of path.slice(0, -1)) {
      const child = recordOf(cursor[segment]) ?? {};
      cursor[segment] = child;
      cursor = child;
    }
    return cursor;
  };
  if (target.id === null) {
    let parsed: unknown;
    try {
      parsed = raw.trim() === "" ? {} : JSON.parse(raw);
    } catch {
      throw new CliError("INVALID_CONFIG", `${key} must be set to a JSON object keyed by ${target.list.kind.noun} name.`);
    }
    if (!recordOf(parsed)) throw new CliError("INVALID_CONFIG", `${key} must be set to a JSON object keyed by ${target.list.kind.noun} name.`);
    const clone = structuredClone(config) as unknown as Record<string, unknown>;
    holderOf(clone)[leaf] = parsed;
    return clone as unknown as CliConfig;
  }
  const clone = structuredClone(config) as unknown as Record<string, unknown>;
  const holder = holderOf(clone);
  holder[leaf] = recordToItems(holder[leaf]);
  const written = writeListValueArray(clone as unknown as CliConfig, target, raw, key) as unknown as Record<string, unknown>;
  const writtenHolder = holderOf(written);
  const record = itemsToRecord(Array.isArray(writtenHolder[leaf]) ? (writtenHolder[leaf] as Record<string, unknown>[]) : []);
  if (Object.keys(record).length === 0) delete writtenHolder[leaf];
  else writtenHolder[leaf] = record;
  return written as unknown as CliConfig;
}

/** The scalar a field key holds, for `readSetting`: undefined for items, lists and absent fields. */
export function readListScalar(config: CliConfig, target: ListTarget): SettingValue {
  const value = readListValue(config, target);
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
}

/**
 * A copy of an item under a new id. Measurements about one particular server
 * (`probed`) do not travel with the copy: it may well point somewhere else.
 */
export function duplicateListItem(config: CliConfig, target: ListTarget, newId: string, key: string): CliConfig {
  if (target.id === null || target.trail.length > 0) throw new CliError("INVALID_CONFIG_KEY", `${key}: name the entry to copy, as ${target.list.key}[<id>].`);
  const source = readListValue(config, target);
  const item = recordOf(source);
  if (!item) throw new CliError("INVALID_CONFIG_KEY", `No ${target.list.kind.noun} "${target.id}".`);
  const id = target.list.kind.lowercaseIds === true ? newId.toLowerCase() : newId;
  if (itemsOf(config, target.list).some((entry) => entry.id === id)) {
    throw new CliError("INVALID_CONFIG", `A ${target.list.kind.noun} "${id}" already exists.`);
  }
  const copy = JSON.parse(JSON.stringify(item, (name, value: unknown) => (name === "probed" ? undefined : value))) as Record<string, unknown>;
  delete copy.id;
  if (typeof copy.label === "string") copy.label = `${copy.label} copy`;
  return writeListValue(config, { ...target, id }, JSON.stringify(copy), key);
}
