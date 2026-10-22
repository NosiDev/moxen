import type { McpServerEntry } from "./mcp.js";

export type ProjectPolicy = "create" | "existing";
export type WorkspaceMode = "repo" | "folder";
export type OpenMode = "auto" | "desktop" | "browser" | "none";
export type ThreadEnvMode = "auto" | "local" | "worktree";
export type EffectiveThreadEnvMode = Exclude<ThreadEnvMode, "auto">;
export type RuntimeMode = "approval-required" | "auto" | "auto-accept-edits" | "full-access";
export type InteractionMode = "default" | "plan";
export type SpeedMode = "standard" | "fast";

export interface CliConfig {
  projectPolicy: ProjectPolicy;
  workspaceMode: WorkspaceMode;
  openMode: OpenMode;
  threadEnvMode: ThreadEnvMode;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  sessionTtl: string;
  provider?: string;
  model?: string;
  speedMode?: SpeedMode;
  thinkingEffort?: string;
  /** MCP servers injected into every provider session (`core/mcp.ts`). */
  mcpServers?: Record<string, McpServerEntry>;
  /** What starts an npm package when a well-known MCP server is added: npx (the default), bunx, `pnpm dlx` or `yarn dlx`. */
  mcpRunner?: "npx" | "bunx" | "pnpm" | "yarn";
  /** Appended to every provider session's system prompt (`core/threads/instructions.ts`). */
  instructions?: string;
  /**
   * When a plan usage limit stops a turn, schedule a "continue" for just
   * after the limit resets (at most twice in a row). Off unless set: it runs
   * work while nobody is watching.
   */
  autoContinueAtUsageLimit?: boolean;
  /**
   * Put moxen's own skills into a project that already has a `.claude` or
   * `.agents` folder (`core/skills/projectskills.ts`). On unless set to false;
   * off, the providers are pointed at the bundled folder instead.
   */
  installSkills?: boolean;
  /**
   * Days after a thread is archived or deleted before its `moxen/*` branch is
   * deleted, locally and (when it was pushed) on `origin`: only a branch already
   * merged, so no unique work is lost. Unset: 14. 0: never.
   */
  branchPruneDays?: number;
  /** TUI presentation; ignored by the CLI, which has no panels. */
  ui?: UiConfig;
  git?: GitConfig;
  forge?: ForgeConfig;
  /** Per-provider settings, read when that provider's driver is built. */
  providers?: ProvidersConfig;
  updates?: UpdatesConfig;
}

export interface UpdatesConfig {
  /** Ask the npm registry for the newest Claude Code and OpenCode when the settings page opens. On by default. */
  checkLatest?: boolean;
}

export type BackdropMode = "animated" | "static" | "off";

export interface UiConfig {
  backdrop?: BackdropMode;
  /** Each model's own scene behind the new-thread view; off keeps the monitoring field. On by default. */
  modelScenes?: boolean;
  /** Leave binary files out of the Diff tab. On by default. */
  hideBinaryDiffs?: boolean;
  defaultSidePanel?: "context" | "git" | "agents" | "background";
  contextRefreshSeconds?: number;
  usageRefreshSeconds?: number;
  /** What to do when a thread passes `autoHandoffPercent` of its window: ask with a card, hand off on its own, or nothing. Unset: ask. */
  autoHandoff?: "off" | "ask" | "auto";
  autoHandoffPercent?: number;
  /** Tokens of context at which a thread is handed off; wins over `autoHandoffPercent` at the same level. Unset: half the model's window. */
  autoHandoffTokens?: number;
}

export interface GitConfig {
  historyLimit?: number;
  /** Fetch before reading history; off by default because it hits the network. */
  autoFetch?: boolean;
}

/**
 * Forge access is executable paths and an off switch, nothing more: `gh`
 * and `glab` own their own logins, and we only ever observe that they are
 * present and authenticated. No token ever lands in this file.
 */
export interface ForgeConfig {
  enabled?: boolean;
  ghPath?: string;
  glabPath?: string;
}

export interface ProvidersConfig {
  claude?: ClaudeProviderConfig;
  opencode?: OpencodeProviderConfig;
  harness?: HarnessProviderConfig;
}

