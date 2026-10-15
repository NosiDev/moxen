/**
 * What a tool call needs before it runs. Reading is always allowed; whether
 * changing files or running commands is allowed or asked about follows the
 * thread's runtime mode. `acceptForSession` remembers a *pattern* rather than
 * the tool, so allowing `git status` once does not allow `git push`.
 */
import path from "node:path";

import type { RuntimeMode } from "../../types.js";
import { assessCommandLine, classifyPath, type Assessment } from "./commandsafety.js";
import type { ToolIntent } from "./tools/index.js";

export type PermissionNeed = "allow" | "ask";

export function permissionNeed(mode: RuntimeMode, intent: ToolIntent): PermissionNeed {
  if (intent.action === "read") return "allow";
  if (mode === "full-access" || mode === "auto") return "allow";
  if (intent.action === "edit" && mode === "auto-accept-edits") return "allow";
  return "ask";
}

export type PermissionVerdict =
  | { readonly kind: "allow" }
  /** The user is asked; `risk` is what the safety layer found, for the prompt. */
  | { readonly kind: "ask"; readonly risk?: Assessment }
  | { readonly kind: "deny"; readonly reason: string };

export interface PermissionContext {
  readonly mode: RuntimeMode;
  readonly intent: ToolIntent;
  readonly cwd: string;
  /** Somebody is there to answer a question. */
  readonly interactive: boolean;
  readonly shell?: "posix" | "powershell";
  readonly home?: string;
}

const REFUSED = (what: string, reason: string | undefined, mode: RuntimeMode): string =>
  `${what} was refused by Moxen's safety check${mode === "auto" ? " (Auto mode)" : ""}: ${reason ?? "it is too risky to run unattended"} Do not try to get the same result another way. Say what you wanted to do and why, and carry on with what you can still do.`;

/**
 * What a call needs, given the mode and, for commands and file changes, what
 * the safety layer thinks of them:
 * - Supervised asks about every change and command.
 * - Auto-accept edits lets file changes inside the project through and asks about commands.
 * - Auto lets safe calls through, asks about those that leave the machine (and refuses them when nobody can
 *   answer), and refuses what is dangerous.
 * - Full access trusts the model; only what would wipe the machine is refused.
 */
export function decidePermission(context: PermissionContext): PermissionVerdict {
  const { mode, intent } = context;
  if (intent.action === "read") return { kind: "allow" };
  if (intent.mcp === true || intent.web !== undefined) return permissionNeed(mode, intent) === "allow" ? { kind: "allow" } : { kind: "ask" };

  if (intent.action === "exec") {
    const risk = assessCommandLine(intent.command ?? "", { cwd: context.cwd, shell: context.shell ?? "posix", ...(context.home ? { home: context.home } : {}) });
    if (risk.level === "catastrophic") return { kind: "deny", reason: REFUSED("This command", risk.reason, mode) };
    if (mode === "full-access") return { kind: "allow" };
    if (mode === "auto") {
      if (risk.level === "safe") return { kind: "allow" };
      if (risk.level === "dangerous") return { kind: "deny", reason: REFUSED("This command", risk.reason, mode) };
      return context.interactive ? { kind: "ask", risk } : { kind: "deny", reason: REFUSED("This command", `${risk.reason ?? "It reaches outside the machine"} It needs the user's approval and nobody is here to give it.`, mode) };
    }
    return { kind: "ask", ...(risk.level === "safe" ? {} : { risk }) };
  }

  // A file change: judged by where it lands.
  const places = intent.paths.map((file) => classifyPath(file, { cwd: context.cwd, ...(context.home ? { home: context.home } : {}) }));
  const protectedPlace = places.find((place) => place === "secret" || place === "startup" || place === "system" || place === "root" || place === "git");
  if (mode === "full-access") return protectedPlace === "secret" || protectedPlace === "startup" || protectedPlace === "system" || protectedPlace === "root" ? { kind: "ask" } : { kind: "allow" };
  if (mode === "approval-required") return { kind: "ask" };
  const outside = places.some((place) => place !== "cwd" && place !== "tmp");
  if (mode === "auto-accept-edits") return outside ? { kind: "ask" } : { kind: "allow" };
  // Auto
  if (protectedPlace !== undefined) {
    const where = protectedPlace === "git" ? ".git internals" : protectedPlace === "secret" ? "credentials" : protectedPlace === "startup" ? "a shell startup file" : "a system folder";
    return { kind: "deny", reason: REFUSED("This file change", `It would change ${where}.`, mode) };
  }
  if (!outside) return { kind: "allow" };
  return context.interactive ? { kind: "ask" } : { kind: "deny", reason: REFUSED("This file change", "It is outside the working directory and nobody is here to approve it.", mode) };
}

/** The vocabulary the clients' approval prompt switches on (shared with the Claude driver's classifications). */
export function classificationOf(intent: ToolIntent): "command-execution" | "file-change" | "file-read" {
  return intent.action === "exec" ? "command-execution" : intent.action === "edit" ? "file-change" : "file-read";
}

const SHELL_META = /[;&|<>`$(){}\n\\*?!~]/;
/** Programs whose second word is the verb, and the verbs that only build, check or read. */
const VERBS: Readonly<Record<string, ReadonlySet<string>>> = {
  git: new Set(["status", "diff", "log", "show", "blame"]),
  cargo: new Set(["build", "test", "check", "clippy", "fmt"]),
  go: new Set(["build", "test", "vet", "fmt"]),
};
/** Package managers and runners: `<tool> run <script>` and `<tool> test` are the project's own scripts. */
const SCRIPT_RUNNERS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun", "deno"]);

/** The part of a command an "allow for this session" answer covers. Anything not plainly simple is itself, exactly. */
export function commandPattern(command: string): string {
  const trimmed = command.trim().replace(/\s+/g, " ");
  if (SHELL_META.test(trimmed)) return trimmed;
  const [program = "", second = "", third = ""] = trimmed.split(" ");
  const verbs = VERBS[program];
  if (verbs?.has(second) === true) return `${program} ${second}`;
  if (SCRIPT_RUNNERS.has(program)) {
    if (second === "test") return `${program} test`;
    if (second === "run" && third !== "" && !third.startsWith("-")) return `${program} run ${third}`;
  }
  return trimmed;
}

const inside = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/**
 * The key an "allow for this session" answer is remembered under. File tools
 * are covered per tool for everything in the working directory, and per
 * folder outside it; shell commands per `commandPattern`; an MCP tool by name.
 */
export function sessionAllowKey(tool: string, intent: ToolIntent, cwd: string): string {
  // An MCP tool is trusted or not as a whole: what it is called with says nothing about what it will do.
  if (intent.mcp === true) return `mcp:${tool}`;
  // A web host is allowed or not, whichever of the web tools reaches it.
  if (intent.web !== undefined) return `web:${intent.web.host.toLowerCase()}`;
  if (intent.action === "exec") return `${tool}:${commandPattern(intent.command ?? "")}`;
  const scopes = new Set(intent.paths.map((file) => (inside(cwd, file) ? "in the working directory" : path.dirname(file))));
  return `${tool}:${[...scopes].sort().join("|")}`;
}

export const declinedMessage = (tool: string): string =>
  `The user declined this ${tool} call. Do not try to reach the same result another way (another tool, a script, a changed setting). Say what was blocked and carry on with what you can still do.`;

export const CANCELLED_MESSAGE = "The user stopped the turn.";
