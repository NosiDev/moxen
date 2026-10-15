/**
 * What an endpoint's chat template and server are known (or configured) to
 * need. Chat templates are written by the model's developer and sometimes
 * reject what a harness legitimately sends; fixing them is the model
 * developer's and inference provider's job. These flags only let us avoid
 * sending what the server is known to reject, and are data so a new family
 * is a table row, not a new branch in the loop.
 *
 * The presets follow the compat rules Oh My Pi maintains
 * (`docs/provider-compat-reference.md` in its tree) and are starting points:
 * a model's probe result (`probe.ts`) and then the profile's own `quirks`
 * override them. Nothing here has been confirmed against a live server yet; `family` lets a user pick the right row when the model id
 * does not say.
 */
import { CliError } from "../../errors.js";

export type ReasoningField = "reasoning_content" | "reasoning" | "reasoning_text";

export interface ModelQuirks {
  /**
   * A system message is only accepted first. Later system content (updated
   * instructions, reminders) is sent as a user message wrapped in
   * `<system-reminder>`. On by default everywhere: it is always accepted.
   */
  readonly systemFirstOnly: boolean;
  /** Role of the leading prompt. */
  readonly systemRole: "system" | "developer" | "user";
  /** Merge adjacent same-role messages (strict user/assistant alternation). On by default. */
  readonly mergeAdjacentRoles: boolean;
  /** The template needs an assistant message between a tool result and the next user message. */
  readonly assistantAfterToolResult: boolean;
  /** Tool results go back as user messages wrapped in `<tool_response>` (no `tool` role in the template). */
  readonly toolResultsAsUser: boolean;
  /** Add `name` to `tool` messages. */
  readonly toolResultName: boolean;
  /** Tool-call id constraints the server enforces. */
  readonly toolCallId: { readonly maxLength?: number; readonly exactLength?: number; readonly alphanumericOnly?: boolean };
  /** What to send as the content of an assistant message that only made tool calls. */
  readonly emptyAssistantContent: "empty" | "dot";
  /** How earlier reasoning goes back to the model. `field` is the native reasoning field, `text` wraps it in `<thinking>` tags, `none` drops it. */
  readonly reasoningReplay: "none" | "field" | "text";
  readonly reasoningField: ReasoningField;
  /** Sent as `chat_template_kwargs` on every request (e.g. Qwen's `preserve_thinking`). */
  readonly chatTemplateKwargs: Readonly<Record<string, unknown>>;
  /** Top-level request field that carries the reasoning effort, or null when the server takes none. */
  readonly effortParam: string | null;
  /** Key inside `chat_template_kwargs` that carries the reasoning effort, or null. */
  readonly effortKwarg: string | null;
  /** The server rejects `tool_choice` entirely. */
  readonly omitToolChoice: boolean;
  /** Whether image content parts are accepted. */
  readonly images: "native" | "none";
  readonly parallelToolCalls: boolean;
  /** Anthropic only. How reasoning is switched on: `adaptive` (the model decides; Claude 4.6 and newer), `budget` (a fixed token budget; older models) or `off` (the field is left out). */
  readonly anthropicThinking: "adaptive" | "budget" | "off";
  /** Anthropic only. Send `cache_control` so the server caches the conversation prefix; off for a proxy that rejects the field. */
  readonly cacheControl: boolean;
  /** Responses only. Send the `reasoning` field (effort, summaries, encrypted reasoning for replay); off for a model that is not a reasoning model and rejects it. */
  readonly sendReasoning: boolean;
}

export const DEFAULT_QUIRKS: ModelQuirks = {
  systemFirstOnly: true,
  systemRole: "system",
  mergeAdjacentRoles: true,
  assistantAfterToolResult: false,
  toolResultsAsUser: false,
  toolResultName: false,
  toolCallId: {},
  emptyAssistantContent: "empty",
  reasoningReplay: "field",
  reasoningField: "reasoning_content",
  chatTemplateKwargs: {},
  effortParam: null,
  effortKwarg: null,
  omitToolChoice: false,
  images: "none",
  parallelToolCalls: true,
  anthropicThinking: "adaptive",
  cacheControl: true,
  sendReasoning: true,
};

