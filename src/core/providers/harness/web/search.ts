/**
 * `web_search`: a query in, a short list of results out (title, address, a
 * snippet). The backend is a setting. DuckDuckGo's HTML page needs no account
 * and is the default; Exa and Brave are hosted APIs that take a key; SearXNG
 * is an instance the user runs. A key is only ever the NAME of an environment
 * variable here, read when the request goes out, and no error text includes it.
 */
import { cachedSecret } from "../../../secrets.js";
import { untrustedContext } from "../mcp.js";
import type { ToolResult } from "../tools/types.js";
import { decodeEntities } from "./htmltext.js";
import { httpRequest, WebError } from "./http.js";
import { PAGE_HEADERS } from "./fetch.js";
import type { NetworkPolicy } from "./netguard.js";

export const SEARCH_BACKENDS = ["duckduckgo", "exa", "brave", "searxng"] as const;
export type SearchBackend = (typeof SEARCH_BACKENDS)[number];

export interface SearchSettings {
  readonly backend: SearchBackend;
  /** The NAME of the environment variable holding the key, for the backends that take one. */
  readonly keyEnv?: string | undefined;
  /** A `keychain:` reference to a saved key; wins over `keyEnv`. */
  readonly keyRef?: string | undefined;
  readonly searxngUrl?: string | undefined;
}