/** Moxen Harness: our own agent loop against endpoints the user configures. */
export interface HarnessProviderConfig {
  /** Hand off long threads on this provider: ask, on its own, or never. Unset: the global `ui.autoHandoff`. */
  autoHandoff?: "off" | "ask" | "auto";
  /** Tokens of context at which this provider's threads are handed off. Unset: this provider's share, else the global setting. */
  autoHandoffTokens?: number;
  /** Share (percent) of a model's window at which this provider's threads are handed off. Unset: the global setting. */
  autoHandoffPercent?: number;
  /** Tokens per model slug; beats everything else for that model. */
  autoHandoffModels?: Record<string, number>;
  /** Offer Moxen's own tools (delegate, handoff, task status) to threads on this provider. Unset: yes. */
  moxenTools?: boolean;
  /** MCP servers this provider does not get, as comma-separated names. Unset: it gets every server the server entry itself offers it. Settings key: `providers.<kind>.mcpExclude`. */
  mcpExclude?: string;
  /** Offer the model a to-do list on this provider. Unset: yes. */
  todos?: boolean;
  /** Permission mode new threads on this provider start in; unset follows the global `runtimeMode`. */
  runtimeMode?: RuntimeMode;
  /** Model new threads on this provider start with, when nothing more specific names one. */
  model?: string;
  /** Thinking effort new threads on this provider start at. */
  thinkingEffort?: string;
  profiles?: HarnessProfileConfig[];
  /** Compaction defaults for every profile (a profile's own `compaction` wins). Settings descriptors: `providers.harness.*`. */
  autoCompact?: boolean;
  /** Percent of the context window at which to compact; unset: 70 for windows of 128k or more, 60 below. */
  autoCompactPercent?: number;
  /** Tokens of context at which a harness session compacts; wins over `autoCompactPercent`. */
  autoCompactTokens?: number;
  keepRecentTokens?: number;
  /** How many requests a profile's server takes at once when the profile does not say; unset means no limit. */
  slots?: number;
  /** Where `web_search` looks: duckduckgo (no account), exa or brave (a key), searxng (your instance). */
  webSearch?: string;
  /** The NAME of the environment variable holding the Exa or Brave key. Never the key. */
  webSearchKeyEnv?: string;
  /** A `keychain:` reference to the Exa or Brave key saved in the OS keychain. Wins over `webSearchKeyEnv`. */
  webSearchKey?: string;
  /** Address of a SearXNG instance. */
  searxngUrl?: string;
  /** `auto`: use an installed Chrome or Chromium for pages a plain request cannot read; `off`: never. */
  webBrowser?: string;
  webBrowserPath?: string;
  /** Let the web tools reach private-network addresses (this machine is always allowed; cloud metadata never). */
  webPrivateNetwork?: boolean;
}

/** A profile's own compaction settings, over the defaults above. Not in the settings schema: a profile list is edited as a whole. */
export interface HarnessCompactionConfig {
  auto?: boolean;
  /** Share of the context window, 0.3 to 0.95. */
  fraction?: number;
  /** The threshold in tokens; wins over `fraction`. */
  tokens?: number;
  keepRecentTokens?: number;
  /** Reasoning effort for the summary request (default "low"); only sent to servers whose quirks take an effort. */
  effort?: string;
}

export interface HarnessModelConfig {
  /** The model name the endpoint expects. */
  id: string;
  /** Tokens the model can hold; unset leaves compaction and the context meter without a ceiling. */
  contextWindow?: number;
  maxOutput?: number;
  /** Whether the model takes images; unset assumes it does not. */
  vision?: boolean;
  /** Picks the quirk preset (`qwen3`, `mistral`, …) when the id does not say. */
  family?: string;
  /** Reasoning-effort levels the model picker offers (`low`, `high`, …); unset offers none. Sent through the family's effort setting (`quirks.effortParam` / `effortKwarg`) on a chat server. */
  efforts?: string[];
  /** What `moxen harness probe` found out about this model on its server. Written by the probe, never by hand. */
  probed?: HarnessProbedConfig;
}

/**
 * A probe's findings, kept apart from the profile's own `quirks` so a hand-made
 * override and a measurement never get mixed up. Resolution is preset, then
 * this, then `quirks`.
 */
export interface HarnessProbedConfig {
  /** When the probe last ran, ISO 8601. */
  at: string;
  /** Only the quirks a check settled; a check that could not tell leaves its keys out. */
  quirks: Record<string, unknown>;
  /** The server's own context size per slot, used while the model's `contextWindow` is unset. */
  contextWindow?: number;
  /** Slots the server reported (llama.cpp `total_slots`); a hint for the profile's `slots`. */
  slots?: number;
  /** Fingerprint of the server's chat template, to tell when it changed since. */
  templateHash?: string;
}