/** The families a preset exists for; anything else is `generic`. */
export const QUIRK_FAMILIES = ["generic", "qwen3", "mistral", "deepseek", "glm", "kimi", "claude"] as const;
export type QuirkFamily = (typeof QUIRK_FAMILIES)[number];

const FAMILY_PRESETS: Record<QuirkFamily, Partial<ModelQuirks>> = {
  generic: {},
  // Qwen 3.6+ templates only render earlier `<think>` blocks when told to (Oh My Pi: `qwenPreserveThinking`);
  // 3.8+ take the effort as a template kwarg. Unconfirmed against a live server.
  qwen3: { chatTemplateKwargs: { preserve_thinking: true }, effortKwarg: "reasoning_effort" },
  mistral: {
    assistantAfterToolResult: true,
    toolResultName: true,
    reasoningReplay: "text",
    toolCallId: { exactLength: 9, alphanumericOnly: true },
  },
  deepseek: { emptyAssistantContent: "dot", omitToolChoice: true },
  glm: {},
  kimi: { emptyAssistantContent: "dot" },
  // Every Claude model takes pictures.
  claude: { images: "native" },
};

/** Which preset a model id belongs to, by name. `generic` when nothing matches. */
export function detectQuirkFamily(modelId: string): QuirkFamily {
  const id = modelId.toLowerCase();
  if (/qwen\s*-?3|qwq/.test(id)) return "qwen3";
  if (/mistral|mixtral|magistral|devstral|codestral|ministral/.test(id)) return "mistral";
  if (/deepseek/.test(id)) return "deepseek";
  if (/\bglm|chatglm/.test(id)) return "glm";
  if (/kimi|moonshot/.test(id)) return "kimi";
  if (/claude/.test(id)) return "claude";
  return "generic";
}

export function isQuirkFamily(value: unknown): value is QuirkFamily {
  return typeof value === "string" && (QUIRK_FAMILIES as readonly string[]).includes(value);
}

const ENUMS: Record<string, readonly string[]> = {
  systemRole: ["system", "developer", "user"],
  emptyAssistantContent: ["empty", "dot"],
  reasoningReplay: ["none", "field", "text"],
  reasoningField: ["reasoning_content", "reasoning", "reasoning_text"],
  images: ["native", "none"],
  anthropicThinking: ["adaptive", "budget", "off"],
};

const BOOLEANS = [
  "systemFirstOnly",
  "mergeAdjacentRoles",
  "assistantAfterToolResult",
  "toolResultsAsUser",
  "toolResultName",
  "omitToolChoice",
  "parallelToolCalls",
  "cacheControl",
  "sendReasoning",
] as const;

/**
 * Validate a profile's `quirks` object into overrides. Unknown keys are
 * dropped (a config written by a newer build stays loadable); a known key with
 * the wrong type is an error, because silently ignoring it would leave the
 * user wondering why a flag does nothing.
 */
