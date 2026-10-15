/**
 * Reading and stopping the commands `bash run_in_background` started. The
 * commands themselves are the session's `BackgroundShells`, reached through the
 * tool context.
 */
import type { BackgroundTask } from "../background.js";
import type { HarnessTool, ToolResult } from "./types.js";

const MAX_WAIT_MS = 60_000;

const notAvailable: ToolResult = { content: "Background commands are not available here.", isError: true };

function describeState(task: BackgroundTask): string {
  switch (task.status) {
    case "running":
      return "still running";
    case "completed":
      return "finished (exit code 0)";
    case "stopped":
      return "stopped";
    case "failed":
      return task.exitCode === null ? "failed to run" : `finished with exit code ${task.exitCode}`;
  }
}

const unknownTask = (id: string): ToolResult => ({
  content: `There is no background task ${id}. Tasks started in an earlier session are gone, so start it again if you still need it.`,
  isError: true,
});

interface OutputArgs {
  task_id: string;
  wait_ms?: number;
}

export const taskOutputTool: HarnessTool<OutputArgs> = {
  readOnly: true,
  definition: {
    name: "task_output",
    description: [
      "Shows what a background task (a command started with bash and run_in_background, or a subagent started with run_in_background) has printed or written since you last looked, and whether it is still running.",
      "",
      `- With wait_ms (at most ${MAX_WAIT_MS}) it waits up to that long for new output or for the command to end, and returns as soon as either happens. Use it to wait for a server to be ready or a build to finish, instead of calling it again and again.`,
      "- Output you have already seen is not repeated. The whole log is in a file whose path is given.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The id returned when the task was started." },
        wait_ms: { type: "integer", description: "How long to wait for new output or the end, in milliseconds." },
      },
      required: ["task_id"],
    },
  },
  intent: () => ({ action: "read", paths: [] }),
  async run(args, context) {
    if (!context.background) return notAvailable;
    const waitMs = Math.min(Math.max(args.wait_ms ?? 0, 0), MAX_WAIT_MS);
    const seen = await context.background.read(args.task_id, { waitMs, signal: context.signal });
    if (seen === null) return unknownTask(args.task_id);
    const { task, output, cutBefore } = seen;
    const cut = cutBefore > 0 ? `[… ${cutBefore} earlier characters of new output not shown; the whole log is at ${task.logFile}]\n` : "";
    const body = output === "" ? "(no new output)" : `${cut}${output.replace(/\s+$/, "")}`;
    return { content: `${body}\n\n[${task.id} (${task.description}) ${describeState(task)}. Log: ${task.logFile}]` };
  },
};

interface StopArgs {
  task_id: string;
}

export const taskStopTool: HarnessTool<StopArgs> = {
  readOnly: false,
  definition: {
    name: "task_stop",
    description: "Stops a background task you started (a command or a subagent) and waits for it to end. Use it when it is no longer needed or is misbehaving.",
    parameters: {
      type: "object",
      properties: { task_id: { type: "string", description: "The id returned when the task was started." } },
      required: ["task_id"],
    },
  },
  // It ends a process the session started itself, so it is not a change that needs the user's approval.
  intent: () => ({ action: "read", paths: [] }),
  async run(args, context) {
    if (!context.background) return notAvailable;
    const task = context.background.get(args.task_id);
    if (!task) return unknownTask(args.task_id);
    if (task.status !== "running") return { content: `${task.id} had already ${describeState(task)}.` };
    await context.background.stop(task.id);
    return { content: `${task.id} (${task.description}) ${describeState(task)}.` };
  },
};
