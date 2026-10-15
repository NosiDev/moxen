/**
 * The harness profile list as a settings descriptor: which fields a profile
 * and its models have, how each is labelled and grouped. Only shapes live
 * here. What a value may be (ranges, URL form, the no-keys rule) is
 * `profiles.ts`, and `normalizeConfig` runs every edit through it.
 */
import type { ListField, SettingChoice, SettingDescriptor } from "../../configschema.js";
import { QUIRK_FAMILIES } from "./quirks.js";

const choice = (value: string, label: string, description?: string): SettingChoice =>
  description === undefined ? { value, label } : { value, label, description };

const FAMILY_CHOICES: readonly SettingChoice[] = QUIRK_FAMILIES.map((family) =>
  family === "generic" ? choice(family, "Generic", "No known quirks beyond the safe defaults.") : choice(family, family),
);

const MODEL_FIELDS: readonly ListField[] = [
  {
    path: "contextWindow",
    label: "Context window",
    description: "Tokens the model can hold. Automatic compaction and the context meter need it; left unset, the server's own figure from a probe is used if there is one.",
    group: "Model",
    kind: { type: "integer", presets: [8_192, 32_768, 65_536, 131_072, 262_144, 1_048_576] },
  },
  {
    path: "maxOutput",
    label: "Longest reply",
    description: "Most tokens one reply may run to. Unset leaves it to the server.",
    group: "Model",
    kind: { type: "integer", presets: [4_096, 8_192, 16_384, 32_768] },
  },
  {
    path: "vision",
    label: "Takes images",
    description: "Whether to send this model images. Unset assumes not, unless a probe saw the server accept one.",
    group: "Model",
    kind: { type: "boolean" },
  },
  {
    path: "family",
    label: "Model family",
    description: "Which set of known template quirks to start from. Set it when the model's name does not say (a fine-tune called `my-coder`).",
    group: "Model",
    kind: { type: "enum", choices: FAMILY_CHOICES },
  },
  {
    path: "efforts",
    label: "Reasoning efforts",
    description: "Levels the model picker offers, comma-separated (low, medium, high). Unset: none. A chat server gets the pick only if its family has an effort setting (Qwen does).",
    group: "Model",
    kind: { type: "words", separator: "comma" },
  },
];

const QUIRK_BOOLEANS: ReadonlyArray<readonly [string, string, string]> = [
  ["systemFirstOnly", "System message only first", "On: later reminders are sent as user messages. Off: sent as system messages."],
  ["mergeAdjacentRoles", "Merge same-side messages", "On: consecutive messages from the same role are joined (for templates that need strict alternation)."],
  ["assistantAfterToolResult", "Assistant between tool result and user", "On: a short assistant message is inserted after a tool result when the user speaks next."],
  ["toolResultsAsUser", "Tool results as user messages", "On: results go back as user messages in <tool_response> (the template has no tool role)."],
  ["toolResultName", "Name on tool results", "On: each tool result message also carries the tool's name."],
  ["omitToolChoice", "Leave out tool_choice", "On: never send `tool_choice` (the server rejects it). Compaction then relies on its instruction alone."],
  ["parallelToolCalls", "Parallel tool calls", "Off: ask the server for one tool call at a time."],
  ["cacheControl", "Prompt caching (Anthropic)", "On: ask Anthropic's API to cache the conversation prefix. Off for a proxy that rejects the field."],
  ["sendReasoning", "Send reasoning settings (Responses)", "On: send the `reasoning` field (effort, summaries, encrypted reasoning for replay). Off for a model that is not a reasoning model."],
];

