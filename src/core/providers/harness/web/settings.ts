import type { HarnessProviderConfig } from "../../../types.js";
import type { BrowserSettings } from "./browser.js";
import { SEARCH_BACKENDS, type SearchBackend, type SearchSettings } from "./search.js";

/** What the web tools read, once per call, so a setting changed in the app applies to the next call. */
export interface WebSettings {
  readonly search: SearchSettings;
  readonly browser: BrowserSettings;
  readonly allowPrivate: boolean;
  readonly env: NodeJS.ProcessEnv;
}

export function resolveWebSettings(config: HarnessProviderConfig | undefined, env: NodeJS.ProcessEnv): WebSettings {
  const backend = SEARCH_BACKENDS.includes(config?.webSearch as SearchBackend) ? (config!.webSearch as SearchBackend) : "duckduckgo";
  return {
    search: { backend, keyEnv: config?.webSearchKeyEnv, keyRef: config?.webSearchKey, searxngUrl: config?.searxngUrl },
    browser: { mode: config?.webBrowser === "off" ? "off" : "auto", path: config?.webBrowserPath || undefined },
    allowPrivate: config?.webPrivateNetwork === true,
    env,
  };
}
