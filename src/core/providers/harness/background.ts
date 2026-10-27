/**
 * Commands the model started with `bash` or `powershell` and `run_in_background`: they outlive the
 * call that started them, write what they print to a log under the artifact
 * directory, and are read back and stopped through `task_output` / `task_stop`.
 *
 * Each runs in its own process group and is stopped by the pid that was
 * spawned, never by matching a name. They end with the session (`stopAll`);
 * an interrupted turn leaves them running, as it would a server the user
 * started in another terminal, and the tasks panel can stop them.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { commandEnv, killGroup, type ShellSpec } from "./tools/shell.js";

export type BackgroundStatus = "running" | "completed" | "failed" | "stopped";

export interface BackgroundTask {
  readonly id: string;
  readonly command: string;
  /** The tool that started it: `bash` or `powershell`. */
  readonly tool: string;
  readonly description: string;
  readonly toolUseId: string | null;
  readonly startedAt: string;
  readonly logFile: string;
  status: BackgroundStatus;
  exitCode: number | null;
}

export type BackgroundEvent = { readonly type: "started" | "ended"; readonly task: BackgroundTask };

interface Entry {
  readonly task: BackgroundTask;
  readonly pid: number | undefined;
  /** Bytes written to the log; past `MAX_LOG_BYTES` the rest is dropped. */
  written: number;
  /** Where the model's last `task_output` read stopped. */
  readUpTo: number;
  stopRequested: boolean;
  exited: boolean;
  /** The model has read the log after the command ended, so it already knows. */
  endSeen: boolean;
  readonly exit: Promise<void>;
  readonly waiters: Set<() => void>;
  /** Not a process: a subagent running in this process. Stopping it calls this. */
  readonly external?: { readonly stop: () => void };
}

export const MAX_RUNNING = 8;
const MAX_KEPT = 50;
const MAX_LOG_BYTES = 20_000_000;
/** What one `task_output` shows at most; the log file holds the rest. */
const MAX_SHOWN_CHARS = 28_000;
const STOP_GRACE_MS = 2000;

export class BackgroundShells {
  readonly #entries = new Map<string, Entry>();
  readonly #logDir: string;
  readonly #onEvent: (event: BackgroundEvent) => void;
  #closed = false;

  constructor(options: { readonly artifactDir: string; readonly onEvent: (event: BackgroundEvent) => void }) {
    this.#logDir = options.artifactDir;
    this.#onEvent = options.onEvent;
  }

