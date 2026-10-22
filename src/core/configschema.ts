/**
 * The settings schema: one declarative table describing every key the
 * config file accepts.
 *
 * This exists so the CLI and the TUI cannot drift. `moxen config set` used
 * to validate against a flat `CONFIG_KEYS` tuple while nothing else knew
 * what a key meant — no label, no range, no idea whether it was an enum.
 * A TUI settings page built against that would have had to restate all of
 * it, and the two would have disagreed by the second change. Here the
 * table *is* the contract: the CLI derives its key list from it, the TUI
 * renders a control per descriptor, and adding a setting is one entry.
 *
 * It lives in the shared kernel (`src/core/config*`) on purpose — a client
 * may read vocabulary directly, and a setting's type and choices are
 * vocabulary. Applying a change still goes through `ClientApi`, because a
 * server outlives any one client and owns the file.
 *
 * Keys are dotted paths (`providers.claude.binaryPath`) resolved against
 * the config object; `readSetting` / `writeSetting` below are the only
 * things that walk them.
 */
import { readListScalar, resolveListKey, type ListDescriptor, type ListTarget } from "./configlist.js";
import { CliError } from "./errors.js";
import { webOrderEntries, webOrderUnavailable, type WebOrderEntry, type WebRole } from "./webservers.js";
import { CLAUDE_NATIVE_TOOLS, OPENCODE_NATIVE_TOOLS, type NativeTool } from "./nativetools.js";
import { formatHandoffModels } from "./handoffmodels.js";
import { isSecretRef } from "./secrets.js";
import { MCP_RUNNER_SETTING, MCP_SERVERS_SETTING } from "./mcpschema.js";
import { describeMcpServers } from "./mcpview.js";
import { HARNESS_PROFILES_SETTING } from "./providers/harness/profileschema.js";
import { describeHarnessProfiles } from "./providers/harness/profileview.js";
import type { CliConfig } from "./types.js";

/** Where a setting shows up. Order is the order a settings page renders. */
export const SETTING_SECTIONS = [
  "general",
  "turns",
  "model",
  "interface",
  "git",
  "provider:claude",
  "provider:opencode",
  "provider:harness",
  "mcp",
] as const;

export type SettingSection = (typeof SETTING_SECTIONS)[number];

export const SECTION_LABEL: Record<SettingSection, string> = {
  general: "General",
  turns: "Turns",
  model: "New threads",
  interface: "Interface",
  git: "Git and forges",
  "provider:claude": "Claude Code",
  "provider:opencode": "OpenCode",
  "provider:harness": "Moxen Harness",
  mcp: "MCP servers",
};

/** What the two ends of a slider over a setting's presets mean ("Faster" / "Smarter"). */
export interface SettingEnds {
  readonly low: string;
  readonly high: string;
}

export interface SettingChoice {
  readonly value: string;
  readonly label: string;
  /** One line on what picking this does; shown beside the choice. */
  readonly description?: string;
}

export type SettingKind =
  | { readonly type: "enum"; readonly choices: readonly SettingChoice[] }
  | { readonly type: "boolean" }
  /** A key or token: typed into a masked input, kept in the OS keychain, and in the config only as a `keychain:` reference. */
  | { readonly type: "secret" }
  | {
      readonly type: "string";
      readonly placeholder?: string;
      readonly multiline?: boolean;
      /**
       * The value names something in the provider catalog (a provider
       * instance, a model slug, an effort level). A client offers what the
       * catalog lists rather than a text box; the file still holds the id.
       */
      readonly source?: "provider" | "model" | "effort" | "mcp-server" | "handoff-models" | "native-tools" | "web-order";
      /** With `source` web-order: which tools the order ranks. */
      readonly web?: WebRole;
      /** With `source` native-tools: the provider's own tools this setting can switch off (`core/nativetools.ts`). */
      readonly tools?: readonly NativeTool[];
      /** With `source` model or effort: offer only this provider's models (the setting belongs to its page). */
      readonly providerKind?: "claude" | "opencode" | "harness";
    }
  /**
   * `unit` is appended when the value is shown ("20" -> "20s"). `presets`
   * are the values a client offers to pick from (any in range is accepted).
   * `binary` counts in powers of two and shows 131072 as "128K" (token windows).
   */
  | { readonly type: "integer"; readonly min: number; readonly max: number; readonly unit?: string; readonly presets?: readonly number[]; readonly binary?: boolean; readonly ends?: SettingEnds }
  /** A duration string the session layer parses (`"2m"`, `"45s"`); `presets` as for integers. */
  | { readonly type: "duration"; readonly presets?: readonly string[]; readonly ends?: SettingEnds }
  | ListKind;

/**
 * A field of one list item, addressed relative to the item (`baseUrl`,
 * `sampling.topK`). The kinds are the plain ones: ranges and combinations are
 * checked by whatever owns the list, so they are stated once. A boolean is
 * always three-way (unset, on, off) because an unset field falls back to
 * something and the editor has to be able to say "go back to that".
 */
export interface ListField {
  readonly path: string;
  readonly label: string;
  readonly description: string;
  /** The heading a client files the field under. */
  readonly group: string;
  /** Kept settable for old files, but an editor does not offer it. */
  readonly hidden?: boolean;
  readonly kind: ListFieldKind;
}

export type ListFieldKind =
  | { readonly type: "string"; readonly placeholder?: string; readonly multiline?: boolean }
  | { readonly type: "integer"; readonly unit?: string; readonly presets?: readonly number[]; readonly ends?: SettingEnds }
  | { readonly type: "number"; readonly presets?: readonly number[]; readonly ends?: SettingEnds }
  | { readonly type: "boolean" }
  | { readonly type: "secret" }
  | { readonly type: "enum"; readonly choices: readonly SettingChoice[] }
  /** A list of words kept as an array: `separator` is how they are typed (`shell` honours quotes). */
  | { readonly type: "words"; readonly separator: "comma" | "shell" }
  /** `KEY=value` pairs kept as an object. `secret`: values are never shown, and typing `KEY=<hidden>` keeps the stored one. */
  | { readonly type: "pairs"; readonly secret?: boolean }
  /** A list inside the item (a profile's models), addressed `path[<id>]`. */
  | { readonly type: "list"; readonly noun: string; readonly fields: readonly ListField[] };

/**
 * A structured list kept in the config as an array of objects that each carry
 * an `id`. Edited through `config set 'key[<id>]…'` (see `configlist.ts`);
 * `actions` are what a client may offer besides add, edit and remove.
 */
export interface ListKind {
  readonly type: "list";
  /** "profile": used in messages and button labels. */
  readonly noun: string;
  /** Ids are folded to lower case (profile ids are; model ids are not). */
  readonly lowercaseIds?: boolean;
  /** Kept in the config as an object keyed by id (MCP servers, as in `.mcp.json`) rather than an array of objects carrying one. */
  readonly keyed?: boolean;
  /** How a client walks a user through adding one. */
  readonly add: "harness-profile" | "mcp-server";
  readonly fields: readonly ListField[];
  readonly actions: readonly ("duplicate" | "test" | "probe" | "transfer")[];
}

/** One list entry as a client draws it: values, where they come from, and plain-language state. */
export interface ListItemView {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  /** A problem or note worth showing beside the entry ("COLAB_KEY is not set"), or null. */
  readonly status: string | null;
  readonly fields: readonly ListFieldView[];
  /** Read-only rows: what is in force and why, or what a probe found. */
  readonly resolved: readonly ListResolvedRow[];
}

