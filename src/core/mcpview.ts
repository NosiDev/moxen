/**
 * The MCP server list as a client draws it, built in core so the TUI and the
 * CLI say the same thing. Secret values (`env`, `headers`) never leave here:
 * only their names do.
 */
import type { ListFieldView, ListItemView, ListResolvedRow } from "./configschema.js";
import { MCP_SERVER_FIELDS } from "./mcpschema.js";
import { parseNameList, type McpServerEntry } from "./mcp.js";
import type { CliConfig } from "./types.js";

export const HIDDEN = "<hidden>";

/** `KEY=<hidden>` lines for a secret map, or the plain values. */
export function formatPairs(value: unknown, secret: boolean): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const lines = Object.entries(value as Record<string, unknown>).map(([key, entry]) => `${key}=${secret ? HIDDEN : String(entry)}`);
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/** Words as typed: shell style quotes an argument with spaces. */
export function formatWords(value: unknown, separator: "comma" | "shell"): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const words = value.map(String);
  return separator === "comma" ? words.join(", ") : words.map((word) => (/[\s"']/.test(word) || word === "" ? JSON.stringify(word) : word)).join(" ");
}

function fieldView(path: string, entry: Record<string, unknown>): ListFieldView {
  const field = MCP_SERVER_FIELDS.find((candidate) => candidate.path === path)!;
  const raw = entry[path];
  let value: string | boolean | undefined;
  if (field.kind.type === "pairs") value = formatPairs(raw, field.kind.secret === true);
  else if (field.kind.type === "words") value = formatWords(raw, field.kind.separator);
  else value = typeof raw === "string" || typeof raw === "boolean" ? raw : undefined;
  return { path, value, explicit: value !== undefined };
}

function summary(entry: McpServerEntry): string {
  const where = entry.type === "http" ? entry.url : [entry.command, ...(entry.args ?? [])].join(" ");
  const who = entry.providers && entry.providers.length > 0 ? ` · ${entry.providers.join(", ")} only` : "";
  const hidden = entry.disabledTools && entry.disabledTools.length > 0 ? ` · ${entry.disabledTools.length} tool${entry.disabledTools.length === 1 ? "" : "s"} hidden` : "";
  return `${entry.type === "http" ? "http" : "program"} · ${where}${who}${hidden}`;
}

export function describeMcpServers(config: CliConfig): readonly ListItemView[] {
  return Object.entries(config.mcpServers ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, entry]) => ({
      id: name,
      title: name,
      summary: summary(entry),
      status:
        entry.disabled === true
          ? "Switched off: no provider gets this server."
          : name === MOXEN_SERVER
            ? "Replaces Moxen's built-in tools (delegate, task status, web_fetch) for every provider that gets it."
            : null,
      fields: MCP_SERVER_FIELDS.map((field) => fieldView(field.path, entry as unknown as Record<string, unknown>)),
      resolved: reach(config, name, entry),
    }));
}

/** The name Moxen's own tools go by; a configured server of that name stands in for them. */
const MOXEN_SERVER = "moxen";

const PROVIDER_NAMES = { claude: "Claude Code", opencode: "OpenCode", harness: "Moxen Harness" } as const;

/** Who gets a server, one row per provider, with where that is decided: the server's own switch, else that provider's checklist. */
function reach(config: CliConfig, name: string, entry: McpServerEntry): ListResolvedRow[] {
  return (Object.keys(PROVIDER_NAMES) as Array<keyof typeof PROVIDER_NAMES>).map((kind) => {
    const label = PROVIDER_NAMES[kind];
    if (entry.disabled === true) return { label, value: "No", origin: "this server is switched off" };
    const excluded = parseNameList(config.providers?.[kind]?.mcpExclude).includes(name);
    return excluded ? { label, value: "No", origin: `switched off under MCP servers on the ${label} tab` } : { label, value: "Gets it", origin: `MCP servers on the ${label} tab` };
  });
}