/**
 * One saved endpoint. `apiKeyEnv` names an environment variable: the key is
 * read from it when a request is made and is never stored here.
 */
/** The wire format an endpoint speaks: OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages. */
export type HarnessApiFormat = "chat" | "responses" | "anthropic";

export interface HarnessProfileConfig {
  /** Becomes the instance id `harness/<id>`. */
  id: string;
  label?: string;
  apiFormat: HarnessApiFormat;
  baseUrl: string;
  apiKeyEnv?: string;
  /** A `keychain:` reference to a key saved in the OS keychain (never the key). Wins over `apiKeyEnv`. */
  apiKey?: string;
  models: HarnessModelConfig[];
  sampling?: { temperature?: number; topP?: number; topK?: number; minP?: number };
  /** Concurrent requests the server can take (llama.cpp `-np`); 1 keeps our own subagents from starving it. */
  slots?: number;
  /** Send earlier reasoning back to the model (default on); off drops it from the history. */
  preserveThinking?: boolean;
  /** Overrides over the family preset; validated by the harness (`providers/harness/quirks.ts`). */
  quirks?: Record<string, unknown>;
  compaction?: HarnessCompactionConfig;
  systemPromptAppend?: string;
  /** Thresholds of the repeat guards; unset uses the defaults (4 / 6 identical calls, 10 repeats of a stretch of text). */
  loopGuard?: { repeatWarn?: number; repeatStop?: number; textRepeats?: number; calls?: boolean; text?: boolean };
  /** Make a title for each thread with this model (default on). Reasoning models can spend the small title budget before answering; turn it off for those. */
  titles?: boolean;
  /**
   * A tool's description, by tool name. A value starting with `+` is added to
   * the stock text (after a blank line); any other value replaces it. Small
   * models often want blunter wording than the default. Config file only.
   */
  toolDescriptions?: Record<string, string>;
}

/** What the user may set for OpenCode. Its external-server URL and password are not offered yet (see `configschema.ts`). */
export interface OpencodeProviderConfig {
  /** Hand off long threads on this provider: ask, on its own, or never. Unset: the global `ui.autoHandoff`. */
  autoHandoff?: "off" | "ask" | "auto";
  /** Tokens of context at which this provider's threads are handed off. Unset: this provider's share, else the global setting. */
  autoHandoffTokens?: number;
  /** Share (percent) of a model's window at which this provider's threads are handed off. Unset: the global setting. */
  autoHandoffPercent?: number;
  /** Tokens per model slug; beats everything else for that model. */
  autoHandoffModels?: Record<string, number>;
  /** Offer Moxen's own tools (delegate, handoff, task status) to threads on this provider. Unset: yes. */
  moxenTools?: boolean;
  /** MCP servers this provider does not get, as comma-separated names. Unset: it gets every server the server entry itself offers it. Settings key: `providers.<kind>.mcpExclude`. */
  mcpExclude?: string;
  /** Offer the model a to-do list on this provider. Unset: yes. */
  todos?: boolean;
  /** Replace OpenCode's own base system prompt with Moxen's. Unset: yes. */
  moxenPrompt?: boolean;
  /** The provider's own tools to switch off, as comma-separated names (`core/nativetools.ts`). Unset: it keeps them all. Settings key: `providers.<kind>.disabledNativeTools`. */
  disabledNativeTools?: string;
  /** The order the model should prefer web search tools in, as comma-separated ids (`brave`, `exa`, `native`). Unset: no preference. Settings key: `providers.<kind>.webSearchOrder`. */
  webSearchOrder?: string;
  /** The same for fetching a page (`moxen`, `exa`, `native`). Settings key: `providers.<kind>.webFetchOrder`. */
  webFetchOrder?: string;
  /** Permission mode new threads on this provider start in; unset follows the global `runtimeMode`. */
  runtimeMode?: RuntimeMode;
  /** Model new threads on this provider start with, when nothing more specific names one. */
  model?: string;
  /** Thinking effort new threads on this provider start at. */
  thinkingEffort?: string;
  binaryPath?: string;
  /** Tell spawned OpenCode servers about moxen's bundled skills. */
  bundledSkills?: boolean;
  /** Whether spawned OpenCode servers compact on their own near the context limit. Unset: whatever OpenCode's own config says. */
  autoCompact?: boolean;
  /** Tokens kept free below the model's limit; a larger buffer compacts earlier. Unset: OpenCode's own (10%). */
  compactBuffer?: number;
}

