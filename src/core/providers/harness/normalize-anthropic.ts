/**
 * Transcript to Anthropic Messages API input. Like `normalize.ts` for chat
 * endpoints, this is the one place that knows how that wire format wants a
 * conversation: one top-level `system` string, tool calls as `tool_use` blocks
 * and their results as `tool_result` blocks at the start of the next user
 * message (all of a round's results in one message), reasoning as signed
 * `thinking` blocks that must go back untouched. It never changes the transcript.
 */
import { createHash } from "node:crypto";

import type { ModelQuirks } from "./quirks.js";
import { wrapSystemReminder } from "./normalize.js";
import type { ReasoningItem, ToolDefinition, TranscriptMessage } from "./types.js";

export type AnthropicBlock = Record<string, unknown> & { type: string };
export interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicBlock[];
}

const TOOL_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** An id both Anthropic and OpenAI accept (letters, digits, `_`, `-`, at most 64), stable for the same original so a call and its result agree. */
export function portableToolId(id: string, rule: ModelQuirks["toolCallId"] = {}): string {
  const fits =
    TOOL_ID.test(id) &&
    (rule.alphanumericOnly !== true || /^[A-Za-z0-9]+$/.test(id)) &&
    (rule.exactLength === undefined || id.length === rule.exactLength) &&
    (rule.maxLength === undefined || id.length <= rule.maxLength);
  if (fits) return id;
  const digest = createHash("sha256").update(id).digest("base64url").replace(/[^A-Za-z0-9]/g, "");
  return digest.slice(0, Math.min(rule.exactLength ?? rule.maxLength ?? 32, 64, digest.length));
}

function parsedObject(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const imageBlock = (image: { mimeType: string; data: string }): AnthropicBlock => ({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } });

/** Whether this reasoning goes back: the setting allows it and it came from this format. */
export function replaysReasoning(item: ReasoningItem, format: ReasoningItem["format"], quirks: ModelQuirks): boolean {
  return item.format === format && quirks.reasoningReplay !== "none";
}

export function buildAnthropicInput(transcript: readonly TranscriptMessage[], quirks: ModelQuirks, options: { readonly replayReasoning?: boolean } = {}): { system: string; messages: AnthropicMessage[] } {
  const replay = options.replayReasoning !== false;
  const messages: AnthropicMessage[] = [];
  const append = (role: "user" | "assistant", blocks: AnthropicBlock[]): void => {
    if (blocks.length === 0) return;
    const last = messages[messages.length - 1];
    // The API joins consecutive same-role messages anyway; doing it here keeps tool results together in one message.
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };

  let index = 0;
  const lead: string[] = [];
  while (index < transcript.length && transcript[index]!.role === "system") {
    lead.push((transcript[index] as Extract<TranscriptMessage, { role: "system" }>).content);
    index += 1;
  }

  for (; index < transcript.length; index += 1) {
    const message = transcript[index]!;
    switch (message.role) {
      case "system":
        append("user", [{ type: "text", text: wrapSystemReminder(message.content) }]);
        break;
      case "user": {
        const images = message.images ?? [];
        const blocks: AnthropicBlock[] = [];
        if (quirks.images === "native") blocks.push(...images.map(imageBlock));
        const mention = quirks.images === "native" || images.length === 0 ? "" : `\n\n${images.map((image) => `[Attached image: ${image.name}]`).join("\n")}`;
        const text = `${message.content}${mention}`;
        if (text.trim() !== "") blocks.push({ type: "text", text });
        append("user", blocks);
        break;
      }
      case "assistant": {
        const blocks: AnthropicBlock[] = [];
        if (replay) for (const item of message.reasoningItems ?? []) if (replaysReasoning(item, "anthropic", quirks)) blocks.push({ ...item.item } as AnthropicBlock);
        if (message.content.trim() !== "") blocks.push({ type: "text", text: message.content });
        for (const call of message.toolCalls ?? []) {
          blocks.push({ type: "tool_use", id: portableToolId(call.id, quirks.toolCallId), name: call.name, input: parsedObject(call.arguments) });
        }
        append("assistant", blocks);
        break;
      }
      case "tool": {
        const pictures = message.images ?? [];
        const native = quirks.images === "native" && pictures.length > 0;
        const lost = pictures.length > 0 && !native ? `\n${pictures.map((image) => `[Image not sent: ${image.name}]`).join("\n")}` : "";
        const text = `${message.content}${lost}`.trim() === "" ? "(no output)" : `${message.content}${lost}`;
        append("user", [
          {
            type: "tool_result",
            tool_use_id: portableToolId(message.toolCallId, quirks.toolCallId),
            content: native ? [{ type: "text", text }, ...pictures.map(imageBlock)] : text,
            ...(message.isError ? { is_error: true } : {}),
          },
        ]);
        break;
      }
    }
  }
  return { system: lead.join("\n\n"), messages };
}

export function anthropicTools(tools: readonly ToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
}
