/**
 * Vocabulary of the harness loop: the transcript it keeps, what a model
 * endpoint streams back, and what the wire adapters turn those into. Nothing
 * here knows a wire format; `normalize.ts` and `transport/` do.
 */
import type { ProviderImage } from "../spi.js";

/**
 * A piece of the model's reasoning that has to go back verbatim for the server to
 * accept or use it: an Anthropic `thinking` block with its signature, or a
 * Responses `reasoning` item with its encrypted content. Opaque to everything
 * but the adapter of the same `format`, which is the only one that replays it.
 */
export interface ReasoningItem {
  readonly format: "anthropic" | "responses";
  readonly item: Readonly<Record<string, unknown>>;
}

/** A tool call as the model made it. `arguments` is the raw JSON text it streamed. */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/**
 * The transcript the loop keeps and persists. A `system` entry anywhere but
 * first is a mid-conversation reminder (updated instructions, a compaction
 * notice); whether the server's template accepts it there is the
 * normaliser's concern, not the loop's.
 */
export type TranscriptMessage =
  | { readonly role: "system"; readonly content: string }
  | {
      readonly role: "user";
      readonly content: string;
      readonly images?: readonly ProviderImage[];
      /**
       * Set on the one message a compaction leaves behind, whose `content` is the
       * summary, the user's earlier words and the checklist as the model reads
       * them. The parts are kept apart here so a later compaction can merge into
       * the summary and carry the user's words on. It is not a prompt the user
       * sent, so rollback and turn counting skip it.
       */
      readonly compactSummary?: CompactSummaryRecord;
    }
  | {
      readonly role: "assistant";
      readonly content: string;
      /** The reasoning the model streamed with this message, kept so it can be replayed. */
      readonly reasoning?: string;
      /** The same reasoning as the server needs it back, when its format has such a thing (see `ReasoningItem`). */
      readonly reasoningItems?: readonly ReasoningItem[];
      readonly toolCalls?: readonly ToolCall[];
    }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly name: string;
      readonly content: string;
      readonly isError?: boolean;
      /** Pictures the tool returned (`read` on an image file). Sent as image parts after the results when the endpoint takes images. */
      readonly images?: readonly ProviderImage[];
    };

export interface CompactSummaryRecord {
  /** Which compaction of the session wrote it (1 for the first). */
  readonly n: number;
  /** The model's summary; empty when the summariser failed and history was only trimmed. */
  readonly summary: string;
  /** The user's own messages, oldest first, as far as the budget allowed. */
  readonly users: readonly string[];
  /** How many older messages of the user's did not fit. */
  readonly omittedUsers: number;
  /**
   * How many entries right after it (kept reminders and the recent tail) the
   * summary already accounts for. Rolling back into them would leave a summary
   * that describes turns the thread no longer has, so rollback stops short.
   */
  readonly covers: number;
}

export type FinishReason = "stop" | "tool-calls" | "length" | "filter" | "error";

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Prompt tokens the server read from its cache, when it says. */
  readonly cachedInputTokens: number;
  readonly reasoningTokens: number;
}

/** What every adapter reduces its server's stream to. */
export type ModelEvent =
  | { readonly type: "reasoning.delta"; readonly text: string }
  | { readonly type: "text.delta"; readonly text: string }
  | { readonly type: "tool.call"; readonly call: ToolCall }
  /** Reasoning to replay verbatim with the assistant message this response becomes (`ReasoningItem`). */
  | { readonly type: "reasoning.item"; readonly item: ReasoningItem }
  | { readonly type: "usage"; readonly usage: ModelUsage }
  | { readonly type: "finish"; readonly reason: FinishReason };

/** A tool as the model is shown it. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments object. */
  readonly parameters: Record<string, unknown>;
}
