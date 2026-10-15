/**
 * Runs a shell command (bash, or PowerShell on Windows) in the thread's working directory. No stdin (a command
 * that waits for input fails instead of hanging the turn), a timeout, process
 * group kill on timeout or interrupt, and output bounded to head and tail with
 * the full text saved for the model to read in pieces.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { commandEnv, findPosixShell, killGroup, type ShellSpec } from "./shell.js";
import type { HarnessTool, ToolResult } from "./types.js";

export { killGroup };

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const KEEP_HEAD = 10_000;
const KEEP_TAIL = 18_000;
const MAX_CAPTURE = 8_000_000;

interface BashArgs {
  command: string;
  timeout?: number;
  description?: string;
  run_in_background?: boolean;
}

/** Bound the text the model sees; the whole of it goes to a file when it is cut. `label` starts the file's name. */
export function boundOutput(text: string, artifactDir: string, label = "bash"): string {
  if (text.length <= KEEP_HEAD + KEEP_TAIL) return text;
  let saved = "";
  try {
    fs.mkdirSync(artifactDir, { recursive: true });
    const file = path.join(artifactDir, `${label}-${Date.now()}-${randomBytes(3).toString("hex")}.log`);
    fs.writeFileSync(file, text, "utf8");
    saved = ` The full output is saved at ${file}; read it in pieces with offset and limit.`;
  } catch {
    // Without the file the cut text is all there is.
  }
  const omitted = text.length - KEEP_HEAD - KEEP_TAIL;
  return `${text.slice(0, KEEP_HEAD)}\n\n[… ${omitted} characters omitted.${saved}]\n\n${text.slice(text.length - KEEP_TAIL)}`;
}

/** The `bash` or `powershell` tool for one shell. They differ only in the program and in what the description says about it. */
export function makeShellTool(shell: ShellSpec): HarnessTool<BashArgs> {
  const powershell = shell.kind === "powershell";
  const name = shell.tool;
  return {
  readOnly: false,
  definition: {
    name,
    description: [
      powershell
        ? "Runs a PowerShell command in the working directory and returns its combined output and exit code. Use it for builds, tests, git, package managers and other terminal work on Windows."
        : "Runs a shell command in the working directory and returns its combined output and exit code. Use it for builds, tests, git, package managers and other terminal work.",
      "",
      "- Do not use it to read, search, find or edit files; use read, grep, glob, edit and write, which are cheaper and safer to review.",
      powershell
        ? "- Write PowerShell, not cmd or bash: Get-ChildItem, Set-Location, $env:NAME, `;` between statements (not `&&` in Windows PowerShell 5), and quote paths with spaces."
        : "- Prefer absolute paths over cd.",
      "- Each call starts a fresh shell, so cd and exports do not carry over.",
      `- Commands time out after ${DEFAULT_TIMEOUT_MS / 1000}s by default (timeout in milliseconds, at most ${MAX_TIMEOUT_MS / 1000}s). Standard input is closed, so use non-interactive flags (e.g. npm init -y).`,
      "- Long output is cut to its start and end; the full text is saved to a file whose path is given.",
      ...(powershell ? [] : ["- Quote paths that contain spaces."]),
      "- For a command that keeps running (a dev server, a watcher, a long test run) set run_in_background: it returns at once with an id, and the command runs until it ends or you stop it. Read its output with task_output and stop it with task_stop. You are told when it ends. The timeout does not apply to it.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run." },
        timeout: { type: "integer", description: "Timeout in milliseconds." },
        description: { type: "string", description: "A short sentence saying what the command does." },
        run_in_background: { type: "boolean", description: "Start the command and return at once instead of waiting for it to end." },
      },
      required: ["command"],
    },
  },
  intent: (args, context) => ({ action: "exec", paths: [context.cwd], command: args.command }),
  async run(args, context): Promise<ToolResult> {
    if (args.run_in_background === true) {
      if (!context.background) return { content: "Background commands are not available here. Run the command without run_in_background.", isError: true };
      try {
        const task = context.background.start({ command: args.command, cwd: context.cwd, shell, secretEnv: context.secretEnv, description: args.description?.trim() || args.command.slice(0, 80), toolUseId: context.callId ?? null });
        return { content: `Started ${task.id} in the background. Its output is written to ${task.logFile}. Read it with task_output (with wait_ms to wait for something to happen) and stop it with task_stop; you will be told when it ends.` };
      } catch (error) {
        return { content: (error as Error).message, isError: true };
      }
    }
    const timeoutMs = Math.min(Math.max(args.timeout ?? DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
    return await new Promise<ToolResult>((resolve) => {
      const child = spawn(shell.program, shell.argsFor(args.command), {
        cwd: context.cwd,
        env: commandEnv(context.secretEnv),
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      const chunks: Buffer[] = [];
      let captured = 0;
      let reason: "timeout" | "interrupted" | null = null;
      const collect = (data: Buffer): void => {
        if (captured >= MAX_CAPTURE) return;
        chunks.push(data);
        captured += data.length;
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);

      const stop = (why: "timeout" | "interrupted"): void => {
        if (reason !== null) return;
        reason = why;
        killGroup(child.pid, "SIGTERM");
        setTimeout(() => killGroup(child.pid, "SIGKILL"), 2000).unref();
      };
      const timer = setTimeout(() => stop("timeout"), timeoutMs);
      const onAbort = (): void => stop("interrupted");
      if (context.signal.aborted) onAbort();
      else context.signal.addEventListener("abort", onAbort, { once: true });

      const finish = (code: number | null, spawnError?: Error): void => {
        clearTimeout(timer);
        context.signal.removeEventListener("abort", onAbort);
        const raw = Buffer.concat(chunks).toString("utf8").replace(/\s+$/, "");
        const output = boundOutput(raw, context.artifactDir);
        if (spawnError) return resolve({ content: `Could not run the command: ${spawnError.message}`, isError: true });
        if (reason === "timeout") {
          return resolve({ content: `${output}${output ? "\n\n" : ""}[The command timed out after ${Math.round(timeoutMs / 1000)}s and was stopped.]`, isError: true });
        }
        if (reason === "interrupted") return resolve({ content: `${output}${output ? "\n\n" : ""}[The command was interrupted.]`, isError: true });
        if (code !== 0) return resolve({ content: `${output}${output ? "\n\n" : ""}[exit code ${code ?? "unknown"}]`, isError: true });
        resolve({ content: output === "" ? "(no output)" : output });
      };
      child.on("error", (error) => finish(null, error));
      child.on("close", (code) => finish(code));
    });
  },
};
}

/** The `bash` tool for this machine's POSIX shell (what tests and non-Windows callers use). */
export const bashTool: HarnessTool<BashArgs> = makeShellTool(findPosixShell() ?? { kind: "posix", tool: "bash", program: "sh", argsFor: (command) => ["-c", command] });