export interface ListFieldView {
  readonly path: string;
  readonly value: SettingValue;
  /** The file holds a value for it. */
  readonly explicit: boolean;
  /** What applies when it is unset, or on top of it, and where that comes from. */
  readonly effective?: ListEffective;
  /** The entries of a nested list. */
  readonly items?: readonly ListItemView[];
}

export interface ListEffective {
  readonly value: SettingValue;
  /** Short and plain: "this profile", "Compact at (above)", "the server's probe", "the model's name". */
  readonly origin: string;
}

export interface ListResolvedRow {
  readonly label: string;
  readonly value: string;
  readonly origin: string;
}

export type SettingValue = string | boolean | number | undefined;

export interface SettingDescriptor {
  /** Dotted path into the config object, and the id `config set` takes. */
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly section: SettingSection;
  /** Kept settable for existing configs and scripts, but a settings page does not offer it. */
  readonly hidden?: boolean;
  /** A heading the page files this setting under, within its section; consecutive settings with the same one share it. */
  readonly group?: string;
  readonly kind: SettingKind;
  /** The value in force when the key is absent. `undefined` means "unset". */
  readonly defaultValue: SettingValue;
  /** A page shows this setting only while `key` holds one of `in` (its default counts). The CLI lists it always. */
  readonly visibleWhen?: { readonly key: string; readonly in: readonly string[] };
  /**
   * Read at driver construction, so a change reaches only sessions started
   * after it. Surfaced to the user rather than silently half-applied.
   */
  readonly restartRequired?: boolean;
  /** `MOXEN_<name>` overrides this key; shown so an ignored edit is explicable. */
  readonly envOverride?: string;
}

const choice = (value: string, label: string, description?: string): SettingChoice =>
  description === undefined ? { value, label } : { value, label, description };

/** Hand-off settings a provider's own page carries; each overrides the global pair on Turns. */
function handoffSettings(kind: "claude" | "opencode" | "harness"): SettingDescriptor[] {
  const section = `provider:${kind}` as const;
  return [
    {
      key: `providers.${kind}.autoHandoff`,
      label: "Hand off long threads",
      description: "What to do when a thread here fills its window: ask with a card, hand off by itself, or never. Default: the 'Hand off long threads' setting on the Turns tab.",
      section,
      group: "Long threads",
      kind: { type: "enum", choices: [choice("ask", "Ask"), choice("auto", "Automatic"), choice("off", "Off")] },
      defaultValue: undefined,
    },
    {
      key: `providers.${kind}.autoHandoffPercent`,
      label: "Hand off at",
      description: "Share of the model's window at which a thread here is handed off, so a bigger window hands off later. Default: the 'Hand off at' setting on the Turns tab.",
      section,
      group: "Long threads",
      kind: { type: "integer", min: 10, max: 90, unit: "%", presets: [25, 50, 75], ends: { low: "Earlier", high: "Later" } },
      defaultValue: undefined,
    },
    {
      key: `providers.${kind}.autoHandoffTokens`,
      label: "Hand off at a fixed size",
      description: "Tokens of context at which a thread here is handed off, whatever the model's window. Wins over the share above. Default: the share.",
      section,
      group: "Long threads",
      kind: { type: "integer", min: 8_192, max: 2_000_000, binary: true, presets: [32_768, 65_536, 131_072, 262_144, 524_288], ends: { low: "Earlier", high: "Later" } },
      defaultValue: undefined,
    },
    {
      key: `providers.${kind}.autoHandoffModels`,
      label: "Hand off at, per model",
      description: "Token counts for particular models of this provider. Wins over the settings above for those models; other models follow them. Stored as model=tokens pairs (claude-opus-4-5=500k, gpt-5=1m) for the config file and `moxen config set`.",
      section,
      group: "Long threads",
      kind: { type: "string", placeholder: "model=500k", multiline: true, source: "handoff-models", providerKind: kind },
      defaultValue: undefined,
    },
  ];
}