export function parseQuirkOverrides(raw: unknown, label: string): Partial<ModelQuirks> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new CliError("INVALID_CONFIG", `${label} must be an object.`);
  const input = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of BOOLEANS) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") throw new CliError("INVALID_CONFIG", `${label}.${key} must be true or false.`);
    out[key] = value;
  }
  for (const [key, choices] of Object.entries(ENUMS)) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !choices.includes(value)) {
      throw new CliError("INVALID_CONFIG", `${label}.${key} must be one of ${choices.join(", ")}.`);
    }
    out[key] = value;
  }
  for (const key of ["effortParam", "effortKwarg"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (value !== null && typeof value !== "string") throw new CliError("INVALID_CONFIG", `${label}.${key} must be a string or null.`);
    out[key] = value;
  }
  if (input.chatTemplateKwargs !== undefined) {
    const kwargs = input.chatTemplateKwargs;
    if (typeof kwargs !== "object" || kwargs === null || Array.isArray(kwargs)) {
      throw new CliError("INVALID_CONFIG", `${label}.chatTemplateKwargs must be an object.`);
    }
    out.chatTemplateKwargs = kwargs;
  }
  if (input.toolCallId !== undefined) {
    const id = input.toolCallId;
    if (typeof id !== "object" || id === null || Array.isArray(id)) throw new CliError("INVALID_CONFIG", `${label}.toolCallId must be an object.`);
    const fields = id as Record<string, unknown>;
    const parsed: { maxLength?: number; exactLength?: number; alphanumericOnly?: boolean } = {};
    for (const key of ["maxLength", "exactLength"] as const) {
      const value = fields[key];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        throw new CliError("INVALID_CONFIG", `${label}.toolCallId.${key} must be a positive whole number.`);
      }
      parsed[key] = value;
    }
    if (fields.alphanumericOnly !== undefined) {
      if (typeof fields.alphanumericOnly !== "boolean") throw new CliError("INVALID_CONFIG", `${label}.toolCallId.alphanumericOnly must be true or false.`);
      parsed.alphanumericOnly = fields.alphanumericOnly;
    }
    out.toolCallId = parsed;
  }
  return out as Partial<ModelQuirks>;
}

export interface ResolveQuirksInput {
  readonly modelId: string;
  /** The model's configured family; wins over the id-based guess. */
  readonly family?: string | undefined;
  readonly vision?: boolean | undefined;
  /** Profile switch: send earlier reasoning back (default true). */
  readonly preserveThinking?: boolean | undefined;
  /** What the probe measured on this model's server; beats the preset, loses to `overrides`. */
  readonly probed?: Partial<ModelQuirks> | undefined;
  readonly overrides?: Partial<ModelQuirks> | undefined;
}

/**
 * Preset by family, then the probe's measurements, then the model's `vision`
 * fact, then the profile's own overrides. `vision` is something the user
 * states about the model, so it outranks the probe's `images`; the probe only
 * speaks for images when `vision` is unset.
 */
export function resolveQuirks(input: ResolveQuirksInput): ModelQuirks {
  const family = isQuirkFamily(input.family) ? input.family : detectQuirkFamily(input.modelId);
  const preset = FAMILY_PRESETS[family];
  let quirks: ModelQuirks = { ...DEFAULT_QUIRKS, ...preset, ...input.probed };
  if (input.vision !== undefined) quirks = { ...quirks, images: input.vision ? "native" : "none" };
  if (input.preserveThinking === false) {
    // Dropping the history's reasoning also drops the template flag that asks to render it.
    const kwargs = { ...quirks.chatTemplateKwargs };
    delete kwargs.preserve_thinking;
    quirks = { ...quirks, reasoningReplay: "none", chatTemplateKwargs: kwargs };
  }
  return input.overrides ? { ...quirks, ...input.overrides } : quirks;
}

export type QuirkOrigin = "default" | "preset" | "probe" | "model" | "profile" | "override";

/** Where each quirk's value comes from, for the profile editor: `override` > `profile` / `model` > `probe` > `preset` > `default`. */
export function quirkOrigins(input: ResolveQuirksInput): Record<keyof ModelQuirks, QuirkOrigin> {
  const family = isQuirkFamily(input.family) ? input.family : detectQuirkFamily(input.modelId);
  const preset = FAMILY_PRESETS[family];
  const origins = {} as Record<keyof ModelQuirks, QuirkOrigin>;
  for (const key of Object.keys(DEFAULT_QUIRKS) as Array<keyof ModelQuirks>) {
    if (input.overrides && key in input.overrides) origins[key] = "override";
    else if (input.preserveThinking === false && (key === "reasoningReplay" || key === "chatTemplateKwargs")) origins[key] = "profile";
    else if (key === "images" && input.vision !== undefined) origins[key] = "model";
    else if (input.probed && key in input.probed) origins[key] = "probe";
    else if (key in preset) origins[key] = "preset";
    else origins[key] = "default";
  }
  return origins;
}