export interface ClaudeProviderConfig {
  /** Hand off long threads on this provider: ask, on its own, or never. Unset: the global `ui.autoHandoff`. */
  autoHandoff?: "off" | "ask" | "auto";
  /** Tokens of context at which this provider's threads are handed off. Unset: this provider's share, else the global setting. */
  autoHandoffTokens?: number;
  /** Share (percent) of a model's window at which this provider's threads are handed off. Unset: the global setting. */
  autoHandoffPercent?: number;
  /** Tokens per model slug; beats everything else for that model. */
  autoHandoffModels?: Record<string, number>;
  /** Offer Moxen's own tools (delegate, handoff, task status) to threads on this provider. Unset: yes. */
  moxenTools?: boolean;
  /** MCP servers this provider does not get, as comma-separated names. Unset: it gets every server the server entry itself offers it. Settings key: `providers.<kind>.mcpExclude`. */
  mcpExclude?: string;
  /** Offer the model a to-do list on this provider. Unset: yes. */
  todos?: boolean;
  /** The provider's own tools to switch off, as comma-separated names (`core/nativetools.ts`). Unset: it keeps them all. Settings key: `providers.<kind>.disabledNativeTools`. */
  disabledNativeTools?: string;
  /** The order the model should prefer web search tools in, as comma-separated ids (`brave`, `exa`, `native`). Unset: no preference. Settings key: `providers.<kind>.webSearchOrder`. */
  webSearchOrder?: string;
  /** The same for fetching a page (`moxen`, `exa`, `native`). Settings key: `providers.<kind>.webFetchOrder`. */
  webFetchOrder?: string;
  /** Permission mode new threads on this provider start in; unset follows the global `runtimeMode`. */
  runtimeMode?: RuntimeMode;
  /** Model new threads on this provider start with, when nothing more specific names one. */
  model?: string;
  /** Thinking effort new threads on this provider start at. */
  thinkingEffort?: string;
  binaryPath?: string;
  homePath?: string;
  launchArgs?: readonly string[];
  thinkingDisplay?: "summarized" | "omitted";
  promptSuggestions?: boolean;
  partialMessages?: boolean;
  /** Serve skills from `.agents/skills` (and moxen's bundled ones) to Claude Code with the `agent-skills` mod. */
  agentSkills?: boolean;
  /** Tokens at which Claude Code auto-compacts (100000 to 1000000); unset leaves its own default for the model. */
  autoCompactWindow?: number;
  /** Who compacts a long thread: Claude Code itself ("claude"), or Moxen, which turns Claude Code's off and sends `/compact` past `autoCompactPercent` of the window: asking first ("ask") or on its own ("auto"). Unset: ask. */
  autoCompact?: "claude" | "ask" | "auto";
  /** With Moxen compacting: the share of the window, 10 to 95, past which a thread is compacted. Unset: 80. */
  autoCompactPercent?: number;
  /** Run every Claude Code session with Ultracode (workflow orchestration) on. Unset: off. */
  ultracode?: boolean;
}

export interface RuntimeState {
  version: 1;
  pid: number;
  host?: string;
  port: number;
  origin: string;
  startedAt: string;
}

export interface RuntimeEnvelope {
  origin: string;
  stateDir: string | null;
  runtimeStatePath: string | null;
  settingsPath: string | null;
  environmentId: string;
  serverVersion: string;
  capabilities: {
    threadSettlement?: boolean;
    [key: string]: unknown;
  };
}

export interface ModelSelection {
  instanceId: string;
  model: string;
  options?: ProviderOptionSelection[];
}

export interface ProviderOptionSelection {
  id: string;
  value: string | boolean;
}

export interface ProjectEnvelope {
  id: string;
  title: string;
  workspaceRoot: string;
  defaultModelSelection: ModelSelection | null;
  defaultThreadEnvMode?: EffectiveThreadEnvMode | null;
  deletedAt?: string | null;
  [key: string]: unknown;
}

export interface ActivityEnvelope {
  id: string;
  tone: string;
  kind: string;
  summary: string;
  turnId: string | null;
  createdAt: string;
  [key: string]: unknown;
}

export interface CheckpointEnvelope {
  turnId: string;
  status: string;
  [key: string]: unknown;
}

export interface ProposedPlanEnvelope {
  id: string;
  turnId: string | null;
  [key: string]: unknown;
}

