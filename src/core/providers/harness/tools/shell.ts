/**
 * Which shells a session can run commands in, and the environment they get.
 *
 * Off Windows there is one: bash (else sh). Windows has no bash of its own, so
 * the `bash` tool needs Git Bash (never WSL's `System32\bash.exe`, which runs
 * a different machine's filesystem) and the `powershell` tool runs PowerShell 7
 * when installed, else the Windows PowerShell that ships with the system.
 * Both are looked up once per process; a tool whose shell is missing is not
 * offered, so the model is never pointed at something it cannot call.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface ShellSpec {
  readonly kind: "posix" | "powershell";
  /** The tool name the model calls it by. */
  readonly tool: "bash" | "powershell";
  readonly program: string;
  /** The argv (after `program`) that runs one command. */
  argsFor(command: string): string[];
}

export interface ShellLookup {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly exists?: (file: string) => boolean;
}

export interface AvailableShells {
  readonly bash: ShellSpec | null;
  readonly powershell: ShellSpec | null;
}

const fileExists = (file: string): boolean => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

const posixShell = (program: string): ShellSpec => ({ kind: "posix", tool: "bash", program, argsFor: (command) => ["-c", command] });

const powershellShell = (program: string): ShellSpec => ({
  kind: "powershell",
  tool: "powershell",
  program,
  // UTF-8 output regardless of the console's code page, so the model does not read mojibake.
  argsFor: (command) => ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`],
});

/** The directories on PATH, in order, for the platform's separator. */
function pathDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const raw = env.PATH ?? env.Path ?? env.path ?? "";
  return raw.split(platform === "win32" ? ";" : ":").filter((dir) => dir !== "");
}

/** Git Bash on Windows: the usual install folders, then wherever `git.exe` is on PATH. */
function findGitBash(env: NodeJS.ProcessEnv, exists: (file: string) => boolean): string | null {
  const override = env.MOXEN_GIT_BASH;
  if (override && exists(override)) return override;
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432, env.LOCALAPPDATA ? path.win32.join(env.LOCALAPPDATA, "Programs") : undefined]
    .filter((root): root is string => typeof root === "string" && root !== "");
  for (const root of roots) {
    for (const rel of [["Git", "bin", "bash.exe"], ["Git", "usr", "bin", "bash.exe"]]) {
      const candidate = path.win32.join(root, ...rel);
      if (exists(candidate)) return candidate;
    }
  }
  for (const dir of pathDirs(env, "win32")) {
    if (!exists(path.win32.join(dir, "git.exe"))) continue;
    // …\Git\cmd\git.exe → …\Git\bin\bash.exe
    for (const rel of [["..", "bin", "bash.exe"], ["..", "usr", "bin", "bash.exe"]]) {
      const candidate = path.win32.normalize(path.win32.join(dir, ...rel));
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

function findWindowsPowerShell(env: NodeJS.ProcessEnv, exists: (file: string) => boolean): string | null {
  for (const dir of pathDirs(env, "win32")) {
    const candidate = path.win32.join(dir, "pwsh.exe");
    if (exists(candidate)) return candidate;
  }
  const system = env.SystemRoot ?? env.windir ?? "C:\\Windows";
  const builtin = path.win32.join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return exists(builtin) ? builtin : null;
}

export function findPosixShell(lookup: ShellLookup = {}): ShellSpec | null {
  const platform = lookup.platform ?? process.platform;
  const env = lookup.env ?? process.env;
  const exists = lookup.exists ?? fileExists;
  if (platform === "win32") {
    const gitBash = findGitBash(env, exists);
    return gitBash ? posixShell(gitBash) : null;
  }
  // $SHELL only when it speaks POSIX `-c` the way bash does (fish, nu and csh do not quote the same way).
  const preferred = env.SHELL && /(?:^|\/)(?:bash|zsh|sh|dash|ksh)$/.test(env.SHELL) ? env.SHELL : undefined;
  for (const candidate of [preferred, "/bin/bash", "/bin/sh"]) {
    if (candidate && exists(candidate)) return posixShell(candidate);
  }
  return posixShell("sh");
}

export function findPowerShell(lookup: ShellLookup = {}): ShellSpec | null {
  const platform = lookup.platform ?? process.platform;
  if (platform !== "win32") return null;
  const program = findWindowsPowerShell(lookup.env ?? process.env, lookup.exists ?? fileExists);
  return program ? powershellShell(program) : null;
}

let cached: AvailableShells | undefined;

/** The shells of this machine, looked up once. */
export function availableShells(lookup?: ShellLookup): AvailableShells {
  if (lookup) return { bash: findPosixShell(lookup), powershell: findPowerShell(lookup) };
  cached ??= { bash: findPosixShell(), powershell: findPowerShell() };
  return cached;
}

/** Forget the lookup (tests only). */
export function resetShellCache(): void {
  cached = undefined;
}

/**
 * Variables a command must not inherit: the keys Moxen itself reads to talk to
 * a model or a search service. Everything else (a `GITHUB_TOKEN` the user's own
 * tooling needs) stays, so `gh` and `npm publish` keep working.
 */
export const KNOWN_PROVIDER_KEY_VARS: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "XAI_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "EXA_API_KEY",
  "BRAVE_API_KEY",
  "BRAVE_SEARCH_API_KEY",
];

/** The environment for a command: the process's own, without `secretNames` (and the known provider keys) and with git quiet. */
export function commandEnv(secretNames: readonly string[] = [], base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const blocked = new Set([...KNOWN_PROVIDER_KEY_VARS, ...secretNames].map((name) => name.toUpperCase()));
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || blocked.has(name.toUpperCase())) continue;
    env[name] = value;
  }
  return { ...env, GIT_PAGER: "cat", PAGER: "cat", GIT_TERMINAL_PROMPT: "0" };
}

/** Signal a process group (a Windows process tree) by the pid that was spawned. Never matches by name. */
export function killGroup(pid: number | undefined, signal: NodeJS.Signals, platform: NodeJS.Platform = process.platform): void {
  if (pid === undefined) return;
  if (platform === "win32") {
    // No process groups: take the tree down by pid. Forceful only on the second, SIGKILL pass.
    const args = ["/pid", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])];
    try {
      spawn("taskkill", args, { stdio: "ignore", windowsHide: true }).on("error", () => undefined);
    } catch {
      // Already gone.
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}
