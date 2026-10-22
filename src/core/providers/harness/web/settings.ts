import type { HarnessProviderConfig, KeyedSearchBackend, WebConfig } from "../../../types.js";
import type { BrowserSettings } from "./browser.js";
import { SEARCH_BACKENDS, type SearchBackend, type SearchSettings } from "./search.js";

/** What the web tools read, once per call, so a setting changed in the app applies to the next call. */
export interface WebSettings {
  readonly search: SearchSettings;
  readonly browser: BrowserSettings;
  readonly allowPrivate: boolean;
  readonly env: NodeJS.ProcessEnv;
}

/** How a web tool may reach the web: shared by the Harness's tools and the `web_fetch` Moxen offers every provider. */
export interface WebPolicy {
  readonly browser: BrowserSettings;
  readonly allowPrivate: boolean;
}

/**
 * The shared `web` settings, falling back to the Harness's older keys where
 * they are unset, so a file written before they were shared means what it
 * did. The older private-network switch opened the Harness's tools only, so
 * it still opens nothing else; `web.privateNetwork` is one switch for all.
 */
export function webPolicy(web: WebConfig | undefined, harness: HarnessProviderConfig | undefined, forHarness: boolean): WebPolicy {
  const mode = web?.browser ?? harness?.webBrowser;
  return {
    browser: { mode: mode === "off" ? "off" : "auto", path: (web?.browserPath ?? harness?.webBrowserPath) || undefined },
    allowPrivate: web?.privateNetwork ?? (forHarness && harness?.webPrivateNetwork === true),
  };
}

/** Whether the per-service key slots are in use; while none is, the older single slot stands for the selected service. */
export function usesPerServiceKeys(harness: HarnessProviderConfig | undefined): boolean {
  return Object.keys(harness?.webSearchKeys ?? {}).length > 0 || Object.keys(harness?.webSearchKeyEnvs ?? {}).length > 0;
}

/** The key a search service uses: its own slot, else (in a file from before there was one per service) the single older slot. */
export function searchKeyFor(harness: HarnessProviderConfig | undefined, backend: SearchBackend): { keyRef?: string; keyEnv?: string } {
  if (backend !== "exa" && backend !== "brave") return {};
  const keyed = backend satisfies KeyedSearchBackend;
  if (usesPerServiceKeys(harness)) {
    const keyRef = harness?.webSearchKeys?.[keyed];
    const keyEnv = harness?.webSearchKeyEnvs?.[keyed];
    return { ...(keyRef ? { keyRef } : {}), ...(keyEnv ? { keyEnv } : {}) };
  }
  return { ...(harness?.webSearchKey ? { keyRef: harness.webSearchKey } : {}), ...(harness?.webSearchKeyEnv ? { keyEnv: harness.webSearchKeyEnv } : {}) };
}

export function resolveWebSettings(config: HarnessProviderConfig | undefined, env: NodeJS.ProcessEnv, web?: WebConfig): WebSettings {
  const backend = SEARCH_BACKENDS.includes(config?.webSearch as SearchBackend) ? (config!.webSearch as SearchBackend) : "duckduckgo";
  return {
    search: { backend, ...searchKeyFor(config, backend), searxngUrl: config?.searxngUrl },
    ...webPolicy(web, config, true),
    env,
  };
}