const QUIRK_FIELDS: readonly ListField[] = [
  ...QUIRK_BOOLEANS.map(([name, label, description]): ListField => ({
    path: `quirks.${name}`,
    label,
    description: `${description} Set here, it beats both the preset and a probe; clear it to go back to those.`,
    group: "Template quirks",
    kind: { type: "boolean" },
  })),
  {
    path: "quirks.systemRole",
    label: "Role of the first prompt",
    description: "What the leading prompt is sent as. Beats the preset and the probe.",
    group: "Template quirks",
    kind: { type: "enum", choices: [choice("system", "system"), choice("developer", "developer"), choice("user", "user")] },
  },
  {
    path: "quirks.emptyAssistantContent",
    label: "Content of a tool-call-only reply",
    description: "What an assistant message that only calls tools carries as text: nothing, or a single dot (for servers that reject empty content).",
    group: "Template quirks",
    kind: { type: "enum", choices: [choice("empty", "Empty"), choice("dot", "A dot (.)")] },
  },
  {
    path: "quirks.reasoningReplay",
    label: "Send earlier reasoning back",
    description: "How past reasoning goes back to the model: in its own field, as <thinking> text, or not at all.",
    group: "Template quirks",
    kind: { type: "enum", choices: [choice("field", "In its field"), choice("text", "As text"), choice("none", "Not at all")] },
  },
  {
    path: "quirks.reasoningField",
    label: "Reasoning field",
    description: "Which field carries reasoning in the server's replies and in what is sent back.",
    group: "Template quirks",
    kind: { type: "enum", choices: [choice("reasoning_content", "reasoning_content"), choice("reasoning", "reasoning"), choice("reasoning_text", "reasoning_text")] },
  },
  {
    path: "quirks.anthropicThinking",
    label: "Thinking (Anthropic)",
    description: "How reasoning is switched on: adaptive (Claude 4.6 and newer decide for themselves), a fixed token budget (older models), or left out.",
    group: "Template quirks",
    kind: { type: "enum", choices: [choice("adaptive", "Adaptive"), choice("budget", "Token budget"), choice("off", "Off")] },
  },
  {
    path: "quirks.images",
    label: "Image parts",
    description: "Whether image content is sent natively. `Takes images` on the model normally decides this.",
    group: "Template quirks",
    kind: { type: "enum", choices: [choice("native", "Native"), choice("none", "Text note instead")] },
  },
];