export interface SearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface SearchContext {
  readonly settings: SearchSettings;
  readonly env: NodeJS.ProcessEnv;
  readonly policy: NetworkPolicy;
  readonly signal: AbortSignal;
  /** Where each backend lives; swapped out in tests. */
  readonly endpoints?: Partial<Record<SearchBackend, string>>;
  readonly resolve?: Parameters<typeof httpRequest>[1]["resolve"];
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const DEFAULT_ENDPOINTS: Readonly<Record<Exclude<SearchBackend, "searxng">, string>> = {
  duckduckgo: "https://html.duckduckgo.com/html/",
  exa: "https://api.exa.ai/search",
  brave: "https://api.search.brave.com/res/v1/web/search",
};
const MAX_BODY = 2_000_000;
const TIMEOUT = 20_000;

/** A backend that cannot be used as configured says what to set; it never says what the key is. */
class SearchSetupError extends Error {}

function apiKey(context: SearchContext): string {
  const saved = cachedSecret(context.settings.keyRef);
  if (saved !== undefined) return saved.trim();
  const name = context.settings.keyEnv;
  if (!name) throw new SearchSetupError(`${context.settings.backend} needs an API key. Save one in the Moxen Harness settings (Search key), or name the environment variable that holds it in webSearchKeyEnv.`);
  if (!ENV_NAME.test(name)) throw new SearchSetupError("webSearchKeyEnv must be the NAME of an environment variable, not the key itself.");
  const value = context.env[name]?.trim();
  if (!value) throw new SearchSetupError(`The environment variable ${name} (webSearchKeyEnv) is not set where Moxen's server runs.`);
  return value;
}

const text = (value: unknown): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
const plain = (html: string): string => decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

/** DuckDuckGo wraps each result address in a redirect of its own; the real one is in `uddg`. */
export function unwrapDuckDuckGo(href: string): string | null {
  try {
    const url = new URL(decodeEntities(href), "https://duckduckgo.com/");
    if (url.hostname.endsWith("duckduckgo.com") && url.pathname.startsWith("/l/")) return url.searchParams.get("uddg");
    return url.toString();
  } catch {
    return null;
  }
}

export function parseDuckDuckGo(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  // Each result's link carries class "result__a"; its snippet is the next "result__snippet" element before the following link.
  const links = [...html.matchAll(/<a\b([^>]*\bclass\s*=\s*["'][^"']*\bresult__a\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi)];
  links.forEach((link, index) => {
    const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(link[1]!)?.[1];
    const url = href ? unwrapDuckDuckGo(href) : null;
    if (!url || !/^https?:/i.test(url)) return;
    const from = (link.index ?? 0) + link[0].length;
    const to = links[index + 1]?.index ?? html.length;
    const snippet = /<(?:a|td|div)\b[^>]*\bclass\s*=\s*["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|td|div)>/i.exec(html.slice(from, to))?.[1];
    hits.push({ title: plain(link[2]!), url, snippet: snippet ? plain(snippet) : "" });
  });
  return hits;
}

async function viaDuckDuckGo(query: string, count: number, context: SearchContext): Promise<SearchHit[]> {
  const endpoint = context.endpoints?.duckduckgo ?? DEFAULT_ENDPOINTS.duckduckgo;
  const response = await httpRequest(`${endpoint}?q=${encodeURIComponent(query)}`, { headers: { ...PAGE_HEADERS, referer: "https://duckduckgo.com/" }, maxBytes: MAX_BODY, timeoutMs: TIMEOUT, signal: context.signal, policy: context.policy, ...(context.resolve ? { resolve: context.resolve } : {}) });
  const html = response.body.toString("utf8");
  const hits = parseDuckDuckGo(html);
  if (hits.length === 0 && (response.status === 202 || response.status === 403 || response.status === 429 || /anomaly|unfortunately, bots|captcha/i.test(html))) {
    throw new SearchSetupError("DuckDuckGo asked for a human check instead of answering, which it does when it sees many automated searches. Try again later, or set webSearch to exa, brave or searxng.");
  }
  if (response.status >= 400) throw new SearchSetupError(`DuckDuckGo answered ${response.status}.`);
  return hits.slice(0, count);
}

async function viaExa(query: string, count: number, context: SearchContext): Promise<SearchHit[]> {
  const key = apiKey(context);
  const endpoint = context.endpoints?.exa ?? DEFAULT_ENDPOINTS.exa;
  const response = await httpRequest(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "x-api-key": key },
    body: JSON.stringify({ query, numResults: count, contents: { highlights: { maxCharacters: 600 } } }),
    maxBytes: MAX_BODY,
    timeoutMs: TIMEOUT,
    signal: context.signal,
    policy: context.policy,
    ...(context.resolve ? { resolve: context.resolve } : {}),
  });
  if (response.status === 401 || response.status === 403) throw new SearchSetupError(`Exa refused the key (${context.settings.keyRef ? "the saved one" : context.settings.keyEnv}).`);
  if (response.status === 402 || response.status === 429) throw new SearchSetupError(`Exa answered ${response.status}: the account is out of credits or over its rate limit.`);
  if (response.status >= 400) throw new SearchSetupError(`Exa answered ${response.status}.`);
  const parsed = JSON.parse(response.body.toString("utf8")) as { results?: Array<Record<string, unknown>> };
  return (parsed.results ?? []).slice(0, count).flatMap((entry) => {
    const url = text(entry.url);
    if (!url) return [];
    const highlights = Array.isArray(entry.highlights) ? entry.highlights.map(text).filter(Boolean).join(" … ") : "";
    return [{ title: text(entry.title) || url, url, snippet: highlights || text(entry.text).slice(0, 600) || text(entry.summary) }];
  });
}

async function viaBrave(query: string, count: number, context: SearchContext): Promise<SearchHit[]> {
  const key = apiKey(context);
  const endpoint = context.endpoints?.brave ?? DEFAULT_ENDPOINTS.brave;
  const response = await httpRequest(`${endpoint}?q=${encodeURIComponent(query)}&count=${count}`, {
    headers: { accept: "application/json", "x-subscription-token": key },
    maxBytes: MAX_BODY,
    timeoutMs: TIMEOUT,
    signal: context.signal,
    policy: context.policy,
    ...(context.resolve ? { resolve: context.resolve } : {}),
  });
  if (response.status === 401 || response.status === 403 || response.status === 422) throw new SearchSetupError(`Brave refused the key (${context.settings.keyRef ? "the saved one" : context.settings.keyEnv}).`);
  if (response.status === 429) throw new SearchSetupError("Brave answered 429: over the plan's rate limit or allowance.");
  if (response.status >= 400) throw new SearchSetupError(`Brave answered ${response.status}.`);
  const parsed = JSON.parse(response.body.toString("utf8")) as { web?: { results?: Array<Record<string, unknown>> } };
  return (parsed.web?.results ?? []).slice(0, count).flatMap((entry) => {
    const url = text(entry.url);
    return url ? [{ title: plain(text(entry.title)) || url, url, snippet: plain(text(entry.description)) }] : [];
  });
}

async function viaSearxng(query: string, count: number, context: SearchContext): Promise<SearchHit[]> {
  const base = context.settings.searxngUrl?.trim();
  if (!base) throw new SearchSetupError("searxng needs the address of your instance in the harness setting searxngUrl.");
  let url: URL;
  try {
    url = new URL(base);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
  } catch {
    throw new SearchSetupError("searxngUrl must be an http(s) address.");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/search`;
  url.search = `?q=${encodeURIComponent(query)}&format=json`;
  // The instance is the user's own, typically on this machine or their network: it is trusted by being named.
  const response = await httpRequest(url.toString(), { headers: { accept: "application/json", "user-agent": PAGE_HEADERS["user-agent"]! }, maxBytes: MAX_BODY, timeoutMs: TIMEOUT, signal: context.signal, policy: { allowPrivate: true }, ...(context.resolve ? { resolve: context.resolve } : {}) });
  if (response.status === 403) throw new SearchSetupError("The SearXNG instance refused the request; its settings must allow the json format (search.formats).");
  if (response.status >= 400) throw new SearchSetupError(`The SearXNG instance answered ${response.status}.`);
  const parsed = JSON.parse(response.body.toString("utf8")) as { results?: Array<Record<string, unknown>> };
  return (parsed.results ?? []).slice(0, count).flatMap((entry) => {
    const found = text(entry.url);
    return found ? [{ title: text(entry.title) || found, url: found, snippet: text(entry.content) }] : [];
  });
}

/** The host the backend talks to, for the approval prompt and the "allow for this session" key. */
export function searchHost(settings: SearchSettings): string {
  if (settings.backend === "searxng") {
    try {
      return new URL(settings.searxngUrl ?? "").hostname;
    } catch {
      return "searxng";
    }
  }
  return new URL(DEFAULT_ENDPOINTS[settings.backend]).hostname;
}

export async function searchWeb(query: string, requested: number | undefined, context: SearchContext): Promise<ToolResult> {
  const trimmed = query.trim();
  if (trimmed === "") return { content: "web_search needs a query.", isError: true };
  const count = Math.min(Math.max(requested ?? 8, 1), 20);
  try {
    const run = { duckduckgo: viaDuckDuckGo, exa: viaExa, brave: viaBrave, searxng: viaSearxng }[context.settings.backend];
    const hits = await run(trimmed, count, context);
    if (hits.length === 0) return { content: `No results for "${trimmed}" from ${context.settings.backend}. Try different words.` };
    const body = hits.map((hit, index) => `${index + 1}. ${hit.title}\n   ${hit.url}${hit.snippet ? `\n   ${hit.snippet}` : ""}`).join("\n\n");
    return { content: untrustedContext(`Results for "${trimmed}" (${context.settings.backend}):\n\n${body}`, `web:search/${context.settings.backend}`) };
  } catch (error) {
    if (error instanceof SearchSetupError || error instanceof WebError) return { content: error.message, isError: true };
    if (error instanceof SyntaxError) return { content: `${context.settings.backend} sent a reply that was not what was expected.`, isError: true };
    return { content: `The search failed: ${(error as Error).message.slice(0, 120)}`, isError: true };
  }
}