  /** Start a command. Throws a message for the model when it cannot (too many running, or the session is closing). */
  start(input: { readonly command: string; readonly cwd: string; readonly shell: ShellSpec; readonly secretEnv?: readonly string[] | undefined; readonly description: string; readonly toolUseId: string | null }): BackgroundTask {
    if (this.#closed) throw new Error("The session is closing, so nothing can be started.");
    if (this.running().length >= MAX_RUNNING) {
      throw new Error(`${MAX_RUNNING} background commands are already running. Stop one with task_stop, or wait for one to finish, before starting another.`);
    }
    const id = `bg_${randomBytes(3).toString("hex")}`;
    fs.mkdirSync(this.#logDir, { recursive: true });
    const logFile = path.join(this.#logDir, `${id}.log`);
    fs.writeFileSync(logFile, "");
    const task: BackgroundTask = { id, command: input.command, tool: input.shell.tool, description: input.description, toolUseId: input.toolUseId, startedAt: new Date().toISOString(), logFile, status: "running", exitCode: null };
    const child = spawn(input.shell.program, input.shell.argsFor(input.command), {
      cwd: input.cwd,
      env: commandEnv(input.secretEnv),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let finished!: () => void;
    const exit = new Promise<void>((resolve) => (finished = resolve));
    const entry: Entry = { task, pid: child.pid, written: 0, readUpTo: 0, stopRequested: false, exited: false, endSeen: false, exit, waiters: new Set() };
    this.#entries.set(id, entry);

    const append = (data: Buffer | string): void => {
      if (entry.written >= MAX_LOG_BYTES) return;
      const chunk = typeof data === "string" ? Buffer.from(data) : data.subarray(0, MAX_LOG_BYTES - entry.written);
      try {
        fs.appendFileSync(logFile, chunk);
        entry.written += chunk.length;
      } catch {
        // A full disk costs the log, not the session.
      }
      this.#wake(entry);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const end = (status: BackgroundStatus, code: number | null): void => {
      if (entry.exited) return;
      entry.exited = true;
      task.status = status;
      task.exitCode = code;
      this.#wake(entry);
      this.#forget();
      this.#onEvent({ type: "ended", task });
      finished();
    };
    child.on("error", (error) => {
      append(`Could not run the command: ${error.message}\n`);
      end("failed", null);
    });
    child.on("close", (code) => end(entry.stopRequested ? "stopped" : code === 0 ? "completed" : "failed", code));
    // Something the command started can outlive it and keep the pipes open (on Windows a tree is
    // killed by parent pid, which an orphan escapes), so "close" never comes. A stop does not wait for it.
    child.on("exit", (code) => {
      if (!entry.stopRequested) return;
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        end("stopped", code);
      }, 500).unref();
    });
    this.#onEvent({ type: "started", task });
    return task;
  }

  /**
   * A task that is not a process: a subagent running in this process. It gets a
   * log like a command does (its progress, then its report), is read with
   * `task_output`, stopped with `task_stop` (which calls `stop`), and is
   * announced when it ends the same way.
   */
  startExternal(input: {
    readonly id: string;
    readonly tool: string;
    readonly description: string;
    readonly toolUseId: string | null;
    readonly stop: () => void;
  }): { readonly task: BackgroundTask; readonly append: (text: string) => void; readonly end: (status: BackgroundStatus) => void } {
    if (this.#closed) throw new Error("The session is closing, so nothing can be started.");
    if (this.running().length >= MAX_RUNNING) {
      throw new Error(`${MAX_RUNNING} background tasks are already running. Stop one with task_stop, or wait for one to finish, before starting another.`);
    }
    fs.mkdirSync(this.#logDir, { recursive: true });
    const logFile = path.join(this.#logDir, `${input.id}.log`);
    fs.writeFileSync(logFile, "");
    const task: BackgroundTask = { id: input.id, command: input.description, tool: input.tool, description: input.description, toolUseId: input.toolUseId, startedAt: new Date().toISOString(), logFile, status: "running", exitCode: null };
    let finished!: () => void;
    const exit = new Promise<void>((resolve) => (finished = resolve));
    const entry: Entry = { task, pid: undefined, written: 0, readUpTo: 0, stopRequested: false, exited: false, endSeen: false, exit, waiters: new Set(), external: { stop: input.stop } };
    this.#entries.set(task.id, entry);
    const append = (text: string): void => {
      if (entry.written >= MAX_LOG_BYTES) return;
      const chunk = Buffer.from(text).subarray(0, MAX_LOG_BYTES - entry.written);
      try {
        fs.appendFileSync(logFile, chunk);
        entry.written += chunk.length;
      } catch {
        // A full disk costs the log, not the session.
      }
      this.#wake(entry);
    };
    const end = (status: BackgroundStatus): void => {
      if (entry.exited) return;
      entry.exited = true;
      task.status = entry.stopRequested && status !== "completed" ? "stopped" : status;
      this.#wake(entry);
      this.#forget();
      this.#onEvent({ type: "ended", task });
      finished();
    };
    this.#onEvent({ type: "started", task });
    return { task, append, end };
  }

  /** Commands still running, oldest first. */
  running(): BackgroundTask[] {
    return [...this.#entries.values()].filter((entry) => !entry.exited).map((entry) => entry.task);
  }

  get(id: string): BackgroundTask | undefined {
    return this.#entries.get(id)?.task;
  }

  #wake(entry: Entry): void {
    for (const waiter of [...entry.waiters]) waiter();
  }

  /** Finished commands are kept to be read after they end, but not without limit. */
  #forget(): void {
    const finished = [...this.#entries.values()].filter((entry) => entry.exited);
    for (const entry of finished.slice(0, Math.max(0, finished.length - MAX_KEPT))) this.#entries.delete(entry.task.id);
  }

  /** What the command printed since the last time this was asked, optionally waiting for something to happen first (output, or the end). */
  async read(id: string, options: { readonly waitMs: number; readonly signal: AbortSignal }): Promise<{ readonly task: BackgroundTask; readonly output: string; readonly cutBefore: number } | null> {
    const entry = this.#entries.get(id);
    if (!entry) return null;
    if (options.waitMs > 0 && !entry.exited && entry.written <= entry.readUpTo && !options.signal.aborted) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          entry.waiters.delete(done);
          options.signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, options.waitMs);
        entry.waiters.add(done);
        options.signal.addEventListener("abort", done, { once: true });
      });
    }
    const fresh = this.#slice(entry, entry.readUpTo, entry.written);
    entry.readUpTo = entry.written;
    if (entry.exited) entry.endSeen = true;
    const over = Math.max(0, fresh.length - MAX_SHOWN_CHARS);
    return { task: entry.task, output: over > 0 ? fresh.slice(over) : fresh, cutBefore: over };
  }

  /** Whether the model has read a command's output since it ended. */
  endSeen(id: string): boolean {
    return this.#entries.get(id)?.endSeen === true;
  }

  /** The last `lines` lines of the log, for a client's panel. Null for a command this session never ran. */
  tail(id: string, lines: number): string[] | null {
    const entry = this.#entries.get(id);
    if (!entry) return null;
    const text = this.#slice(entry, Math.max(0, entry.written - 200_000), entry.written);
    const all = text.split("\n");
    if (all.at(-1) === "") all.pop();
    return all.slice(-lines);
  }

  #slice(entry: Entry, from: number, to: number): string {
    if (to <= from) return "";
    try {
      const fd = fs.openSync(entry.task.logFile, "r");
      try {
        const buffer = Buffer.alloc(to - from);
        const read = fs.readSync(fd, buffer, 0, buffer.length, from);
        return buffer.subarray(0, read).toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return "";
    }
  }

  /** Stop a running command and wait for it to end. False when there was nothing running by that id. */
  async stop(id: string): Promise<boolean> {
    const entry = this.#entries.get(id);
    if (!entry || entry.exited) return false;
    this.#signal(entry);
    await Promise.race([entry.exit, new Promise<void>((resolve) => setTimeout(resolve, STOP_GRACE_MS + 3000).unref())]);
    return true;
  }

  #signal(entry: Entry): void {
    if (entry.stopRequested) return;
    entry.stopRequested = true;
    if (entry.external) {
      entry.external.stop();
      return;
    }
    killGroup(entry.pid, "SIGTERM");
    // Only the pid that was spawned, and only while it has not been seen to exit: a number that was freed must not be signalled.
    setTimeout(() => {
      if (!entry.exited) killGroup(entry.pid, "SIGKILL");
    }, STOP_GRACE_MS).unref();
  }

  /** The session is ending: signal everything that runs now, and start nothing more. */
  stopAll(): void {
    this.#closed = true;
    for (const entry of this.#entries.values()) if (!entry.exited) this.#signal(entry);
  }
}
