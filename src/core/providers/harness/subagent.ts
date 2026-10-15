/**
 * What a subagent is made of: the tools it gets, its role in the prompt, and
 * how its saved conversation reads back for a client. The nested loop itself
 * runs in the driver, which holds the session it borrows permissions from.
 */
import type { SubagentHistoryItem } from "../spi.js";
import type { HarnessTool } from "./tools/index.js";
import type { TranscriptMessage } from "./types.js";

/** Tools a subagent never gets: it cannot ask the user, plan, keep the parent's to-do list or start more subagents. Moxen's own delegation tools stay with the parent too. */
const EXCLUDED = new Set(["subagent", "ask", "todo", "enter_plan_mode", "exit_plan_mode"]);
const MOXEN_TOOL_PREFIX = "mcp__moxen__";

/** The tools a subagent gets from the parent's: all of them but the few above, MCP tools included. */
export function subagentTools(all: readonly HarnessTool<never>[]): HarnessTool<never>[] {
  return all.filter((tool) => !EXCLUDED.has(tool.definition.name) && !tool.definition.name.startsWith(MOXEN_TOOL_PREFIX));
}

/** A subagent's brief. The kind is guidance for the model, not a restriction: what it may do is the parent's permissions. */
export function subagentRole(kind: string | undefined): string {
  const label = (kind ?? "").trim().toLowerCase();
  return [
    "# Your role",
    "You are a subagent. Another agent gave you one task and cannot be asked about it; the user is not here either. If something is unclear, take the most reasonable reading and say that you did.",
    label === "explore" || label === "research" || label === "review"
      ? "Your task is to look, not to change: read and search, and do not edit files or run commands that change anything unless the task says to."
      : "Keep to the task you were given and change only what it needs.",
    "When you finish, your last message is your report. It is all the other agent sees of your work, so lead with the answer, give the files and lines (path:line) and facts it needs, and say what you did not check or could not do. Do not paste large pieces of files back.",
  ].join("\n");
}

/** A subagent's saved conversation as the entries a client lists; tool results are paired with their calls. */
export function subagentHistory(messages: readonly TranscriptMessage[], agentId: string): SubagentHistoryItem[] {
  const results = new Map<string, Extract<TranscriptMessage, { role: "tool" }>>();
  for (const message of messages) if (message.role === "tool") results.set(message.toolCallId, message);
  const items: SubagentHistoryItem[] = [];
  let prompted = false;
  messages.forEach((message, index) => {
    const id = `${agentId}:${index}`;
    if (message.role === "user" && !prompted && message.content.trim() !== "") {
      prompted = true;
      items.push({ kind: "prompt", id, at: null, text: message.content });
    } else if (message.role === "assistant") {
      if (message.reasoning?.trim()) items.push({ kind: "reasoning", id: `${id}:r`, at: null, text: message.reasoning });
      if (message.content.trim()) items.push({ kind: "text", id: `${id}:t`, at: null, text: message.content });
      for (const call of message.toolCalls ?? []) {
        let input: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(call.arguments);
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
        } catch {
          // The call as the model sent it was not an object; the entry shows none.
        }
        const result = results.get(call.id);
        items.push({ kind: "tool", id: call.id, at: null, tool: call.name, raw: { toolUseId: call.id, input, output: result?.content ?? null, isError: result?.isError === true } });
      }
    }
  });
  return items;
}
