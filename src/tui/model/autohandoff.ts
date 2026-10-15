/**
 * When a long thread should move to a fresh one. Tool calls start to go
 * wrong well before the window is full, so past a share of it (half by
 * default) the thread is handed off: a new thread opened with a handoff
 * written from this one's ledger. Moxen does it, not the model, and only
 * when nothing is running that the new thread would lose track of.
 */
export type AutoHandoffMode = "off" | "ask" | "auto";

export const DEFAULT_AUTO_HANDOFF_MODE: AutoHandoffMode = "ask";
export const DEFAULT_AUTO_HANDOFF_PERCENT = 50;

export interface AutoHandoffInput {
  mode: AutoHandoffMode;
  percent: number;
  usedTokens: number | null;
  maxTokens: number | null;
  /** The assistant has said something there is to hand over. */
  hasReply: boolean;
  turnRunning: boolean;
  runningSubthreads: number;
  runningBackgroundTasks: number;
  queuedMessages: number;
}

export interface AutoHandoffState {
  /** Share of the window in use, 0–100. */
  usedPercent: number;
  /** What stops a handoff right now, as short phrases; empty when it can go. */
  blockers: string[];
}

/** Null while the thread is below the line (or the feature is off). */
export function autoHandoffState(input: AutoHandoffInput): AutoHandoffState | null {
  if (input.mode === "off" || !input.hasReply) return null;
  if (input.usedTokens === null || input.maxTokens === null || input.maxTokens <= 0) return null;
  const usedPercent = Math.round((input.usedTokens / input.maxTokens) * 100);
  if (usedPercent < input.percent) return null;
  const blockers: string[] = [];
  if (input.turnRunning) blockers.push("a turn is running");
  if (input.runningSubthreads > 0) blockers.push(`${input.runningSubthreads} subthread${input.runningSubthreads === 1 ? "" : "s"} running`);
  if (input.runningBackgroundTasks > 0) blockers.push(`${input.runningBackgroundTasks} background task${input.runningBackgroundTasks === 1 ? "" : "s"} running`);
  if (input.queuedMessages > 0) blockers.push("messages are queued");
  return { usedPercent, blockers };
}
