/**
 * The model's checklist for the task in hand. The whole list is sent every
 * time (it replaces the last one), so there is no id bookkeeping for a small
 * model to get wrong, and the harness can enforce the one rule that keeps the
 * list honest: a single item in progress.
 */
import type { HarnessTool, ToolResult } from "./types.js";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  readonly content: string;
  readonly status: TodoStatus;
}

const STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed"];
const MAX_ITEMS = 25;

interface TodoArgs {
  todos: unknown[];
}

const fail = (content: string): ToolResult => ({ content, isError: true });

/** The list as sent, or why it cannot be taken. */
export function parseTodos(raw: unknown[]): { ok: true; items: TodoItem[] } | { ok: false; error: string } {
  if (raw.length > MAX_ITEMS) return { ok: false, error: `A checklist of more than ${MAX_ITEMS} items is not a checklist. Group the work into fewer, larger steps.` };
  const items: TodoItem[] = [];
  for (const [index, entry] of raw.entries()) {
    const record = typeof entry === "object" && entry !== null && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null;
    const content = typeof record?.content === "string" ? record.content.trim() : "";
    if (content === "") return { ok: false, error: `Item ${index + 1} has no "content". Each item is {"content": "...", "status": "..."}.` };
    const status = record?.status;
    if (typeof status !== "string" || !STATUSES.includes(status as TodoStatus)) {
      return { ok: false, error: `Item ${index + 1} needs a "status" of ${STATUSES.join(", ")}.` };
    }
    items.push({ content, status: status as TodoStatus });
  }
  const active = items.filter((item) => item.status === "in_progress").length;
  if (active > 1) return { ok: false, error: `${active} items are in_progress. Exactly one item is in progress at a time; mark the others pending or completed and send the list again.` };
  return { ok: true, items };
}

/** `publish` shows the list to the user; the tool itself touches nothing else. */
export function todoTool(publish: (items: readonly TodoItem[]) => void): HarnessTool<TodoArgs> {
  return {
    readOnly: false,
    definition: {
      name: "todo",
      description: [
        "Keeps the checklist for the work in front of you and shows it to the user. Send the complete list every time; it replaces the previous one.",
        "",
        "- Use it when the work has three or more separate steps or the user asked for several things. Skip it for a quick fix, a lookup or a question.",
        "- Write a few steps, each a result worth reaching (\"Retry failed uploads in the client\"), not a motion (\"open the file\"). Never a single-step list.",
        "- Exactly one item is in_progress while you work. Mark an item completed as soon as it is done and the next one in_progress, in the same call.",
        "- Do not repeat the list in your replies; the user can see it.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "The whole checklist, in order.",
            items: {
              type: "object",
              properties: {
                content: { type: "string", description: "What the step achieves." },
                status: { type: "string", enum: [...STATUSES] },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["todos"],
      },
    },
    intent: () => ({ action: "read", paths: [] }),
    async run(args) {
      const parsed = parseTodos(args.todos);
      if (!parsed.ok) return fail(parsed.error);
      publish(parsed.items);
      const done = parsed.items.filter((item) => item.status === "completed").length;
      const next = parsed.items.find((item) => item.status === "in_progress") ?? parsed.items.find((item) => item.status === "pending");
      if (parsed.items.length === 0) return { content: "The checklist is cleared." };
      if (done === parsed.items.length) return { content: `The checklist is saved: all ${done} items are completed.` };
      return { content: `The checklist is saved: ${done} of ${parsed.items.length} completed${next ? `. Next: ${next.content}` : ""}.` };
    },
  };
}
