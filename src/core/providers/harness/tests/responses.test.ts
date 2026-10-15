import { describe, expect, it } from "vitest";

import { buildResponsesInput } from "../normalize-responses.js";
import { DEFAULT_QUIRKS, type ModelQuirks } from "../quirks.js";
import type { ChatRequest } from "../transport/chat.js";
import { responsesRequestBody, streamResponses } from "../transport/responses.js";
import type { ModelEvent, ReasoningItem, TranscriptMessage } from "../types.js";

const quirks = (overrides: Partial<ModelQuirks> = {}): ModelQuirks => ({ ...DEFAULT_QUIRKS, images: "native", ...overrides });
const call = (id: string, name = "read", args = '{"file_path":"/a"}') => ({ id, name, arguments: args });
const sealed: ReasoningItem = { format: "responses", item: { type: "reasoning", summary: [{ type: "summary_text", text: "hm" }], encrypted_content: "ENC" } };

function sse(events: ReadonlyArray<Record<string, unknown>>, status = 200): Response {
  const text = events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(text, { status, headers: { "content-type": "text/event-stream" } });
}

const request = (fetchImpl: (url: string, init: RequestInit) => Response | Promise<Response>, overrides: Partial<ChatRequest> = {}): ChatRequest => ({
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-secret",
  model: "gpt-x",
  messages: [],
  transcript: [{ role: "system", content: "SYS" }, { role: "user", content: "hi" }],
  format: "responses",
  tools: [],
  quirks: quirks(),
  fetch: (async (url: string, init: RequestInit) => await fetchImpl(url, init)) as unknown as typeof fetch,
  ...overrides,
});

async function collect(req: ChatRequest): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const event of streamResponses(req)) out.push(event);
  return out;
}

describe("buildResponsesInput", () => {
  it("builds items with no server-side ids: calls and results by call_id, reasoning replayed sealed", () => {
    const transcript: TranscriptMessage[] = [
      { role: "system", content: "SYS" },
      { role: "user", content: "go" },
      { role: "assistant", content: "Looking.", reasoningItems: [sealed, { format: "anthropic", item: { type: "thinking" } }], toolCalls: [call("a")] },
      { role: "tool", toolCallId: "a", name: "read", content: "one" },
      { role: "system", content: "Reminder." },
    ];
    const { instructions, input } = buildResponsesInput(transcript, quirks());
    expect(instructions).toBe("SYS");
    expect(input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "go" }] },
      { type: "reasoning", summary: [{ type: "summary_text", text: "hm" }], encrypted_content: "ENC" },
      { role: "assistant", content: "Looking." },
      { type: "function_call", call_id: "a", name: "read", arguments: '{"file_path":"/a"}' },
      { type: "function_call_output", call_id: "a", output: "one" },
      { role: "user", content: [{ type: "input_text", text: "<system-reminder>\nReminder.\n</system-reminder>" }] },
    ]);
    expect(buildResponsesInput(transcript, quirks({ reasoningReplay: "none" })).input.some((item) => item.type === "reasoning")).toBe(false);
  });

  it("sends pictures as input_image parts, in a tool result when a tool returned one, and names them for a model that cannot see", () => {
    const picture = { name: "a.png", mimeType: "image/png", data: "AAAA" };
    const transcript: TranscriptMessage[] = [
      { role: "user", content: "look", images: [picture] },
      { role: "assistant", content: "", toolCalls: [call("a")] },
      { role: "tool", toolCallId: "a", name: "read", content: "img", images: [picture] },
    ];
    const native = buildResponsesInput(transcript, quirks()).input;
    expect(native[0]).toEqual({ role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] });
    expect(native[2]).toMatchObject({ type: "function_call_output", output: [{ type: "input_text", text: "img" }, { type: "input_image" }] });
    const blind = buildResponsesInput(transcript, quirks({ images: "none" })).input;
    expect(blind[0]).toEqual({ role: "user", content: [{ type: "input_text", text: "look\n\n[Attached image: a.png]" }] });
    expect(blind[2]).toMatchObject({ output: "img\n[Image not sent: a.png]" });
  });
});

