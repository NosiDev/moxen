/**
 * Picks the adapter for a request's wire format. Every adapter reduces its
 * server's stream to the same `ModelEvent`s, so the loop, compaction and the
 * one-shot requests call this and never branch on the format.
 */
import { buildWireMessages } from "../normalize.js";
import type { ModelQuirks } from "../quirks.js";
import type { ModelEvent, TranscriptMessage } from "../types.js";
import { streamAnthropic } from "./anthropic.js";
import { streamChat, type ChatRequest } from "./chat.js";
import { streamResponses } from "./responses.js";

export function streamModel(request: ChatRequest): AsyncIterable<ModelEvent> {
  switch (request.format) {
    case "anthropic":
      return streamAnthropic(request);
    case "responses":
      return streamResponses(request);
    default:
      return streamChat(request);
  }
}

/** The conversation part of a request: chat wire messages for the chat format, the transcript itself for the others (which shape it their own way). */
export function conversationFields(format: ChatRequest["format"], transcript: readonly TranscriptMessage[], quirks: ModelQuirks): Pick<ChatRequest, "messages" | "transcript" | "format"> {
  return { format, transcript, messages: format === undefined || format === "chat" ? buildWireMessages(transcript, quirks) : [] };
}