export interface ThreadEnvelope {
  id: string;
  projectId: string;
  title: string;
  modelSelection?: ModelSelection;
  runtimeMode?: RuntimeMode;
  interactionMode?: InteractionMode;
  branch?: string | null;
  worktreePath?: string | null;
  latestTurn?: LatestTurnEnvelope | null;
  session?: SessionEnvelope | null;
  createdAt?: string;
  updatedAt?: string;
  archivedAt: string | null;
  settledOverride?: "settled" | "active" | null;
  settledAt?: string | null;
  unsettledAt?: string | null;
  snoozedUntil?: string | null;
  snoozedAt?: string | null;
  latestUserMessageAt?: string | null;
  hasPendingApprovals?: boolean;
  hasPendingUserInput?: boolean;
  messages?: MessageEnvelope[];
  activities?: ActivityEnvelope[];
  checkpoints?: CheckpointEnvelope[];
  proposedPlans?: ProposedPlanEnvelope[];
  /**
   * The model each turn ran on, by turn id — `modelSelection` above is only
   * the thread's *current* choice. Turns recorded before per-turn models
   * were stored are absent; read those as the thread's selection.
   */
  turnModelSelections?: Record<string, ModelSelection>;
  /**
   * Messages waiting their turn, oldest first: queued behind the running
   * turn, or scheduled for later (`scheduledFor`). Absent when there are none.
   */
  queuedTurns?: QueuedTurnEnvelope[];
  /** The thread that delegated this one, for a delegated task; absent otherwise. */
  parentThreadId?: string;
  /** The provider's own subagents (Claude's Agent tool): running ones and the latest finished. Absent when there are none. */
  nativeSubagents?: NativeSubagentEnvelope[];
  deletedAt?: string | null;
  [key: string]: unknown;
}

export interface NativeSubagentEnvelope {
  agentId: string;
  agentType: string;
  description: string | null;
  status: "running" | "completed" | "failed" | "stopped";
  startedAt: string;
  stoppedAt: string | null;
}

export interface QueuedTurnEnvelope {
  turnId: string;
  messageId: string;
  scheduledFor: string | null;
  scheduleReason: "user" | "usage-reset" | "usage-hold" | null;
}

export interface LatestTurnEnvelope {
  turnId: string;
  state: "running" | "interrupted" | "completed" | "error";
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  assistantMessageId: string | null;
  [key: string]: unknown;
}

export interface SessionEnvelope {
  threadId: string;
  status: "idle" | "starting" | "running" | "ready" | "interrupted" | "stopped" | "error";
  providerName: string | null;
  providerInstanceId?: string;
  runtimeMode: RuntimeMode;
  activeTurnId: string | null;
  lastError: string | null;
  updatedAt: string;
  [key: string]: unknown;
}

export interface MessageEnvelope {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  turnId: string | null;
  streaming: boolean;
  createdAt: string;
  updatedAt: string;
  /** Persisted attachments; inline uploads may carry these without context records. */
  attachments?: unknown;
  [key: string]: unknown;
}

export interface OrchestrationSnapshot {
  snapshotSequence: number;
  projects: ProjectEnvelope[];
  threads: ThreadEnvelope[];
  updatedAt: string;
}

export interface ThreadDetailSnapshot {
  snapshotSequence: number;
  thread: ThreadEnvelope;
  page?: {
    beforeCursor: string | null;
    hasMore: boolean;
    snapshotSequence: number;
    threadSequence?: number;
  };
}

export interface OpenResult {
  mode: OpenMode;
  kind: "thread-deep-link" | "desktop-reveal" | "browser" | "none";
  url: string | null;
  exactThread: boolean;
}

export interface WorkspaceResolution {
  inputPath: string;
  workspaceRoot: string;
  mode: WorkspaceMode;
  isGitRepository: boolean;
  branch: string | null;
}

/** The provider driver an instance id routes to (`opencode/<provider>`, `harness/<profile>`, and `claudeAgent`, the historical Claude id), or null for an id no driver owns. */
export function driverKindOfInstance(instanceId: string): "claude" | "opencode" | "harness" | null {
  const key = instanceId.trim().toLowerCase();
  if (key === "opencode" || key.startsWith("opencode/")) return "opencode";
  if (key === "harness" || key.startsWith("harness/")) return "harness";
  if (key === "claudeagent" || key === "claude") return "claude";
  return null;
}

/** One model a server lists when asked (`harness.models.discover`). */
export interface DiscoveredModel {
  readonly id: string;
  readonly contextWindow?: number;
}

export type DiscoverResult =
  | { readonly ok: true; readonly models: readonly DiscoveredModel[]; readonly host: string }
  | { readonly ok: false; readonly message: string; readonly host: string | null };