export const HARNESS_PROFILE_FIELDS: readonly ListField[] = [
  { path: "label", label: "Name", description: "How the profile is called in the model picker. Defaults to its id.", group: "Endpoint", kind: { type: "string" } },
  {
    path: "apiFormat",
    label: "API format",
    description: "Which API the server speaks: chat (OpenAI Chat Completions, what llama.cpp, vLLM and Ollama offer), responses (OpenAI Responses), or anthropic (Anthropic Messages). Unset means chat.",
    group: "Endpoint",
    kind: { type: "enum", choices: [choice("chat", "Chat Completions"), choice("responses", "OpenAI Responses"), choice("anthropic", "Anthropic Messages")] },
  },
  {
    path: "baseUrl",
    label: "Base URL",
    description: "The server's address, with or without /v1. No username or password in it.",
    group: "Endpoint",
    kind: { type: "string", placeholder: "http://localhost:8080" },
  },
  {
    path: "apiKey",
    label: "API key",
    description: "Typed once and kept in the OS keychain (macOS Keychain, Windows Credential Manager); it never appears in the config file or on screen. Leave unset for a server that takes none.",
    group: "Endpoint",
    kind: { type: "secret" },
  },
  {
    path: "apiKeyEnv",
    label: "API key variable",
    description: "Instead of saving a key: the NAME of an environment variable that holds it, as the Moxen server sees it. A saved key wins over this.",
    group: "Endpoint",
    kind: { type: "string", placeholder: "MY_API_KEY" },
  },
  {
    path: "slots",
    label: "Server slots",
    description: "Requests the server runs at once (llama.cpp `-np`). With 1, Moxen's own subagents wait their turn instead of starving you.",
    group: "Endpoint",
    kind: { type: "integer", presets: [1, 2, 4, 8] },
  },
  {
    path: "models",
    label: "Models",
    description: "The models this endpoint serves. Any other model name can still be sent.",
    group: "Models",
    kind: { type: "list", noun: "model", fields: MODEL_FIELDS },
  },
  { path: "sampling.temperature", label: "Temperature", description: "Sampling temperature, 0 to 5. Unset leaves it to the server.", group: "Sampling", kind: { type: "number", presets: [0, 0.2, 0.6, 0.7, 1] } },
  { path: "sampling.topP", label: "Top P", description: "Nucleus sampling, 0 to 1.", group: "Sampling", kind: { type: "number", presets: [0.8, 0.9, 0.95, 1] } },
  { path: "sampling.topK", label: "Top K", description: "Sampling pool size.", group: "Sampling", kind: { type: "integer", presets: [20, 40, 64] } },
  { path: "sampling.minP", label: "Min P", description: "Smallest probability a token may have, 0 to 1.", group: "Sampling", kind: { type: "number", presets: [0, 0.05, 0.1] } },
  {
    path: "preserveThinking",
    label: "Keep reasoning in history",
    description: "Send earlier reasoning back to the model. Unset means yes. It keeps the server's prompt cache valid; turn it off if a template chokes on it.",
    group: "Thinking",
    kind: { type: "boolean" },
  },
  {
    path: "compaction.auto",
    label: "Compact automatically",
    description: "Overrides the Moxen Harness setting of the same name for this profile.",
    group: "Compaction",
    kind: { type: "boolean" },
  },
  {
    path: "compaction.fraction",
    label: "Compact at (share of window)",
    description: "0.3 to 0.95. Overrides the Moxen Harness percentage for this profile. Needs a context window on the model.",
    group: "Compaction",
    kind: { type: "number", presets: [0.5, 0.6, 0.7, 0.8, 0.9] },
  },
  {
    path: "compaction.tokens",
    label: "Compact at (tokens)",
    description: "An exact threshold in tokens; wins over the share.",
    group: "Compaction",
    kind: { type: "integer" },
  },
  {
    path: "compaction.keepRecentTokens",
    label: "Kept word for word",
    description: "How much of the newest conversation stays unsummarised. Overrides the Moxen Harness setting.",
    group: "Compaction",
    kind: { type: "integer", presets: [8_000, 15_000, 30_000, 50_000] },
  },
  {
    path: "compaction.effort",
    label: "Summary effort",
    description: "Reasoning effort for the summary request, on servers that take one. Unset: low.",
    group: "Compaction",
    kind: { type: "string", placeholder: "low" },
  },
  {
    path: "titles",
    label: "Name threads",
    description: "Ask this model for a short title after its first answer. Unset means yes; turn it off for a reasoning model that spends the title's small budget thinking.",
    group: "Behaviour",
    kind: { type: "boolean" },
  },
  { path: "loopGuard.calls", label: "Catch repeated tool calls", description: "Warn, then end the turn, when the model makes the same tool call (or the same few calls in turn) again and again. Unset: on.", group: "Behaviour", kind: { type: "boolean" } },
  { path: "loopGuard.repeatWarn", label: "Warn after identical calls", description: "The same tool call this many times in one turn gets a warning. Unset: 4.", group: "Behaviour", kind: { type: "integer", presets: [3, 4, 5, 8] } },
  { path: "loopGuard.repeatStop", label: "Stop after identical calls", description: "…and this many ends the turn. Unset: 6.", group: "Behaviour", kind: { type: "integer", presets: [5, 6, 8, 12] } },
  { path: "loopGuard.text", label: "Catch repeated text", description: "Cut a reply off when it, or its reasoning, repeats one stretch of text over and over. Turn it off if it ends replies that were fine. Unset: on.", group: "Behaviour", kind: { type: "boolean" } },
  { path: "loopGuard.textRepeats", label: "Stop repeated text after", description: "A reply repeating one stretch of text this many times is cut off. Unset: 10.", group: "Behaviour", kind: { type: "integer", presets: [6, 10, 20] } },
  {
    path: "systemPromptAppend",
    label: "Extra instructions",
    description: "Added to this profile's system prompt, after Moxen's own.",
    group: "Prompt",
    kind: { type: "string", multiline: true },
  },
  ...QUIRK_FIELDS,
];

export const HARNESS_PROFILES_SETTING: SettingDescriptor = {
  key: "providers.harness.profiles",
  label: "Profiles",
  description: "The endpoints the Moxen Harness talks to. Each is a server address, the models on it, and anything its chat template needs.",
  section: "provider:harness",
  group: "Model servers",
  kind: { type: "list", noun: "profile", lowercaseIds: true, add: "harness-profile", fields: HARNESS_PROFILE_FIELDS, actions: ["duplicate", "test", "probe", "transfer"] },
  defaultValue: undefined,
};
