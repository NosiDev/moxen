/**
 * The MCP server list as a settings descriptor: which fields a server has and
 * how each is labelled. Only shapes live here; what a value may be is
 * `mcp.ts` (`parseMcpServers`), which `normalizeConfig` runs every edit through.
 */
import type { ListField, SettingChoice, SettingDescriptor } from "./configschema.js";

const choice = (value: string, label: string, description?: string): SettingChoice => (description === undefined ? { value, label } : { value, label, description });

export const MCP_SERVER_FIELDS: readonly ListField[] = [
  {
    path: "type",
    label: "Kind",
    description: "A program Moxen starts (stdio) or a server it connects to over HTTP. Unset: stdio, or HTTP when there is a URL and no command.",
    group: "Connection",
    kind: { type: "enum", choices: [choice("stdio", "Program", "Started on this machine; talks over standard input and output."), choice("http", "HTTP", "Connects to a URL.")] },
  },
  {
    path: "command",
    label: "Command",
    description: "The program to start, for example npx or uvx.",
    group: "Connection",
    kind: { type: "string", placeholder: "npx" },
  },
  {
    path: "args",
    label: "Arguments",
    description: "What to pass the command, separated by spaces; quote an argument that has spaces.",
    group: "Connection",
    kind: { type: "words", separator: "shell" },
  },
  {
    path: "url",
    label: "URL",
    description: "The server's address, for an HTTP server.",
    group: "Connection",
    kind: { type: "string", placeholder: "https://example.com/mcp" },
  },
  {
    path: "env",
    label: "Environment",
    description: "Variables the program starts with, one KEY=value per line. Values are never shown; type KEY=<hidden> to keep the one that is stored.",
    group: "Connection",
    kind: { type: "pairs", secret: true },
  },
  {
    path: "headers",
    label: "Headers",
    description: "Headers sent to an HTTP server, one Name=value per line (for a token: Authorization=Bearer …). Values are never shown.",
    group: "Connection",
    kind: { type: "pairs", secret: true },
  },
  {
    path: "providers",
    label: "Offered to",
    description: "Which providers get this server: claude, opencode, harness, separated by commas. Unset: all of them.",
    group: "Who gets it",
    kind: { type: "words", separator: "comma" },
  },
  {
    path: "disabledTools",
    label: "Hidden tools",
    description: "Tool names to hide from the model, separated by commas. Works for Claude Code and the Moxen Harness; OpenCode cannot hide single tools. Press t on the server to see its tools.",
    group: "Who gets it",
    kind: { type: "words", separator: "comma" },
  },
  {
    path: "disabled",
    label: "Switched off",
    description: "Keep the server in the list but give it to no one.",
    group: "Who gets it",
    kind: { type: "boolean" },
  },
];

export const MCP_SERVERS_SETTING: SettingDescriptor = {
  key: "mcpServers",
  label: "Servers",
  description: "MCP servers every thread can use. A project's moxen.json can add to or remove from this list. Applies from the next session.",
  section: "mcp",
  kind: { type: "list", noun: "server", keyed: true, add: "mcp-server", fields: MCP_SERVER_FIELDS, actions: ["duplicate", "test"] },
  defaultValue: undefined,
};
