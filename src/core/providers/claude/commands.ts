/**
 * Which of Claude Code's own slash commands Moxen offers.
 *
 * `supportedCommands` lists everything Claude Code can run as `/name`, and
 * marks all of its own as `builtin` — its bundled skills (`/code-review`,
 * `/simplify`, `/verify`, …) beside its real commands. The skills are just
 * prompts and work anywhere. Many of the commands do not: they configure the
 * interactive terminal app, sign in to an account, or reach into the session
 * Moxen owns, and sent as a prompt through the SDK they do nothing useful or
 * quietly do something Moxen did not ask for. Supporting them would mean
 * deep integration with one provider, which is not worth it, so they are not
 * offered. A user's, project's, plugin's or MCP server's own commands are
 * never touched.
 *
 * A deny-list rather than an allow-list on purpose: Claude Code adds bundled
 * skills often, and those should show up without a Moxen release.
 */

/** Claude Code built-ins left out, and why. */
export const UNSUPPORTED_CLAUDE_COMMANDS: ReadonlySet<string> = new Set([
  // Moxen owns the conversation and its session: a new conversation, the model, effort, speed, the title, the working directory.
  "clear",
  "model",
  "effort",
  "fast",
  "rename",
  "autocompact",
  "advisor",
  "goal",
  // Configure Claude Code's own interactive app, which is not what Moxen shows.
  "config",
  "color",
  "output-style",
  "focus",
  "agents",
  "list-agents",
  "mcp",
  "import",
  "reload-plugins",
  "reload-skills",
  "skill-doctor",
  "heapdump",
  "auto-mode-setup",
  // Account, plan and workspace setup, done in Claude Code itself.
  "usage-credits",
  "extra-usage",
  "design-consent",
  "design-revoke",
  "team-onboarding",
  // Cloud sessions and internal plumbing.
  "ultrareview",
  "insights",
  "workflow-launch-exec",
]);

/** Whether a command Claude Code lists should be offered. Only its own (`builtin`) are ever left out. */
export function isOfferedClaudeCommand(entry: { readonly name: string; readonly builtin?: boolean }): boolean {
  if (entry.builtin !== true) return true;
  return !entry.name.startsWith("__") && !UNSUPPORTED_CLAUDE_COMMANDS.has(entry.name);
}
