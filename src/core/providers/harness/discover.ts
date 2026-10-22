/**
 * Ask a model server which models it serves (`GET /v1/models`), so adding a
 * provider can offer a list instead of asking the user to type a name. Works
 * before any profile exists: it takes an address, a wire format and the NAME
 * of the environment variable holding a key, and reads the key itself. The
 * key goes out only as the auth header; nothing here returns or logs it.
 */
import type { DiscoverResult, DiscoveredModel, HarnessApiFormat } from "../../types.js";

export type { DiscoverResult, DiscoveredModel };

export interface DiscoverOptions {
  readonly baseUrl: string;
  readonly apiFormat: HarnessApiFormat;
  /** Name of the environment variable holding the key, when the server wants one. */
  readonly apiKeyEnv?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
}

const ANTHROPIC_VERSION = "2023-06-01";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/** The window servers report under their own names: llama.cpp `meta.n_ctx_train`, vLLM `max_model_len`, OpenRouter `context_length`. */
function contextOf(entry: Record<string, unknown>): number | undefined {
  return positive(entry.max_model_len) ?? positive(entry.context_length) ?? positive(asRecord(entry.meta)?.n_ctx_train);
}

export function modelsUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "").replace(/\/v\d+$/, "")}/v1/models`;
}

export async function discoverModels(options: DiscoverOptions): Promise<DiscoverResult> {
  let url: URL;
  try {
    url = new URL(modelsUrl(options.baseUrl));
  } catch {
    return { ok: false, message: `"${options.baseUrl}" is not an address. Use something like http://192.168.1.20:11434.`, host: null };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, message: "The address must start with http:// or https://.", host: null };
  }
  const host = url.host;
  const env = options.env ?? process.env;
  const key = options.apiKeyEnv ? env[options.apiKeyEnv]?.trim() : undefined;
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.apiFormat === "anthropic") {
    headers["anthropic-version"] = ANTHROPIC_VERSION;
    if (key) headers["x-api-key"] = key;
  } else if (key) headers.authorization = `Bearer ${key}`;

  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, { headers, signal: AbortSignal.timeout(options.timeoutMs ?? 8000) });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { ok: false, host, message: timedOut ? `${host} did not answer in time. Is the server running, and is that the right address?` : `Could not reach ${host}. Is the server running, and is that the right address?` };
  }
  if (response.status === 401 || response.status === 403) {
    const hint = options.apiKeyEnv && !key ? ` Set ${options.apiKeyEnv} in the environment Moxen runs in, or save a key on the profile afterwards.` : "";
    return { ok: false, host, message: `${host} wants a key (HTTP ${response.status}).${hint}` };
  }
  if (!response.ok) {
    return { ok: false, host, message: `${host} has no model list at ${url.pathname} (HTTP ${response.status}). Type the model's name instead.` };
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, host, message: `${host} answered, but not with a model list. Type the model's name instead.` };
  }
  const data = Array.isArray(asRecord(json)?.data) ? (asRecord(json)!.data as unknown[]) : [];
  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  for (const raw of data) {
    const entry = asRecord(raw);
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!entry || id === "" || seen.has(id)) continue;
    seen.add(id);
    const contextWindow = contextOf(entry);
    models.push(contextWindow === undefined ? { id } : { id, contextWindow });
  }
  if (models.length === 0) return { ok: false, host, message: `${host} is up but lists no models. Load one, or type a model's name.` };
  return { ok: true, host, models };
}