const SETTINGS_IN_WRITTEN_ORDER: readonly SettingDescriptor[] = [
  // -- general ---------------------------------------------------------------
  {
    key: "projectPolicy",
    label: "Unknown folders",
    description: "What happens when a prompt names a folder that is not a project yet.",
    section: "general",
    kind: {
      type: "enum",
      choices: [
        choice("create", "Create the project", "Register the folder and carry on."),
        choice("existing", "Require an existing project", "Refuse rather than register anything."),
      ],
    },
    defaultValue: "create",
    envOverride: "MOXEN_PROJECT_POLICY",
  },
  {
    key: "workspaceMode",
    label: "Workspace root",
    description: "Whether a project's root is the enclosing git repository or the folder itself.",
    section: "general",
    kind: {
      type: "enum",
      choices: [
        choice("repo", "Repository root", "Walk up to the git root."),
        choice("folder", "The folder itself", "Take the path as given."),
      ],
    },
    defaultValue: "repo",
    envOverride: "MOXEN_WORKSPACE_MODE",
  },
  {
    key: "openMode",
    label: "Open links in",
    description: "Kept so older scripts and configs still load. Moxen has no desktop app to deep-link into, so nothing is opened whatever this says; threads are used through the TUI.",
    section: "general",
    hidden: true,
    kind: {
      type: "enum",
      choices: [
        choice("auto", "Whatever is available"),
        choice("desktop", "The desktop app"),
        choice("browser", "A browser"),
        choice("none", "Nowhere", "Print the link instead of opening it."),
      ],
    },
    defaultValue: "auto",
    envOverride: "MOXEN_OPEN_MODE",
  },
  {
    key: "threadEnvMode",
    label: "Thread environment",
    description: "The last-resort answer for threads started from the command line (`moxen handover`, `moxen threads create`) when neither the command, the project, nor its moxen.json says whether to use a worktree. A model delegating work chooses for itself each time (a worktree unless it asks for the shared checkout), so this does not govern delegation.",
    section: "general",
    kind: {
      type: "enum",
      choices: [
        choice("auto", "Automatic", "Currently the project checkout; kept so it can get smarter without a config change."),
        choice("local", "The project checkout", "Work directly in the project's folder."),
        choice("worktree", "Always a worktree", "Give each thread its own checkout on a new branch, so threads cannot step on each other."),
      ],
    },
    defaultValue: "auto",
    envOverride: "MOXEN_THREAD_ENV_MODE",
  },

  // -- turns -----------------------------------------------------------------
  {
    key: "runtimeMode",
    label: "Permissions",
    description: "How much a new thread may do without asking. A provider's own 'Permissions' (on its tab) wins over this. Each provider maps the mode onto its own native one.",
    section: "model",
    kind: {
      type: "enum",
      choices: [
        choice("approval-required", "Supervised", "Ask before every edit and command."),
        choice("auto-accept-edits", "Auto-accept edits", "Reads and edits go through; commands still ask."),
        choice("auto", "Auto", "The provider judges each call (Moxen Harness: its command classifier)."),
        choice("full-access", "Full access", "No prompts at all."),
      ],
    },
    defaultValue: "full-access",
    envOverride: "MOXEN_RUNTIME_MODE",
  },
  {
    key: "interactionMode",
    label: "Start in",
    description: "Whether new threads start in plan mode. Plan mode is now a per-thread choice, so a settings page no longer offers this; the key still works for existing configs.",
    section: "model",
    hidden: true,
    kind: {
      type: "enum",
      choices: [choice("default", "Normal"), choice("plan", "Plan first")],
    },
    defaultValue: "default",
    envOverride: "MOXEN_INTERACTION_MODE",
  },
  {
    key: "sessionTtl",
    label: "Idle session lifetime",
    description: "How long a provider session stays warm after its last turn.",
    section: "turns",
    group: "Sessions",
    kind: { type: "duration", presets: ["30s", "1m", "2m", "5m", "10m", "30m", "1h"], ends: { low: "Shorter", high: "Longer" } },
    defaultValue: "2m",
  },
  {
    key: "autoContinueAtUsageLimit",
    label: "Continue after a usage limit",
    description:
      "When a plan limit stops a turn, schedule a continue for just after it resets (at most twice in a row). Off by default: it runs work while nobody is watching.",
    section: "turns",
    group: "Sessions",
    kind: { type: "boolean" },
    defaultValue: false,
  },
  {
    key: "branchPruneDays",
    label: "Delete finished worktree branches after",
    description:
      "Days after a thread is archived or deleted before its `moxen/…` branch is deleted, here and on origin if it was pushed. Only a branch already merged into the project's branch goes, so no work is lost; a branch with commits that were never merged is kept. 0 keeps every branch.",
    section: "general",
    kind: { type: "integer", min: 0, max: 365, unit: "d", presets: [0, 7, 14, 30, 90], ends: { low: "Sooner", high: "Later" } },
    defaultValue: 14,
  },
  {
    key: "installSkills",
    label: "Install Moxen's skills in projects",
    description:
      "Put the skills Moxen ships into a project that already has a `.claude` or `.agents` folder (`.claude/skills` when it has both), so both providers find them there. Copies are kept current, listed in `.git/info/exclude`, and never replace a skill you already have. Off, or with neither folder, the providers are pointed at Moxen's own folder instead.",
    section: "turns",
    group: "Agent",
    kind: { type: "boolean" },
    defaultValue: true,
  },
  {
    key: "instructions",
    label: "Extra instructions",
    description: "Appended to every provider session's system prompt.",
    section: "turns",
    group: "Agent",
    kind: { type: "string", placeholder: "Appended to every session", multiline: true },
    defaultValue: undefined,
  },

  // -- model -----------------------------------------------------------------
  {
    key: "provider",
    label: "Provider",
    description: "The provider a new thread uses when nothing else names one.",
    section: "model",
    kind: { type: "string", placeholder: "claude", source: "provider" },
    defaultValue: undefined,
    envOverride: "MOXEN_PROVIDER",
  },
  {
    key: "model",
    label: "Model",
    description: "The model a new thread uses when nothing else names one. A provider's own 'Model' (on its tab) wins over this.",
    section: "model",
    kind: { type: "string", placeholder: "the provider's own default", source: "model" },
    defaultValue: undefined,
    envOverride: "MOXEN_MODEL",
  },
  {
    key: "speedMode",
    label: "Speed",
    description: "Kept so older configs still load. No provider Moxen drives reads it today, so a settings page does not offer it.",
    section: "model",
    hidden: true,
    kind: { type: "enum", choices: [choice("standard", "Standard"), choice("fast", "Fast")] },
    defaultValue: undefined,
    envOverride: "MOXEN_SPEED_MODE",
  },
  {
    key: "thinkingEffort",
    label: "Effort",
    description: "The reasoning effort a new thread starts at, for models that take one. A provider's own 'Effort' (on its tab) wins over this.",
    section: "model",
    kind: { type: "string", placeholder: "the provider's own default", source: "effort" },
    defaultValue: undefined,
    envOverride: "MOXEN_THINKING_EFFORT",
  },

  // -- interface -------------------------------------------------------------
  {
    key: "ui.backdrop",
    label: "Backdrop",
    description: "The animated field behind the thread list and the new-thread view. Turn it off on a slow terminal or over SSH.",
    section: "interface",
    kind: {
      type: "enum",
      choices: [
        choice("animated", "Animated"),
        choice("static", "Static", "Drawn once, never redrawn."),
        choice("off", "Off"),
      ],
    },
    defaultValue: "animated",
  },
  {
    key: "ui.modelScenes",
    label: "Model backdrops",
    description:
      "Give each model its own scene behind the new-thread view, easing between them as you switch the model there. Off, every model keeps the monitoring field. Follows the Backdrop setting: static draws it once, off hides it.",
    section: "interface",
    kind: { type: "boolean" },
    defaultValue: true,
  },
  {
    key: "ui.hideBinaryDiffs",
    label: "Hide binary files in diffs",
    description: "Leave images, archives and other binary files out of the Diff tab, which can only say that they changed. Ignored files are never in a diff.",
    section: "interface",
    kind: { type: "boolean" },
    defaultValue: true,
  },
  {
    key: "ui.defaultSidePanel",
    label: "Side panel on open",
    description: "Which tab the side panel shows the first time it is opened in a session.",
    section: "interface",
    kind: {
      type: "enum",
      choices: [
        choice("context", "Context"),
        choice("git", "Git"),
        choice("agents", "Agents"),
        choice("background", "Background"),
      ],
    },
    defaultValue: "context",
  },
  {
    key: "ui.contextRefreshSeconds",
    label: "Context refresh",
    description: "How often an open Context tab re-reads the live breakdown.",
    section: "interface",
    kind: { type: "integer", min: 1, max: 600, unit: "s", presets: [1, 2, 5, 10, 30, 60], ends: { low: "More often", high: "Less often" } },
    defaultValue: 5,
  },
  {
    key: "ui.usageRefreshSeconds",
    label: "Usage refresh",
    description: "How often plan usage windows are re-read.",
    section: "interface",
    kind: { type: "integer", min: 5, max: 3600, unit: "s", presets: [10, 20, 60, 300, 900], ends: { low: "More often", high: "Less often" } },
    defaultValue: 20,
  },
  {
    key: "ui.autoHandoff",
    label: "Hand off long threads",
    description:
      "Models make more tool-call mistakes as the window fills, so a thread past 'Hand off at' moves to a fresh one opened with a handoff of the work so far. Ask shows a card with the action; Automatic does it by itself once no turn, subthread or background task is running; until then the card stays with a button to hand off by hand.",
    section: "turns",
    group: "Long threads",
    kind: { type: "enum", choices: [choice("ask", "Ask"), choice("auto", "Automatic"), choice("off", "Off")] },
    defaultValue: "ask",
  },
  {
    key: "ui.autoHandoffPercent",
    label: "Hand off at",
    description: "Share of the model's window at which a thread is handed off, so a model with a bigger window hands off later. Each provider's page can change it, and 'Hand off at a fixed size' wins when it is set.",
    section: "turns",
    group: "Long threads",
    kind: { type: "integer", min: 10, max: 90, unit: "%", presets: [25, 50, 75], ends: { low: "Earlier", high: "Later" } },
    defaultValue: 50,
  },
  {
    key: "ui.autoHandoffTokens",
    label: "Hand off at a fixed size",
    description: "Tokens of context at which a thread is handed off, whatever the model's window. Unset: the share above. Needs the provider to report how much context a thread uses.",
    section: "turns",
    group: "Long threads",
    kind: { type: "integer", min: 8_192, max: 2_000_000, binary: true, presets: [32_768, 65_536, 131_072, 262_144, 524_288], ends: { low: "Earlier", high: "Later" } },
    defaultValue: undefined,
  },

  {
    key: "updates.checkLatest",
    label: "Check for newer versions",
    description:
      "When the settings page opens, ask the npm registry which Claude Code and OpenCode releases are newest, so it can say whether an update is available. Nothing else is sent. Off, the page shows installed versions only.",
    section: "general",
    kind: { type: "boolean" },
    defaultValue: true,
  },

  // -- git and forges --------------------------------------------------------
  {
    key: "git.historyLimit",
    label: "Commits to load",
    description: "How many commits the Git panel reads per branch.",
    section: "git",
    kind: { type: "integer", min: 10, max: 1000, presets: [50, 100, 200, 500, 1000], ends: { low: "Fewer", high: "More" } },
    defaultValue: 50,
  },
  {
    key: "git.autoFetch",
    label: "Fetch before listing",
    description:
      "Run `git fetch` before reading history, so remote branches are current. Off by default: it touches the network on a panel open.",
    section: "git",
    kind: { type: "boolean" },
    defaultValue: false,
  },
  {
    key: "forge.enabled",
    label: "Forge integration",
    description:
      "Use `gh` or `glab` for pull and merge requests when the remote points at GitHub or GitLab. Moxen never handles their credentials — each CLI owns its own login.",
    section: "git",
    kind: { type: "boolean" },
    defaultValue: true,
  },
  {
    key: "forge.ghPath",
    label: "gh executable",
    description: "Path to the GitHub CLI, if it is not on PATH.",
    section: "git",
    kind: { type: "string", placeholder: "gh" },
    defaultValue: "gh",
  },
  {
    key: "forge.glabPath",
    label: "glab executable",
    description: "Path to the GitLab CLI, if it is not on PATH.",
    section: "git",
    kind: { type: "string", placeholder: "glab" },
    defaultValue: "glab",
  },

  // -- Claude Code -----------------------------------------------------------
  {
    key: "providers.claude.runtimeMode",
    label: "Permissions",
    description: "How much a new Claude Code thread may do without asking. Unset: the Permissions setting on the New threads tab.",
    section: "provider:claude",
    group: "New threads",
    kind: {
      type: "enum",
      choices: [
        choice("approval-required", "Supervised", "Ask before every edit and command."),
        choice("auto-accept-edits", "Auto-accept edits", "Reads and edits go through; commands still ask."),
        choice("auto", "Auto", "Claude Code's own auto mode judges each call."),
        choice("full-access", "Full access", "No prompts at all."),
      ],
    },
    defaultValue: undefined,
  },
  {
    key: "providers.claude.model",
    label: "Model",
    description: "The model a new Claude Code thread starts with when nothing more specific names one. Unset: the Model setting on the New threads tab, then the provider's own default.",
    section: "provider:claude",
    group: "New threads",
    kind: { type: "string", placeholder: "the provider's own default", source: "model", providerKind: "claude" },
    defaultValue: undefined,
  },
  {
    key: "providers.claude.thinkingEffort",
    label: "Effort",
    description: "The reasoning effort a new Claude Code thread starts at, for models that take one. Unset: the Effort setting on the New threads tab.",
    section: "provider:claude",
    group: "New threads",
    kind: { type: "string", placeholder: "the provider's own default", source: "effort", providerKind: "claude" },
    defaultValue: undefined,
  },
  {
    key: "providers.claude.moxenTools",
    label: "Moxen's tools",
    description: "Give Claude Code threads Moxen's own tools (delegate, hand off, task status). Turn off for a provider you do not want orchestrating. Applies to the next session.",
    section: "provider:claude",
    group: "Tools",
    kind: { type: "boolean" },
    defaultValue: true,
  },
  {
    key: "providers.claude.mcpExclude",
    label: "MCP servers",
    description: "Which of your MCP servers Claude Code threads get. Every server by default; switch off the ones this provider should not see. A server switched off on its own entry, or only offered to other providers, stays out either way. Applies to the next session.",
    section: "provider:claude",
    group: "Tools",
    kind: { type: "string", placeholder: "none switched off", source: "mcp-server" },
    defaultValue: undefined,
  },
  {
    key: "providers.claude.todos",
    label: "To-do list",
    description: "Let Claude Code models keep a to-do list (the Tasks panel). Applies to the next session.",
    section: "provider:claude",
    group: "Tools",
    kind: { type: "boolean" },
    defaultValue: true,
  },
  {
    key: "providers.claude.webSearchOrder",
    label: "Search order",
    description: "The order Claude Code threads should try web search tools in, when you have more than one. Tick the ones to rank and move them up or down; the model is told to go to the next only if one fails or finds nothing useful. This is advice in the prompt: it does not turn any tool off (that is Built-in tools off), and the model may still pick another. It works only with the Brave Search and Exa servers from Moxen's own list: the tools whose options Moxen knows. Applies to the next session.",
    section: "provider:claude",
    group: "Tools",
    kind: { type: "string", placeholder: "no preference", source: "web-order", web: "search" },
    defaultValue: undefined,
  },
  {
    key: "providers.claude.webFetchOrder",
    label: "Page reading order",
    description: "The order Claude Code threads should try tools that read a page in, when you have more than one. Tick the ones to rank and move them up or down; the model is told to go to the next only if one fails or finds nothing useful. This is advice in the prompt: it does not turn any tool off (that is Built-in tools off), and the model may still pick another. It works only with Moxen's web_fetch and the Exa server from Moxen's own list: the tools whose options Moxen knows. Applies to the next session.",
    section: "provider:claude",
    group: "Tools",
    kind: { type: "string", placeholder: "no preference", source: "web-order", web: "fetch" },
    defaultValue: undefined,
  },
  {
    key: "providers.claude.disabledNativeTools",
    label: "Built-in tools off",
    description: "Claude Code's own tools to switch off, as comma-separated names: Read, Write, Edit, Bash, WebSearch, WebFetch, Agent, Skill, AskUserQuestion… (any name the provider lists works). The tool is removed from the model's list. Applies to the next session.",
    section: "provider:claude",
    group: "Tools",
    kind: { type: "string", placeholder: "none switched off", source: "native-tools", tools: CLAUDE_NATIVE_TOOLS },
    defaultValue: undefined,
  },
  {
    key: "providers.claude.binaryPath",
    label: "Claude executable",
    description: "The `claude` binary to spawn. On Windows an npm shim is followed to the real package entry.",
    section: "provider:claude",
    group: "Setup",
    kind: { type: "string", placeholder: "claude" },
    defaultValue: "claude",
    restartRequired: true,
  },
  {
    key: "providers.claude.homePath",
    label: "Claude config directory",
    description:
      "Sets CLAUDE_CONFIG_DIR for spawned sessions, to run against a separate Claude home. Left empty, the CLI's own is inherited. HOME is never overridden — that would break keychain login on macOS.",
    section: "provider:claude",
    group: "Setup",
    kind: { type: "string", placeholder: "~/.claude" },
    defaultValue: "",
    restartRequired: true,
  },
  {
    key: "providers.claude.thinkingDisplay",
    label: "Thinking display",
    description:
      "How extended thinking comes back. Claude Code's `highlights` is not offered: the API allows it only for sessions Anthropic hosts, and any other client silently falls back to no thinking text at all.",
    section: "provider:claude",
    group: "Behaviour",
    kind: {
      type: "enum",
      choices: [
        choice("summarized", "Readable summaries"),
        choice("omitted", "No thinking text"),
      ],
    },
    defaultValue: "summarized",
    restartRequired: true,
  },
  {
    key: "providers.claude.promptSuggestions",
    label: "Suggest the next prompt",
    description: "Ask for one predicted next prompt after each turn, offered in the composer.",
    section: "provider:claude",
    group: "Behaviour",
    kind: { type: "boolean" },
    defaultValue: true,
    restartRequired: true,
  },
  {
    key: "providers.claude.partialMessages",
    label: "Stream token by token",
    description:
      "Take the CLI's partial-message stream so text appears as it is written. Turning it off leaves whole messages arriving at once, which is quieter over a slow link.",
    section: "provider:claude",
    group: "Behaviour",
    kind: { type: "boolean" },
    defaultValue: true,
    restartRequired: true,
  },
  {
    key: "providers.claude.agentSkills",
    label: "Skills from .agents/skills",
    description:
      "Offer the skills in a project's or your home `.agents/skills`, and moxen's own, to Claude Code through a mod, so none has to be copied into `.claude/skills`. A skill `.claude/skills` already has is left to Claude Code. Needs Claude Code 2.1.287 or newer.",
    section: "provider:claude",
    group: "Behaviour",
    kind: { type: "boolean" },
    defaultValue: true,
    restartRequired: true,
  },
  {
    key: "providers.claude.ultracode",
    label: "Ultracode",
    description:
      "Start every Claude Code session with Ultracode on: Claude plans larger jobs as workflows, spawning and coordinating many agents, and works through them until they are done. It uses far more tokens than a normal turn, and it is separate from Effort: it stays on at any level. Needs a Claude Code version that has it.",
    section: "provider:claude",
    group: "Behaviour",
    kind: { type: "boolean" },
    defaultValue: false,
    restartRequired: true,
  },
  {
    key: "providers.claude.autoCompact",
    label: "Compact long threads",
    description:
      "Who compacts a thread as it fills. Ask or Automatic: Moxen turns Claude Code's own compaction off and compacts past the share below, open or not. Ask offers a card, but a delegated task, or a thread halfway to full, is compacted unasked. Claude Code: it decides.",
    section: "provider:claude",
    group: "Long threads",
    kind: { type: "enum", choices: [choice("ask", "Ask"), choice("auto", "Automatic"), choice("claude", "Claude Code")] },
    defaultValue: "ask",
    restartRequired: true,
  },
  {
    key: "providers.claude.autoCompactPercent",
    label: "Compact at",
    description: "The share of the model's window past which Moxen compacts a thread. Hand-off has its own line, and a thread that passes the lower one first is offered that first.",
    section: "provider:claude",
    group: "Long threads",
    kind: { type: "integer", min: 10, max: 95, unit: "%", presets: [50, 65, 80, 90], ends: { low: "Earlier", high: "Later" } },
    defaultValue: 80,
    visibleWhen: { key: "providers.claude.autoCompact", in: ["ask", "auto"] },
  },
  {
    key: "providers.claude.autoCompactWindow",
    label: "Auto-compact window",
    visibleWhen: { key: "providers.claude.autoCompact", in: ["claude"] },
    description:
      "Tokens of context at which Claude Code compacts the conversation on its own, from 100K to 1M. Left unset it uses the window tuned for the model. A lower window compacts earlier and keeps long sessions cheaper and sharper.",
    section: "provider:claude",
    group: "Long threads",
    kind: { type: "integer", min: 100_000, max: 1_000_000, binary: true, presets: [131_072, 262_144, 524_288, 1_000_000], ends: { low: "Earlier", high: "Later" } },
    defaultValue: undefined,
    restartRequired: true,
  },

  ...handoffSettings("claude"),

  // -- OpenCode --------------------------------------------------------------
  {
    key: "providers.opencode.runtimeMode",
    label: "Permissions",
    description: "How much a new OpenCode thread may do without asking. Unset: the Permissions setting on the New threads tab.",
    section: "provider:opencode",
    group: "New threads",
    kind: {
      type: "enum",
      choices: [
        choice("approval-required", "Supervised", "Ask before every edit and command."),
        choice("auto-accept-edits", "Auto-accept edits", "Reads and edits go through; commands still ask."),
        choice("auto", "Auto", "OpenCode's own rules judge each call."),
        choice("full-access", "Full access", "No prompts at all."),
      ],
    },
    defaultValue: undefined,
  },
  {
    key: "providers.opencode.model",
    label: "Model",
    description: "The model a new OpenCode thread starts with when nothing more specific names one. Unset: the Model setting on the New threads tab, then the provider's own default.",
    section: "provider:opencode",
    group: "New threads",
    kind: { type: "string", placeholder: "the provider's own default", source: "model", providerKind: "opencode" },
    defaultValue: undefined,
  },
  {
    key: "providers.opencode.thinkingEffort",
    label: "Effort",
    description: "The reasoning effort a new OpenCode thread starts at, for models that take one. Unset: the Effort setting on the New threads tab.",
    section: "provider:opencode",
    group: "New threads",
    kind: { type: "string", placeholder: "the provider's own default", source: "effort", providerKind: "opencode" },
    defaultValue: undefined,
  },
  {
    key: "providers.opencode.moxenTools",
    label: "Moxen's tools",
    description: "Give OpenCode threads Moxen's own tools (delegate, hand off, task status). Turn off for a provider you do not want orchestrating. Applies to the next session.",
    section: "provider:opencode",
    group: "Tools",
    kind: { type: "boolean" },
    defaultValue: true,
  },
  {
    key: "providers.opencode.mcpExclude",
    label: "MCP servers",
    description: "Which of your MCP servers OpenCode threads get. Every server by default; switch off the ones this provider should not see. A server switched off on its own entry, or only offered to other providers, stays out either way. Applies to the next session.",
    section: "provider:opencode",
    group: "Tools",
    kind: { type: "string", placeholder: "none switched off", source: "mcp-server" },
    defaultValue: undefined,
  },
  {
    key: "providers.opencode.todos",
    label: "To-do list",
    description: "Let OpenCode models keep a to-do list (the Tasks panel). Applies to the next session.",
    section: "provider:opencode",
    group: "Tools",
    kind: { type: "boolean" },
    defaultValue: true,
  },
  {
    key: "providers.opencode.moxenPrompt",
    label: "Moxen's system prompt",
    description:
      "Replace the base system prompt OpenCode picks for the model's family with Moxen's, the one the Moxen Harness works from, written for OpenCode's tools. Your AGENTS.md files, skills, MCP guidance and Moxen's runtime instructions still apply, and an agent you gave your own `system` keeps it. OpenCode reads this when its server starts, so a change waits for the server to be idle and then restarts it.",
    section: "provider:opencode",
    group: "Tools",
    kind: { type: "boolean" },
    defaultValue: true,
  },
  {
    key: "providers.opencode.webSearchOrder",
    label: "Search order",
    description: "The order OpenCode threads should try web search tools in, when you have more than one. Tick the ones to rank and move them up or down; the model is told to go to the next only if one fails or finds nothing useful. This is advice in the prompt: it does not turn any tool off (that is Built-in tools off), and the model may still pick another. It works only with the Brave Search and Exa servers from Moxen's own list: the tools whose options Moxen knows. Applies to the next session.",
    section: "provider:opencode",
    group: "Tools",
    kind: { type: "string", placeholder: "no preference", source: "web-order", web: "search" },
    defaultValue: undefined,
  },
  {
    key: "providers.opencode.webFetchOrder",
    label: "Page reading order",
    description: "The order OpenCode threads should try tools that read a page in, when you have more than one. Tick the ones to rank and move them up or down; the model is told to go to the next only if one fails or finds nothing useful. This is advice in the prompt: it does not turn any tool off (that is Built-in tools off), and the model may still pick another. It works only with Moxen's web_fetch and the Exa server from Moxen's own list: the tools whose options Moxen knows. Applies to the next session.",
    section: "provider:opencode",
    group: "Tools",
    kind: { type: "string", placeholder: "no preference", source: "web-order", web: "fetch" },
    defaultValue: undefined,
  },
  {
    key: "providers.opencode.disabledNativeTools",
    label: "Built-in tools off",
    description: "OpenCode's own tools to switch off, as comma-separated names: read, edit, glob, grep, shell, execute, websearch, webfetch, subagent, skill, question. The tool is removed from the model's list. OpenCode reads this when its server starts, so a change waits for the server to be idle and then restarts it. Applies to the next session.",
    section: "provider:opencode",
    group: "Tools",
    kind: { type: "string", placeholder: "none switched off", source: "native-tools", tools: OPENCODE_NATIVE_TOOLS },
    defaultValue: undefined,
  },
  // `serverUrl` (an external server) is left out on purpose: v2 authenticates every
  // call and Moxen reads the external server's password only from config, so a URL
  // alone cannot work. It waits for a masked field.
  {
    key: "providers.opencode.binaryPath",
    label: "OpenCode executable",
    description: "The `opencode` binary Moxen starts its servers with, and updates.",
    section: "provider:opencode",
    group: "Setup",
    kind: { type: "string", placeholder: "opencode" },
    defaultValue: "opencode",
    restartRequired: true,
  },
  {
    key: "providers.opencode.autoCompact",
    label: "Compact automatically",
    description:
      "Whether the OpenCode servers Moxen starts summarise the conversation on their own when it nears the model's context limit. Unset: OpenCode's own config decides (on by default). Compacting by hand always works.",
    section: "provider:opencode",
    group: "Long threads",
    kind: { type: "boolean" },
    defaultValue: undefined,
    restartRequired: true,
  },
  {
    key: "providers.opencode.compactBuffer",
    label: "Compact when this much is left",
    description:
      "Tokens kept free below the model's limit: automatic compaction starts once the conversation is within this of it, so a larger value compacts earlier. Unset: OpenCode's own 10% of the window.",
    section: "provider:opencode",
    group: "Long threads",
    kind: { type: "integer", min: 0, max: 1_000_000, binary: true, presets: [8_192, 16_384, 32_768, 65_536, 131_072], ends: { low: "Later", high: "Earlier" } },
    defaultValue: undefined,
    restartRequired: true,
  },
  {
    key: "providers.opencode.bundledSkills",
    label: "Moxen's skills",
    description:
      "Offer the skills Moxen ships (threads, handoff, orchestrate and the rest) to the OpenCode servers it starts, through their `skills` config. Skills in a project's or your home `.agents/skills` need nothing: OpenCode reads those itself.",
    section: "provider:opencode",
    group: "Behaviour",
    kind: { type: "boolean" },
    defaultValue: true,
    restartRequired: true,
  },

  ...handoffSettings("opencode"),

  // -- Moxen Harness ---------------------------------------------------------
  {
    key: "providers.harness.runtimeMode",
    label: "Permissions",
    description: "How much a new Moxen Harness thread may do without asking. Unset: the Permissions setting on the New threads tab.",
    section: "provider:harness",
    group: "New threads",
    kind: {
      type: "enum",
      choices: [
        choice("approval-required", "Supervised", "Ask before every edit and command."),
        choice("auto-accept-edits", "Auto-accept edits", "Reads and edits go through; commands still ask."),
        choice("auto", "Auto", "Moxen's command classifier lets safe calls through and refuses dangerous ones."),
        choice("full-access", "Full access", "No prompts at all."),
      ],
    },
    defaultValue: undefined,
  },
  {
    key: "providers.harness.model",
    label: "Model",
    description: "The model a new Moxen Harness thread starts with when nothing more specific names one. Unset: the Model setting on the New threads tab, then the provider's own default.",
    section: "provider:harness",
    group: "New threads",
    kind: { type: "string", placeholder: "the provider's own default", source: "model", providerKind: "harness" },
    defaultValue: undefined,
  },
  {
    key: "providers.harness.thinkingEffort",
    label: "Effort",
    description: "The reasoning effort a new Moxen Harness thread starts at, for models that take one. Unset: the Effort setting on the New threads tab.",
    section: "provider:harness",
    group: "New threads",
    kind: { type: "string", placeholder: "the provider's own default", source: "effort", providerKind: "harness" },
    defaultValue: undefined,
  },
  {
    key: "providers.harness.moxenTools",
    label: "Moxen's tools",
    description: "Give Moxen Harness threads Moxen's own tools (delegate, hand off, task status). Turn off for a provider you do not want orchestrating. Applies to the next session.",
    section: "provider:harness",
    group: "Tools",
    kind: { type: "boolean" },
    defaultValue: true,
  },
  {
    key: "providers.harness.mcpExclude",
    label: "MCP servers",
    description: "Which of your MCP servers Moxen Harness threads get. Every server by default; switch off the ones this provider should not see. A server switched off on its own entry, or only offered to other providers, stays out either way. Applies to the next session.",
    section: "provider:harness",
    group: "Tools",
    kind: { type: "string", placeholder: "none switched off", source: "mcp-server" },
    defaultValue: undefined,
  },
  {
    key: "providers.harness.todos",
    label: "To-do list",
    description: "Let Moxen Harness models keep a to-do list (the Tasks panel). Applies to the next session.",
    section: "provider:harness",
    group: "Tools",
    kind: { type: "boolean" },
    defaultValue: true,
  },
  // These apply to every profile; a profile's own `compaction` fields (in the profile list below) win.
  // The driver reads the config on every turn, so none of this needs a restart.
  {
    key: "providers.harness.slots",
    label: "Requests at once",
    description: "How many requests a model server takes at the same time, for profiles that do not say (a profile's own 'Server slots' wins). Subagents, summaries and titles queue behind it. Unset: no limit. A single-GPU llama.cpp server is usually 1; /btw is refused while a turn runs on a server with one slot.",
    section: "provider:harness",
    group: "Concurrency",
    kind: { type: "integer", min: 1, max: 64, presets: [1, 2, 4, 8], ends: { low: "Fewer", high: "More" } },
    defaultValue: undefined,
  },
  {
    key: "providers.harness.autoCompact",
    label: "Compact automatically",
    description:
      "Summarise the conversation on its own when it nears the model's context window, between turns and in the middle of a long one, and when the server refuses a prompt as too long. Off leaves /compact and the rescue for a refused prompt.",
    section: "provider:harness",
    group: "Long threads",
    kind: { type: "boolean" },
    defaultValue: true,
  },
  {
    key: "providers.harness.autoCompactPercent",
    label: "Compact at (share of window)",
    description: "Kept so older configs still load: the share of the context window at which to compact. 'Compact at' (in tokens) wins when it is set.",
    section: "provider:harness",
    group: "Long threads",
    hidden: true,
    kind: { type: "integer", min: 30, max: 95, unit: "%", presets: [50, 60, 70, 80, 90] },
    defaultValue: undefined,
  },
  {
    key: "providers.harness.autoCompactTokens",
    label: "Compact at",
    description:
      "Tokens of context at which to compact. Unset: 70% of the window for windows of 128K or more and 60% for smaller ones; at least 16K tokens are always left free. Needs the model's contextWindow in its profile.",
    section: "provider:harness",
    group: "Long threads",
    kind: { type: "integer", min: 8_192, max: 2_000_000, binary: true, presets: [32_768, 65_536, 131_072, 262_144, 524_288], ends: { low: "Earlier", high: "Later" } },
    defaultValue: undefined,
  },
  {
    key: "providers.harness.keepRecentTokens",
    label: "Kept word for word",
    description: "How much of the newest conversation stays as it was when older history is summarised, in tokens.",
    section: "provider:harness",
    group: "Long threads",
    kind: { type: "integer", min: 2_000, max: 100_000, presets: [8_192, 16_384, 32_768, 65_536] },
    defaultValue: 16_384,
  },
  {
    key: "providers.harness.webSearch",
    label: "Web search",
    description:
      "Where the Moxen Harness's web_search looks. DuckDuckGo needs no account but can ask for a human check if it sees many searches. Exa and Brave are hosted APIs that need a key (saved in the keychain; their plans are metered, so check what yours charges past its free allowance). SearXNG is an instance you run.",
    section: "provider:harness",
    group: "Web",
    kind: {
      type: "enum",
      choices: [
        choice("duckduckgo", "DuckDuckGo", "No account. Unofficial, best-effort."),
        choice("exa", "Exa", "Hosted API with a key."),
        choice("brave", "Brave Search", "Hosted API with a key."),
        choice("searxng", "SearXNG", "Your own instance."),
      ],
    },
    defaultValue: "duckduckgo",
  },
  {
    key: "providers.harness.webSearchKey",
    label: "Search key",
    description: "The Exa or Brave key, typed once and kept in the OS keychain; it never appears in the config file or on screen.",
    section: "provider:harness",
    group: "Web",
    kind: { type: "secret" },
    defaultValue: undefined,
    visibleWhen: { key: "providers.harness.webSearch", in: ["exa", "brave"] },
  },
  {
    key: "providers.harness.webSearchKeyEnv",
    label: "Search key variable",
    description: "Instead of saving a key: the NAME of an environment variable that holds it, as the Moxen server sees it. A saved key wins over this.",
    section: "provider:harness",
    group: "Web",
    kind: { type: "string", placeholder: "EXA_API_KEY" },
    defaultValue: undefined,
    visibleWhen: { key: "providers.harness.webSearch", in: ["exa", "brave"] },
  },
  {
    key: "providers.harness.searxngUrl",
    label: "SearXNG address",
    description: "The address of your SearXNG instance, e.g. http://localhost:8888. Its settings must allow the json format.",
    section: "provider:harness",
    group: "Web",
    visibleWhen: { key: "providers.harness.webSearch", in: ["searxng"] },
    kind: { type: "string", placeholder: "http://localhost:8888" },
    defaultValue: undefined,
  },
  {
    key: "providers.harness.webBrowser",
    label: "Browser for web pages",
    description:
      "When a page cannot be read with a plain request (it turns the request away, or builds its content with scripts), web_fetch can load it in an installed Chrome or Chromium, headless and with a throwaway profile (none of your cookies or logins). Off never starts one.",
    section: "provider:harness",
    group: "Web",
    kind: { type: "enum", choices: [choice("auto", "When needed", "Use an installed Chrome or Chromium."), choice("off", "Never")] },
    defaultValue: "auto",
  },
  {
    key: "providers.harness.webBrowserPath",
    label: "Browser program",
    description: "The Chrome or Chromium program to use. Left unset, the usual places are searched.",
    section: "provider:harness",
    group: "Web",
    kind: { type: "string", placeholder: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
    defaultValue: undefined,
  },
  {
    key: "providers.harness.webPrivateNetwork",
    label: "Web tools reach private networks",
    description: "Let web_fetch reach addresses on your local network (10.x, 192.168.x and the like). This machine's own servers are always allowed; cloud metadata addresses never are.",
    section: "provider:harness",
    group: "Web",
    kind: { type: "boolean" },
    defaultValue: false,
  },
  ...handoffSettings("harness"),
  HARNESS_PROFILES_SETTING,

  // -- MCP servers -----------------------------------------------------------
  MCP_SERVERS_SETTING,
  MCP_RUNNER_SETTING,
];

/**
 * The order a provider's page files its settings under headings, the same on every
 * provider so Claude Code, OpenCode and the Moxen Harness read alike: what a new
 * thread starts with, the tools, how long threads are handled, then whatever is
 * particular to that provider, and where it lives last.
 */
const PROVIDER_GROUP_ORDER = ["New threads", "Tools", "Long threads", "Behaviour", "Concurrency", "Web", "Setup"];

function orderProviderGroups(settings: readonly SettingDescriptor[]): readonly SettingDescriptor[] {
  const out = [...settings];
  for (const section of ["provider:claude", "provider:opencode", "provider:harness"] as const) {
    const slots = out.flatMap((entry, at) => (entry.section === section ? [at] : []));
    const rank = (entry: SettingDescriptor): number => {
      const at = entry.group === undefined ? -1 : PROVIDER_GROUP_ORDER.indexOf(entry.group);
      // A group the table does not name (a list's own heading) stays after the named ones, in the order it was written.
      return at === -1 ? PROVIDER_GROUP_ORDER.length : at;
    };
    const sorted = slots.map((at) => out[at]!).sort((a, b) => rank(a) - rank(b));
    slots.forEach((at, index) => {
      out[at] = sorted[index]!;
    });
  }
  return out;
}

export const SETTINGS: readonly SettingDescriptor[] = orderProviderGroups(SETTINGS_IN_WRITTEN_ORDER);

const BY_KEY: ReadonlyMap<string, SettingDescriptor> = new Map(
  SETTINGS.map((descriptor) => [descriptor.key, descriptor]),
);

export function settingDescriptor(key: string): SettingDescriptor | undefined {
  return BY_KEY.get(key);
}

/** Every key, in table order — what `config set` accepts and lists on error. List keys address entries as `key[<id>]…`. */
export const SETTING_KEYS: readonly string[] = SETTINGS.map((descriptor) => descriptor.key);

const LISTS: readonly ListDescriptor[] = SETTINGS.filter((descriptor): descriptor is ListDescriptor => descriptor.kind.type === "list");

/** What a key into a list setting addresses, or null for any other key. Throws for a malformed one. */
export function listTarget(key: string): ListTarget | null {
  return key.includes("[") || LISTS.some((list) => list.key === key) ? resolveListKey(key, LISTS) : null;
}

/** Whether `config set` accepts the key: a flat key, or an entry or field of a list. */
export function isSettingKey(key: string): boolean {
  if (BY_KEY.has(key)) return true;
  try {
    return listTarget(key) !== null;
  } catch {
    return false;
  }
}

export function settingsInSection(section: SettingSection): readonly SettingDescriptor[] {
  return SETTINGS.filter((descriptor) => descriptor.section === section);
}

// -- reading and writing dotted paths ----------------------------------------

function walk(source: unknown, path: readonly string[]): unknown {
  let current: unknown = source;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * The value in force for a key: what the config holds, else the
 * descriptor's default. Unknown keys read as `undefined` rather than
 * throwing, so a config written by a newer build stays readable.
 */
export function readSetting(config: CliConfig, key: string): SettingValue {
  const entry = key.includes("[") ? listTarget(key) : null;
  if (entry) return readListScalar(config, entry);
  const raw = walk(config, key.split("."));
  if (raw === undefined || raw === null) return settingDescriptor(key)?.defaultValue;
  if (typeof raw === "string" || typeof raw === "boolean" || typeof raw === "number") return raw;
  if (key.endsWith(".autoHandoffModels") && typeof raw === "object") return formatHandoffModels(raw as Record<string, number>);
  return undefined;
}

/** A key is never written to the config: only the reference to where the keychain holds it. */
export function secretValue(key: string, text: string): string {
  if (text === "" || isSecretRef(text)) return text;
  throw new CliError("INVALID_CONFIG", `${key} holds a secret, which is kept in the OS keychain, not in the config. Set it with \`moxen config set ${key} <value>\` or on the settings page.`);
}

/**
 * The keychain name for a key that holds a secret: the key itself for a flat
 * setting, the full address for a list field (`providers.harness.profiles[colab].apiKey`).
 * Null for any other key.
 */
export function secretKeyName(key: string): string | null {
  const flat = BY_KEY.get(key);
  if (flat) return flat.kind.type === "secret" ? key : null;
  if (!key.includes("[")) return null;
  let target: ListTarget | null;
  try {
    target = listTarget(key);
  } catch {
    return null;
  }
  if (target === null || target.id === null || target.trail.length === 0) return null;
  const last = target.trail[target.trail.length - 1]!;
  if (last.field.kind.type !== "secret" || last.childId !== null) return null;
  const path = target.trail.map((step) => `${step.field.path}${step.childId === null ? "" : `[${step.childId}]`}`).join(".");
  return `${target.list.key}[${target.id}].${path}`;
}

/** Parse one `config set` argument against its descriptor. */
export function parseSettingValue(descriptor: SettingDescriptor, raw: string): SettingValue {
  const text = raw.trim();
  // An optional key (no default) set to nothing is cleared, whatever its type.
  if (text === "" && descriptor.defaultValue === undefined) return "";
  switch (descriptor.kind.type) {
    case "enum": {
      const match = descriptor.kind.choices.find((option) => option.value === text);
      if (!match) {
        const allowed = descriptor.kind.choices.map((option) => option.value).join(", ");
        throw new CliError("INVALID_CONFIG", `${descriptor.key} must be one of: ${allowed}.`);
      }
      return match.value;
    }
    case "boolean": {
      if (text === "true") return true;
      if (text === "false") return false;
      throw new CliError("INVALID_CONFIG", `${descriptor.key} must be true or false.`);
    }
    case "integer": {
      const value = Number(text);
      if (!Number.isInteger(value) || value < descriptor.kind.min || value > descriptor.kind.max) {
        throw new CliError(
          "INVALID_CONFIG",
          `${descriptor.key} must be a whole number between ${descriptor.kind.min} and ${descriptor.kind.max}.`,
        );
      }
      return value;
    }
    case "duration": {
      if (!/^\d+(?:ms|s|m|h)$/.test(text)) {
        throw new CliError("INVALID_CONFIG", `${descriptor.key} must be a duration such as 45s, 2m or 1h.`);
      }
      return text;
    }
    case "string":
      return text;
    case "secret":
      return secretValue(descriptor.key, text);
    case "list":
      throw new CliError("INVALID_CONFIG", `${descriptor.key} is a list. Address an entry: ${descriptor.key}[<id>] (JSON) or ${descriptor.key}[<id>].<field>.`);
  }
}

/**
 * A copy of `config` with `key` set, creating intermediate objects as
 * needed. An empty string clears a key that has no meaningful empty value,
 * so `config set model ""` goes back to the provider's default rather than
 * pinning the empty string.
 */
export function writeSetting(config: CliConfig, key: string, value: SettingValue): CliConfig {
  const descriptor = settingDescriptor(key);
  if (!descriptor) throw new CliError("INVALID_CONFIG_KEY", `Unknown config key: ${key}`);
  const clears = value === "" && descriptor.defaultValue !== "";
  const path = key.split(".");
  const next = { ...config } as Record<string, unknown>;
  let cursor = next;
  for (const segment of path.slice(0, -1)) {
    const existing = cursor[segment];
    const branch = existing !== null && typeof existing === "object" ? { ...(existing as Record<string, unknown>) } : {};
    cursor[segment] = branch;
    cursor = branch;
  }
  const leaf = path[path.length - 1]!;
  if (clears) delete cursor[leaf];
  else cursor[leaf] = value;
  return next as unknown as CliConfig;
}

/** Every setting with its current value — what a settings page renders from. */
export interface SettingView {
  readonly descriptor: SettingDescriptor;
  readonly value: SettingValue;
  /** True when the config file pins it, rather than it falling back to the default. */
  readonly explicit: boolean;
  /** The entries of a list setting. Absent for every other kind. */
  readonly items?: readonly ListItemView[];
  /** Why the setting can do nothing at the moment (a client greys it out and says so); absent when it can. */
  readonly unavailable?: string;
  /** For a web order: the tools it can rank, with the ones this provider cannot use marked. */
  readonly order?: readonly WebOrderEntry[];
}

/** How each list setting's entries are described, keyed by its setting key. */
const LIST_VIEWS: Readonly<Record<string, (config: CliConfig) => readonly ListItemView[]>> = {
  [HARNESS_PROFILES_SETTING.key]: describeHarnessProfiles,
  [MCP_SERVERS_SETTING.key]: (config) => describeMcpServers(config),
};

/** A web order's provider and role, from its key. */
function webOrderOf(descriptor: SettingDescriptor): { provider: "claude" | "opencode"; role: WebRole } | null {
  const match = /^providers\.(claude|opencode)\.web(Search|Fetch)Order$/.exec(descriptor.key);
  return match === null ? null : { provider: match[1] as "claude" | "opencode", role: match[2] === "Search" ? "search" : "fetch" };
}

export function describeSettings(config: CliConfig): readonly SettingView[] {
  return SETTINGS.map((descriptor) => {
    const items = LIST_VIEWS[descriptor.key]?.(config);
    const web = webOrderOf(descriptor);
    const unavailable = web === null ? undefined : webOrderUnavailable(config, web.provider, web.role);
    return {
      descriptor,
      value: readSetting(config, descriptor.key),
      explicit: walk(config, descriptor.key.split(".")) !== undefined,
      ...(items ? { items } : {}),
      ...(unavailable ? { unavailable } : {}),
      ...(web ? { order: webOrderEntries(config, web.provider, web.role) } : {}),
    };
  });
}
