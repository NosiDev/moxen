/**
 * The tools a provider ships with, and the setting that switches them off.
 *
 * `providers.<kind>.disabledNativeTools` is a comma-separated list of names,
 * like `mcpExclude`. The catalogue below is what the settings page and
 * `moxen config` offer; a name that is not in it is passed through as typed,
 * because the providers add tools faster than this table does.
 *
 * What is left out on purpose: the tools moxen's own settings already own
 * (the to-do list's `todos`, plan mode's enter and exit), and OpenCode's
 * session, worktree and browser utilities, which ask for no permission and so
 * have nothing to deny.
 */
export type NativeToolProvider = "claude" | "opencode";

export interface NativeTool {
  /** Claude: the tool's name, as `disallowedTools` takes it. OpenCode: the permission action. */
  readonly name: string;
  readonly label: string;
  readonly group: "Files" | "Commands" | "Web" | "Agents" | "Interaction" | "Automation";
  readonly summary: string;
}

export const CLAUDE_NATIVE_TOOLS: readonly NativeTool[] = [
  { name: "Read", label: "Read", group: "Files", summary: "Reads files." },
  { name: "Write", label: "Write", group: "Files", summary: "Creates or overwrites files." },
  { name: "Edit", label: "Edit", group: "Files", summary: "Makes targeted edits to files." },
  { name: "NotebookEdit", label: "Notebook edit", group: "Files", summary: "Edits Jupyter notebook cells." },
  { name: "Glob", label: "Glob", group: "Files", summary: "Finds files by pattern (absent by default on macOS and Linux)." },
  { name: "Grep", label: "Grep", group: "Files", summary: "Searches file contents (absent by default on macOS and Linux)." },
  { name: "LSP", label: "Language server", group: "Files", summary: "Definitions, references and type errors from language servers." },
  { name: "Bash", label: "Bash", group: "Commands", summary: "Runs shell commands." },
  { name: "PowerShell", label: "PowerShell", group: "Commands", summary: "Runs PowerShell commands." },
  { name: "Monitor", label: "Monitor", group: "Commands", summary: "Runs a command in the background and streams its output." },
  { name: "WebSearch", label: "Web search", group: "Web", summary: "Anthropic's web search." },
  { name: "WebFetch", label: "Web fetch", group: "Web", summary: "Fetches a URL and answers a prompt about it." },
  { name: "Agent", label: "Subagents", group: "Agents", summary: "Spawns a subagent. Moxen's Agents tab reads these." },
  { name: "SendMessage", label: "Send message", group: "Agents", summary: "Messages another agent or session." },
  { name: "Skill", label: "Skills", group: "Agents", summary: "Loads a skill." },
  { name: "AskUserQuestion", label: "Ask a question", group: "Interaction", summary: "Asks you multiple-choice questions." },
  { name: "PushNotification", label: "Notifications", group: "Interaction", summary: "Sends a desktop or phone notification." },
  { name: "EnterWorktree", label: "Enter worktree", group: "Automation", summary: "Creates or switches into a git worktree." },
  { name: "ExitWorktree", label: "Exit worktree", group: "Automation", summary: "Leaves a worktree session." },
  { name: "CronCreate", label: "Schedule", group: "Automation", summary: "Schedules a prompt inside the session." },
  { name: "CronDelete", label: "Unschedule", group: "Automation", summary: "Cancels a scheduled prompt." },
  { name: "CronList", label: "List schedules", group: "Automation", summary: "Lists scheduled prompts." },
];

/** OpenCode v2 names a tool by its permission action; an MCP tool's is `<server>_<tool>`, which `mcpExclude` owns. */
export const OPENCODE_NATIVE_TOOLS: readonly NativeTool[] = [
  { name: "read", label: "Read", group: "Files", summary: "Reads files." },
  { name: "edit", label: "Edit", group: "Files", summary: "Edit, write and patch." },
  { name: "glob", label: "Glob", group: "Files", summary: "Finds files by pattern." },
  { name: "grep", label: "Grep", group: "Files", summary: "Searches file contents." },
  { name: "shell", label: "Shell", group: "Commands", summary: "Runs shell commands." },
  { name: "execute", label: "Code mode", group: "Commands", summary: "Runs code that calls other tools." },
  { name: "websearch", label: "Web search", group: "Web", summary: "Searches the web through the selected integration." },
  { name: "webfetch", label: "Web fetch", group: "Web", summary: "Fetches a URL as markdown, text or HTML." },
  { name: "subagent", label: "Subagents", group: "Agents", summary: "Starts a child agent." },
  { name: "skill", label: "Skills", group: "Agents", summary: "Loads a skill." },
  { name: "question", label: "Ask a question", group: "Interaction", summary: "Asks you a question." },
];

export function nativeToolsOf(provider: NativeToolProvider): readonly NativeTool[] {
  return provider === "claude" ? CLAUDE_NATIVE_TOOLS : OPENCODE_NATIVE_TOOLS;
}

/**
 * The names a setting holds, with blanks and repeats dropped. (Not `parseNameList` from `mcp.ts`: that module
 * reaches `configschema.ts`, which reads this table, and a cycle there leaves the table unset on first use.)
 */
export function disabledNativeToolNames(setting: string | undefined): string[] {
  return [...new Set((setting ?? "").split(",").map((name) => name.trim()).filter((name) => name !== ""))];
}

export function isNativeToolDisabled(setting: string | undefined, name: string, provider: NativeToolProvider): boolean {
  const key = provider === "claude" ? name : name.toLowerCase();
  return disabledNativeToolNames(setting).some((entry) => (provider === "claude" ? entry : entry.toLowerCase()) === key);
}

/**
 * What an OpenCode server is started with so the tools stay off: `websearch:
 * false`, and a `deny` rule on `*` for every other action. Both take the tool
 * out of the model's list (checked on OpenCode 2.1.2: a model asked for its
 * tools no longer names them). Nothing when none is off.
 */
export function opencodeDisabledToolConfig(setting: string | undefined): { websearch?: false; permissions?: Array<{ action: string; resource: string; effect: "deny" }> } {
  const names = disabledNativeToolNames(setting).map((name) => name.toLowerCase());
  if (names.length === 0) return {};
  const denied = names.filter((name) => name !== "websearch");
  return {
    ...(names.includes("websearch") ? { websearch: false as const } : {}),
    ...(denied.length > 0 ? { permissions: denied.map((action) => ({ action, resource: "*", effect: "deny" as const })) } : {}),
  };
}