describe("responsesRequestBody", () => {
  const tools = [{ name: "read", description: "Reads.", parameters: { type: "object", properties: {} } }];

  it("keeps nothing on the server, asks for the reasoning back sealed, and forbids tool calls without dropping the tool list", () => {
    const body = responsesRequestBody(request(() => sse([]), { tools, toolChoice: "none", effort: "high", maxTokens: 900 }));
    expect(body).toMatchObject({
      model: "gpt-x",
      stream: true,
      store: false,
      instructions: "SYS",
      max_output_tokens: 900,
      tool_choice: "none",
      reasoning: { summary: "auto", effort: "high" },
      include: ["reasoning.encrypted_content"],
      tools: [{ type: "function", name: "read", description: "Reads.", parameters: { type: "object", properties: {} }, strict: false }],
    });
  });

  it("leaves reasoning settings out for a model that is not a reasoning model, and the sealed replay out when replay is off", () => {
    expect(responsesRequestBody(request(() => sse([]), { quirks: quirks({ sendReasoning: false }) }))).not.toHaveProperty("reasoning");
    expect(responsesRequestBody(request(() => sse([]), { quirks: quirks({ reasoningReplay: "none" }) }))).not.toHaveProperty("include");
    expect(responsesRequestBody(request(() => sse([]), { quirks: quirks({ parallelToolCalls: false, omitToolChoice: true }), tools }))).toMatchObject({ parallel_tool_calls: false });
  });
});

describe("streamResponses", () => {
  const completed = (extra: Record<string, unknown> = {}) => ({
    type: "response.completed",
    response: { usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 60 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 12 } }, ...extra },
  });

  it("reduces the event stream to reasoning, text, a finished function call, the sealed reasoning item without its id, usage, and the finish", async () => {
    const urls: string[] = [];
    const events = await collect(
      request((url) => {
        urls.push(url);
        return sse([
          { type: "response.created", response: {} },
          { type: "response.reasoning_summary_part.added", item_id: "rs_1" },
          { type: "response.reasoning_summary_text.delta", delta: "First." },
          { type: "response.reasoning_summary_part.added", item_id: "rs_1" },
          { type: "response.reasoning_summary_text.delta", delta: "Second." },
          { type: "response.output_item.done", item: { type: "reasoning", id: "rs_1", status: "completed", summary: [{ type: "summary_text", text: "First." }], encrypted_content: "ENC" } },
          { type: "response.output_text.delta", delta: "Reading " },
          { type: "response.output_text.delta", delta: "it." },
          { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read" } },
          { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"file_path":' },
          { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"/x"}' },
          { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "" } },
          completed(),
        ]);
      }),
    );
    expect(urls[0]).toBe("https://api.openai.com/v1/responses");
    expect(events).toEqual([
      { type: "reasoning.delta", text: "First." },
      { type: "reasoning.delta", text: "\n\n" },
      { type: "reasoning.delta", text: "Second." },
      { type: "reasoning.item", item: { format: "responses", item: { type: "reasoning", summary: [{ type: "summary_text", text: "First." }], encrypted_content: "ENC" } } },
      { type: "text.delta", text: "Reading " },
      { type: "text.delta", text: "it." },
      { type: "tool.call", call: { id: "call_1", name: "read", arguments: '{"file_path":"/x"}' } },
      { type: "usage", usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 60, reasoningTokens: 12 } },
      { type: "finish", reason: "tool-calls" },
    ]);
  });

  it("maps an incomplete response to its reason, and a failure to an error the loop can read", async () => {
    const incomplete = await collect(request(() => sse([{ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }])));
    expect(incomplete.at(-1)).toEqual({ type: "finish", reason: "length" });
    const failed = collect(request(() => sse([{ type: "response.failed", response: { error: { message: "context_length_exceeded: too long" } } }])));
    await expect(failed).rejects.toMatchObject({ contextOverflow: true });
    await expect(collect(request(() => sse([{ type: "error", message: "boom" }])))).rejects.toMatchObject({ message: "boom" });
    await expect(collect(request(() => sse([{ type: "response.output_text.delta", delta: "partial" }])))).rejects.toMatchObject({ retryable: true });
    await expect(collect(request(() => new Response("{}", { status: 429 })))).rejects.toMatchObject({ retryable: true });
  });

  it("sends the key as a bearer token only, and retries without the sealed reasoning when the server refuses it", async () => {
    const transcript: TranscriptMessage[] = [{ role: "user", content: "go" }, { role: "assistant", content: "ok", reasoningItems: [sealed] }, { role: "user", content: "more" }];
    const sent: Array<{ headers: Record<string, string>; input: Array<{ type?: string }> }> = [];
    const answers = [new Response(JSON.stringify({ error: { message: "Item with id 'rs_1' not found. Items are not persisted when `store` is set to false." } }), { status: 400 }), sse([completed()])];
    const events = await collect(
      request(
        (_url, init) => {
          const body = JSON.parse(String(init.body)) as { input: Array<{ type?: string }> };
          sent.push({ headers: init.headers as Record<string, string>, input: body.input });
          return answers.shift()!;
        },
        { transcript },
      ),
    );
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(sent).toHaveLength(2);
    expect(sent[0]!.headers).toMatchObject({ authorization: "Bearer sk-secret" });
    expect(sent[0]!.input.some((item) => item.type === "reasoning")).toBe(true);
    expect(sent[1]!.input.some((item) => item.type === "reasoning")).toBe(false);
  });
});
