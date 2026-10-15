/**
 * Transcript to OpenAI-style chat messages, shaped by what the endpoint's
 * template is known to accept (`ModelQuirks`). This is the one place that
 * knows those constraints, so the loop and the tools never branch on them.
 *
 * It never changes the transcript: the same transcript sent to a different
 * server gets different wire messages, and a quirk fixed later (a template
 * patch, a probe result) applies to old threads too.
 */
import { createHash } from "node:crypto";

import type { ProviderImage } from "../spi.js";
import type { ModelQuirks } from "./quirks.js";
import type { ToolCall, TranscriptMessage } from "./types.js";

export type WireMessage = Record<string, unknown> & { role: "system" | "developer" | "user" | "assistant" | "tool" };

/** Text of a mid-conversation system entry when the template only allows a system message first. */
export function wrapSystemReminder(content: string): string {
  return `<system-reminder>\n${content}\n</system-reminder>`;
}

/**
 * The id a server will see for a tool call. Deterministic in the original id,
 * so the assistant message and its result always agree; unchanged when the
 * server has no constraint the id breaks.
 */
export function normalizeToolCallId(id: string, rule: ModelQuirks["toolCallId"]): string {
  const alphanumeric = rule.alphanumericOnly === true && /[^a-zA-Z0-9]/.test(id);
  const wrongLength = rule.exactLength !== undefined ? id.length !== rule.exactLength : rule.maxLength !== undefined && id.length > rule.maxLength;
  if (!alphanumeric && !wrongLength) return id;
  const digest = createHash("sha256").update(id).digest("base64url").replace(/[^a-zA-Z0-9]/g, "");
  const length = rule.exactLength ?? Math.min(rule.maxLength ?? digest.length, digest.length);
  return digest.slice(0, length).padEnd(length, "0");
}

function validJsonObjectText(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? text : "{}";
  } catch {
    // A template that parses the arguments back into an object fails the whole request on text it cannot parse.
    return "{}";
  }
}

function wireToolCalls(calls: readonly ToolCall[], quirks: ModelQuirks): unknown[] {
  return calls.map((call) => ({
    id: normalizeToolCallId(call.id, quirks.toolCallId),
    type: "function",
    function: { name: call.name, arguments: validJsonObjectText(call.arguments) },
  }));
}

function userWire(message: Extract<TranscriptMessage, { role: "user" }>, quirks: ModelQuirks): WireMessage {
  const images = message.images ?? [];
  if (images.length === 0) return { role: "user", content: message.content };
  if (quirks.images === "native") {
    return {
      role: "user",
      content: [
        { type: "text", text: message.content },
        ...images.map((image) => ({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } })),
      ],
    };
  }
  // An endpoint that cannot take images still gets to know one was attached.
  const mention = images.map((image) => `[Attached image: ${image.name}]`).join("\n");
  return { role: "user", content: `${message.content}\n\n${mention}` };
}

function assistantWire(message: Extract<TranscriptMessage, { role: "assistant" }>, quirks: ModelQuirks): WireMessage {
  const calls = message.toolCalls ?? [];
  const reasoning = message.reasoning?.trim() ?? "";
  let content = message.content;
  if (reasoning && quirks.reasoningReplay === "text") content = `<thinking>${reasoning}</thinking>\n${content}`;
  if (content === "" && calls.length > 0 && quirks.emptyAssistantContent === "dot") content = ".";
  const wire: WireMessage = { role: "assistant", content };
  if (reasoning && quirks.reasoningReplay === "field") wire[quirks.reasoningField] = reasoning;
  if (calls.length > 0) wire.tool_calls = wireToolCalls(calls, quirks);
  return wire;
}

function toolWire(message: Extract<TranscriptMessage, { role: "tool" }>, quirks: ModelQuirks): WireMessage {
  // A tool message carries text only, so a picture it returned follows the results as a user message; one the endpoint cannot take is named instead.
  const lost = (message.images ?? []).length > 0 && quirks.images !== "native" ? `\n${(message.images ?? []).map((image) => `[Image not sent: ${image.name}]`).join("\n")}` : "";
  const content = `${message.content}${lost}`;
  if (quirks.toolResultsAsUser) {
    return { role: "user", content: `<tool_response>\n${content}\n</tool_response>` };
  }
  const wire: WireMessage = {
    role: "tool",
    tool_call_id: normalizeToolCallId(message.toolCallId, quirks.toolCallId),
    content,
  };
  if (quirks.toolResultName) wire.name = message.name;
  return wire;
}

function mergeContent(a: unknown, b: unknown): unknown {
  if (typeof a === "string" && typeof b === "string") return `${a}\n\n${b}`;
  const parts = (value: unknown): unknown[] => (typeof value === "string" ? [{ type: "text", text: value }] : (value as unknown[]));
  return [...parts(a), ...parts(b)];
}

export function buildWireMessages(transcript: readonly TranscriptMessage[], quirks: ModelQuirks): WireMessage[] {
  const out: WireMessage[] = [];

  // Every system entry before the first real message is the prompt; they become one message.
  let index = 0;
  const lead: string[] = [];
  while (index < transcript.length && transcript[index]!.role === "system") {
    lead.push((transcript[index] as Extract<TranscriptMessage, { role: "system" }>).content);
    index += 1;
  }
  if (lead.length > 0) out.push({ role: quirks.systemRole, content: lead.join("\n\n") });

  // Pictures from a round of tool results, sent once the round's results are all in (tool messages must follow their call without a break).
  let pictures: Array<{ readonly tool: string; readonly image: ProviderImage }> = [];
  const flushPictures = (): void => {
    if (pictures.length === 0) return;
    out.push({
      role: "user",
      content: [
        { type: "text", text: pictures.map((picture) => `[Image returned by ${picture.tool}: ${picture.image.name}]`).join("\n") },
        ...pictures.map((picture) => ({ type: "image_url", image_url: { url: `data:${picture.image.mimeType};base64,${picture.image.data}` } })),
      ],
    });
    pictures = [];
  };

  for (; index < transcript.length; index += 1) {
    const message = transcript[index]!;
    if (message.role !== "tool") flushPictures();
    switch (message.role) {
      case "system":
        out.push(quirks.systemFirstOnly ? { role: "user", content: wrapSystemReminder(message.content) } : { role: "system", content: message.content });
        break;
      case "user":
        out.push(userWire(message, quirks));
        break;
      case "assistant":
        out.push(assistantWire(message, quirks));
        break;
      case "tool":
        out.push(toolWire(message, quirks));
        if (quirks.images === "native") for (const image of message.images ?? []) pictures.push({ tool: message.name, image });
        break;
    }
  }
  flushPictures();

  const shaped: WireMessage[] = [];
  for (const wire of out) {
    const previous = shaped[shaped.length - 1];
    if (quirks.assistantAfterToolResult && previous?.role === "tool" && wire.role === "user") {
      shaped.push({ role: "assistant", content: "Done." });
    }
    const last = shaped[shaped.length - 1];
    const mergeable =
      quirks.mergeAdjacentRoles &&
      last !== undefined &&
      last.role === wire.role &&
      (wire.role === "user" || (wire.role === "assistant" && last.tool_calls === undefined && wire.tool_calls === undefined));
    if (mergeable) {
      last.content = mergeContent(last.content, wire.content);
      continue;
    }
    shaped.push(wire);
  }
  return shaped;
}
