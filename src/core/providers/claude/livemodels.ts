/**
 * Claude models as the installed Claude Code reports them.
 *
 * The Agent SDK answers `supportedModels()` on initialize, with no prompt
 * and no API call. That keeps the list and each model's effort levels in
 * step with the installed CLI; `claude-models.json` stays as the fallback
 * for when no answer is available (CLI missing, offline start, a failed
 * probe). The last answer is cached in the store root so a catalog read
 * does not spawn a CLI every time.
 *
 * Everything parses defensively: a malformed answer yields no models, and
 * the caller falls back to the bundled list.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { bundledClaudeModels, type ClaudeCatalogModel } from "./catalog.js";
import { resolveClaudeExecutable } from "./config.js";
import type { ClaudeTransport } from "./transport.js";

/** How long a cached answer is trusted before the CLI is asked again. */
export const LIVE_MODELS_TTL_MS = 12 * 60 * 60 * 1000;

const LEVEL_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * `ModelInfo[]` from the SDK as catalog models. The SDK lists aliases
 * ("default", "opus", "sonnet") next to explicit ids; an alias is dropped
 * when its `resolvedModel` is listed too, and kept under that resolved id
 * otherwise, so every row is something a thread can pin. A model the
 * bundled list knows keeps its display name and default effort; the SDK
 * does not say which level is the default.
 */
export function parseSdkModels(
  raw: unknown,
  bundled: ReadonlyArray<ClaudeCatalogModel> = bundledClaudeModels(),
): ClaudeCatalogModel[] {
  if (!Array.isArray(raw)) return [];
  const known = new Map(bundled.map((model) => [model.slug, model] as const));
  const bundledDefault = bundled.find((model) => model.isDefault === true)?.slug ?? null;
  const seen = new Set<string>();
  const rows: Array<{ slug: string; name: string; levels: string[]; explicit: boolean }> = [];
  for (const entry of raw) {
    const info = asRecord(entry);
    const value = info ? asString(info.value) : null;
    if (!info || !value) continue;
    const slug = asString(info.resolvedModel) ?? value;
    if (seen.has(slug)) continue;
    const isAlias = slug !== value;
    // An alias row's display name is a marketing string ("Default (recommended)").
    if (isAlias && raw.some((other) => asRecord(other)?.value === slug)) continue;
    seen.add(slug);
    const display = asString(info.displayName);
    const levels = info.supportsEffort === false || !Array.isArray(info.supportedEffortLevels)
      ? []
      : info.supportedEffortLevels.filter((level): level is string => typeof level === "string" && level in LEVEL_LABELS);
    const name = known.get(slug)?.name ?? (value === "default" || !display ? slug : display.startsWith("Claude") ? display : `Claude ${display}`);
    rows.push({ slug, name, levels, explicit: !isAlias });
  }
  // The CLI's own "default" alias resolves to what Claude Code would pick for this account; the bundled default is only the fallback.
  const reported = raw.map(asRecord).find((info) => info?.value === "default");
  const reportedSlug = reported ? asString(reported.resolvedModel) : null;
  const defaultSlug = [reportedSlug, bundledDefault].find((slug) => slug !== null && rows.some((row) => row.slug === slug)) ?? null;
  return rows.map((row) => {
    const fallback = known.get(row.slug)?.efforts.find((effort) => effort.id === "effort")?.choices.find((choice) => choice.isDefault === true)?.id;
    const defaultLevel = row.levels.includes(fallback ?? "") ? fallback : row.levels.includes("medium") ? "medium" : row.levels[0];
    return {
      slug: row.slug,
      name: row.name,
      isDefault: defaultSlug === null ? null : defaultSlug === row.slug,
      efforts: row.levels.length === 0
        ? []
        : [{
          id: "effort",
          label: "Reasoning",
          choices: row.levels.map((level) => ({
            id: level,
            label: LEVEL_LABELS[level] ?? level,
            isDefault: level === defaultLevel ? true : null,
          })),
          currentValue: null,
        }],
    };
  });
}

interface ModelCache {
  readonly fetchedAt: number;
  readonly models: unknown[];
}

export function liveModelsFile(storeRoot: string): string {
  return path.join(storeRoot, "claude-models-cache.json");
}

export async function loadLiveModelsCache(storeRoot: string): Promise<ModelCache | null> {
  try {
    const root = asRecord(JSON.parse(await readFile(liveModelsFile(storeRoot), "utf8")) as unknown);
    if (!root || typeof root.fetchedAt !== "number" || !Array.isArray(root.models)) return null;
    return { fetchedAt: root.fetchedAt, models: root.models };
  } catch {
    return null;
  }
}

async function saveLiveModelsCache(storeRoot: string, cache: ModelCache): Promise<void> {
  await mkdir(storeRoot, { recursive: true });
  const file = liveModelsFile(storeRoot);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(cache, null, 2));
  await rename(tmp, file);
}

export interface FetchLiveModelsOptions {
  readonly transport: ClaudeTransport;
  readonly binaryPath: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

/**
 * Ask a prompt-less query for `supportedModels()` — the same trick the
 * skill inventory uses. Null when the CLI cannot answer in time.
 */
export async function fetchLiveModels(options: FetchLiveModelsOptions): Promise<unknown[] | null> {
  const env = options.env ?? process.env;
  const stringEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === "string") stringEnv[key] = value;
  const never: AsyncIterable<never> = {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<never>>(() => undefined) }),
  };
  const query = options.transport.query(never, {
    cwd: options.cwd ?? process.cwd(),
    permissionMode: "default",
    env: stringEnv,
    pathToClaudeCodeExecutable: resolveClaudeExecutable(options.binaryPath, env),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!query.supportedModels) return null;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), options.timeoutMs ?? 10_000);
    });
    const answer = await Promise.race([query.supportedModels().catch(() => null), timeout]);
    return Array.isArray(answer) && answer.length > 0 ? answer : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    query.close?.();
  }
}

/**
 * The Claude models to list: a fresh cached answer, else a new one from the
 * CLI (when `fetch` is given), else a stale cached one, else null — the
 * bundled list then stands. Never throws.
 */
export async function resolveLiveModels(options: {
  readonly storeRoot: string;
  readonly fetch?: (() => Promise<unknown[] | null>) | undefined;
  readonly now?: number;
  readonly ttlMs?: number;
}): Promise<ClaudeCatalogModel[] | null> {
  const now = options.now ?? Date.now();
  const cache = await loadLiveModelsCache(options.storeRoot);
  const fresh = cache !== null && now - cache.fetchedAt < (options.ttlMs ?? LIVE_MODELS_TTL_MS);
  let raw: unknown[] | null = cache?.models ?? null;
  if (!fresh && options.fetch) {
    const fetched = await options.fetch().catch(() => null);
    if (fetched && parseSdkModels(fetched).length > 0) {
      raw = fetched;
      await saveLiveModelsCache(options.storeRoot, { fetchedAt: now, models: fetched }).catch(() => undefined);
    }
  }
  if (!raw) return null;
  const models = parseSdkModels(raw);
  return models.length > 0 ? models : null;
}
