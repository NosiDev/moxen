/**
 * What a session knows besides its transcript, kept beside it so a restart
 * (or a resumed thread) carries on where it left off: the model's checklist and
 * what the user allowed "for this session". The transcript is append-only and
 * compaction rewrites it, so this lives in its own small file.
 */
import fs from "node:fs";
import path from "node:path";

import type { TodoItem } from "./tools/index.js";

export interface SessionState {
  readonly todos: readonly TodoItem[];
  readonly allowed: readonly string[];
}

const FORMAT = 1;
const STATUSES = new Set(["pending", "in_progress", "completed"]);

export function stateFile(directory: string, sessionId: string): string {
  return path.join(directory, "state", `${sessionId}.json`);
}

export function loadSessionState(directory: string, sessionId: string): SessionState {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(directory, sessionId), "utf8")) as { v?: number; todos?: unknown; allowed?: unknown };
    if (parsed.v !== FORMAT) return { todos: [], allowed: [] };
    const todos = Array.isArray(parsed.todos)
      ? parsed.todos.filter((item): item is TodoItem => typeof item === "object" && item !== null && typeof (item as TodoItem).content === "string" && STATUSES.has((item as TodoItem).status))
      : [];
    const allowed = Array.isArray(parsed.allowed) ? parsed.allowed.filter((key): key is string => typeof key === "string") : [];
    return { todos, allowed };
  } catch {
    return { todos: [], allowed: [] };
  }
}

/** Written whole through a temporary file, so a crash leaves the old state or the new one, never half. */
export function saveSessionState(directory: string, sessionId: string, state: SessionState): void {
  const file = stateFile(directory, sessionId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ v: FORMAT, todos: state.todos, allowed: state.allowed }), "utf8");
    fs.renameSync(temporary, file);
  } catch {
    // Losing the state costs a re-ask or a re-made checklist, not the session.
  }
}

/** A fork starts from the same state as its source. */
export function copySessionState(directory: string, from: string, to: string): void {
  const state = loadSessionState(directory, from);
  if (state.todos.length > 0 || state.allowed.length > 0) saveSessionState(directory, to, state);
}
