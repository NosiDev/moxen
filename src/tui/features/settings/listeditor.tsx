import { useEffect, useMemo, useRef, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";

import { TextField } from "./textfield.js";
import { Slider, SliderDefault } from "../../ui/slider.js";
import { useHover } from "../../hooks/useHover.js";
import { COLOR, SURFACE, truncate } from "../../theme.js";
import { TEXT_OPTION, sliderChoices, itemRows, pairNames, selectable, withPair, type EditorOption, type EditorRow } from "../../model/listeditor.js";
import type { ListField, ListItemView, SettingDescriptor, SettingEnds } from "../../../core/configschema.js";
import type { HarnessRun } from "./useSettings.js";
import type { DiscoverResult, DiscoveredModel } from "../../../core/types.js";
import { MCP_PRESETS, PROVIDER_PRESETS, freeName, mcpTarget, type McpRunner, type ProviderPreset } from "../../../core/providers/harness/presets.js";
import { filterEntries, mcpDocument, profileDocument, tokensShort } from "../../model/addwizard.js";
import type { HarnessApiFormat } from "../../../core/types.js";

/**
 * The editor behind a list setting: today the harness profiles. Three screens
 * (the profiles, one profile, one of its models) drawn from the schema's field
 * table and the server's item views, so a field added to the schema appears
 * here with its label, choices and "where does this come from" note, and no
 * rule about a value is restated. Every change is one `settings.set` on a key
 * that addresses the entry by id; the server answers with the whole snapshot.
 */

export type Screen = { readonly profile: string | null; readonly model: string | null };

type Overlay =
  | { readonly type: "pick"; readonly title: string; readonly description: string; readonly options: readonly EditorOption[]; readonly index: number; readonly key: string; readonly value?: string; readonly ends?: SettingEnds; readonly custom?: (option: EditorOption) => void }
  | { readonly type: "multi"; readonly title: string; readonly description: string; readonly entries: readonly MultiEntry[]; readonly checked: readonly string[]; readonly filter: string; readonly index: number; readonly done: (ids: readonly string[]) => void; /** Enter saves what is checked, even nothing: the list is a set to edit, not a choice of one. */ readonly exact?: boolean }
  | { readonly type: "wait"; readonly title: string; readonly message: string }
  | { readonly type: "text"; readonly title: string; readonly hint: string; readonly initial: string; readonly placeholder: string; readonly secret: boolean; readonly submit: (text: string) => void };

interface MultiEntry {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
}

type Confirm = { readonly action: "remove-profile" | "remove-model" | "probe"; readonly id: string };

const PROBE_WARNING = "Runs about a dozen tiny requests, one at a time. On a one-slot server they replace the cached prompt of your last conversation. Press p again to run, esc to cancel.";

export function ListEditor({
  descriptor,
  items,
  screen,
  onScreen,
  heading,
  onHeading,
  saving,
  onSet,
  onDuplicate,
  run,
  onTest,
  onProbe,
  onDiscover,
  onExport,
  onImport,
  notice,
  width,
  onExit,
  canLeave,
  mcpRunner,
}: {
  descriptor: SettingDescriptor;
  items: readonly ListItemView[];
  /** Which entry (and model) is open, and the heading it is narrowed to: the page owns them, since its sidebar shows and changes both. */
  screen: Screen;
  onScreen: (screen: Screen) => void;
  heading: string | null;
  onHeading: (heading: string | null) => void;
  saving: string | null;
  onSet: (key: string, value: string) => unknown;
  onDuplicate: (id: string, newId: string) => void;
  run: HarnessRun | null;
  onTest: (profileId: string, model?: string) => void;
  onProbe: (profileId: string, model?: string) => void;
  onDiscover: (baseUrl: string, apiFormat: HarnessApiFormat, apiKeyEnv?: string) => Promise<DiscoverResult>;
  onExport: (profileId: string, file: string) => void;
  onImport: (file: string) => void;
  notice: { readonly text: string; readonly error: boolean } | null;
  width: number;
  /** The list editor was left from its first screen; `viaEscape` tells esc from the left arrow or the back button. */
  onExit: (viaEscape?: boolean) => void;
  /** False when the list is its page's whole content: there is nowhere to go back to, so no back button (esc still closes the settings). */
  canLeave?: boolean;
  /** What starts an npm package for a well-known MCP server (`mcpRunner`). */
  mcpRunner?: McpRunner;
}) {
  const kind = descriptor.kind;
  const profileFields: readonly ListField[] = kind.type === "list" ? kind.fields : [];
  const modelFields = useMemo<readonly ListField[]>(() => {
    const models = profileFields.find((field) => field.path === "models");
    return models?.kind.type === "list" ? models.kind.fields : [];
  }, [profileFields]);
  const noun = kind.type === "list" ? kind.noun : "entry";

  const setScreen = onScreen;
  const setHeading = onHeading;
  const [cursor, setCursor] = useState(0);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const profile = screen.profile === null ? undefined : items.find((item) => item.id === screen.profile);
  const model = screen.model === null ? undefined : profile?.fields.find((field) => field.path === "models")?.items?.find((entry) => entry.id === screen.model);

  // An entry that vanished (removed here or by another client) sends the screen back up.
  // Not while a save is in flight: a new entry is opened the moment it is added, before
  // the server's answer has put it in `items`.
  useEffect(() => {
    if (saving !== null) return;
    if (screen.profile !== null && profile === undefined) setScreen({ profile: null, model: null });
    else if (screen.model !== null && model === undefined) setScreen({ profile: screen.profile, model: null });
  }, [screen, profile, model, saving]);

  // A new entry, model or heading (picked in the sidebar too) starts at its first row.
  useEffect(() => setCursor(0), [screen.profile, screen.model, heading]);
  const allRows = useMemo<readonly EditorRow[]>(() => {
    if (profile === undefined) return [];
    if (model !== undefined) return itemRows(modelFields, model);
    return itemRows(profileFields, profile);
  }, [profile, model, profileFields, modelFields]);
  const headings = useMemo(() => allRows.flatMap((row) => (row.kind === "heading" ? [row.label] : [])), [allRows]);
  const rows = useMemo<readonly EditorRow[]>(() => {
    // No view of everything at once: an unset or unknown heading means the first one.
    const shown = heading !== null && headings.includes(heading) ? heading : (headings[0] ?? null);
    if (shown === null) return allRows;
    const start = allRows.findIndex((row) => row.kind === "heading" && row.label === shown);
    const next = allRows.findIndex((row, at) => at > start && row.kind === "heading");
    return allRows.slice(start, next === -1 ? undefined : next);
  }, [allRows, headings, heading]);
  const stepHeading = (delta: number) => {
    if (headings.length < 2) return;
    const at = Math.max(0, headings.indexOf(heading ?? ""));
    setHeading(headings[(at + delta + headings.length) % headings.length]!);
    setCursor(0);
  };
  // The profiles screen has its own rows: one per profile, then "add".
  const canTransfer = kind.type === "list" && kind.actions.includes("transfer");
  const listCount = items.length + 1 + (canTransfer ? 1 : 0);
  const stops = useMemo(() => (profile === undefined ? [] : rows.map((row, index) => (selectable(row) ? index : -1)).filter((index) => index >= 0)), [profile, rows]);
  const count = profile === undefined ? listCount : stops.length;
  const at = Math.min(cursor, Math.max(0, count - 1));
  const rowIndex = profile === undefined ? at : (stops[at] ?? -1);
  const activeRow = profile === undefined ? undefined : rows[rowIndex];

  const go = (next: Screen) => {
    setHeading(null);
    setScreen(next);
    setCursor(0);
    setConfirm(null);
  };

  /** One step up: cancel a pending confirm, else model → profile → list → the settings tabs. */
  const back = (viaEscape = false) => {
    if (confirm !== null) setConfirm(null);
    else if (overlay !== null) setOverlay(null);
    else if (screen.model !== null) go({ profile: screen.profile, model: null });
    else if (screen.profile !== null) go({ profile: null, model: null });
    else onExit(viaEscape);
  };

  const keyFor = (path?: string): string => {
    const base = `${descriptor.key}[${screen.profile}]`;
    if (screen.model !== null) return `${base}.models[${screen.model}]${path ? `.${path}` : ""}`;
    return `${base}${path ? `.${path}` : ""}`;
  };

  const ask = (title: string, hint: string, submit: (text: string) => void, initial = "", placeholder = "", secret = false) =>
    setOverlay({ type: "text", title, hint, initial, placeholder, secret, submit });

  /** The server whose tools a picker is waiting for the test to list, and the setting it will write. */
  const [toolsPending, setToolsPending] = useState<{ readonly id: string; readonly key: string; readonly hidden: readonly string[] } | null>(null);
  const openToolPicker = (id: string, key: string, hidden: readonly string[], tools: readonly string[]) => {
    const names = [...new Set([...tools, ...hidden])].sort((a, b) => a.localeCompare(b));
    setOverlay({
      type: "multi",
      title: "Hidden tools",
      description: `${tools.length} tool${tools.length === 1 ? "" : "s"} on ${id}. Space ticks the ones to hide from the model; enter saves, even with none ticked. Type to filter.`,
      entries: names.map((name) => ({ id: name, label: name, detail: tools.includes(name) ? "" : "not offered now" })),
      checked: hidden,
      filter: "",
      index: 0,
      exact: true,
      done: (ids) => onSet(key, ids.join(", ")),
    });
  };
  const editHiddenTools = (row: Extract<EditorRow, { kind: "field" }>, key: string) => {
    const id = screen.profile;
    if (id === null) return;
    const hidden = Array.isArray(row.value) ? row.value.map(String) : String(row.value ?? "").split(/[,\s]+/).filter((name) => name !== "");
    const known = run !== null && run.scope === "mcp" && run.profileId === id && !run.running && run.kind === "test" && "result" in run ? run.result.tools : undefined;
    if (known !== undefined && known.length > 0) return openToolPicker(id, key, hidden, known);
    // The server has not been asked yet: start it, and open the picker when it answers.
    setToolsPending({ id, key, hidden });
    setOverlay({ type: "wait", title: "Listing the server's tools…", message: `Starting ${id} to see which tools it offers. esc cancels.` });
    onTest(id);
  };
  useEffect(() => {
    if (toolsPending === null || run === null || run.scope !== "mcp" || run.profileId !== toolsPending.id || run.running) return;
    const { id, key, hidden } = toolsPending;
    setToolsPending(null);
    const tools = run.kind === "test" && "result" in run ? run.result.tools : undefined;
    if (tools !== undefined && tools.length > 0) return openToolPicker(id, key, hidden, tools);
    ask("Hidden tools", `${"error" in run ? run.error : "result" in run && "message" in run.result ? run.result.message : "The server did not answer."}\nType the tool names to hide, separated by commas.`, (text) => onSet(key, text), hidden.join(", "));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, toolsPending]);

  const edit = (row: Extract<EditorRow, { kind: "field" }>) => {
    const key = keyFor(row.path);
    if (descriptor.key === "mcpServers" && row.path === "disabledTools" && screen.model === null) return editHiddenTools(row, key);
    if (row.control.kind === "pairs") {
      const names = pairNames(row.value);
      const secret = row.control.secret;
      const options: EditorOption[] = [...names.map((name) => ({ value: name, label: name, description: secret ? "change the value, or empty to remove" : "change or remove" })), { value: TEXT_OPTION, label: "+ Add", description: "NAME=value" }];
      setOverlay({
        type: "pick",
        title: row.label,
        description: row.description,
        options,
        index: 0,
        key,
        custom: (option) => {
          if (option.value === TEXT_OPTION) {
            ask(`${row.label}: NAME=value`, "A new entry. The value is stored, not shown again.", (text) => {
              const at = text.indexOf("=");
              if (at > 0) onSet(key, withPair(row.value, text.slice(0, at).trim(), text.slice(at + 1).trim()));
            });
          } else {
            ask(`${option.value}: new value`, "Empty removes it.", (text) => onSet(key, withPair(row.value, option.value, text.trim() === "" ? "" : text.trim())));
          }
        },
      });
      return;
    }
    if (row.control.kind === "secret") {
      // Typed blind (the characters are not drawn) and sent to the keychain; an empty answer removes the saved key.
      ask(row.label, `${row.description}\n${row.value === undefined ? "No key is saved." : "A key is saved. Type a new one to replace it, or press enter on an empty line to remove it."}`, (text) => onSet(key, text.trim()), "", "paste the key, then press enter", true);
      return;
    }
    if (row.control.kind === "text") {
      ask(row.label, row.description, (text) => onSet(key, text), row.value === undefined ? "" : String(row.value));
      return;
    }
    const current = row.value === undefined ? "" : String(row.value);
    if (row.control.kind !== "pick") return;
    const options = row.control.options;
    const slider = sliderChoices(options, width - 2);
    const at = (slider?.stops ?? options).findIndex((option) => option.value === current);
    setOverlay({
      type: "pick",
      title: row.label,
      description: row.description,
      options,
      index: Math.max(0, at),
      key,
      value: current,
      ...(row.control.ends === undefined ? {} : { ends: row.control.ends }),
    });
  };

  const choose = (overlayState: Extract<Overlay, { type: "pick" }>, option: EditorOption) => {
    setOverlay(null);
    if (overlayState.custom !== undefined) {
      overlayState.custom(option);
      return;
    }
    if (option.value === TEXT_OPTION) {
      ask(overlayState.title, overlayState.description, (text) => onSet(overlayState.key, text));
      return;
    }
    onSet(overlayState.key, option.value);
  };

  /** Bumped when a flow is left, so an answer that arrives later finds nobody waiting for it. */
  const flow = useRef(0);

  /** One entry of a list the flows pick from, as an option row. */
  const startAdd = () => {
    flow.current += 1;
    if (kind.type === "list" && kind.add === "mcp-server") return startAddMcp();
    const taken = new Set(items.map((item) => item.id));
    setOverlay({
      type: "pick",
      title: "Add a provider",
      description: "What kind of server is it? This fills in the usual address and wire format; you can change the address next, and it need not be this machine.",
      options: PROVIDER_PRESETS.map((preset) => ({ value: preset.id, label: preset.label, description: preset.hint })),
      index: 0,
      key: "",
      custom: (option) => {
        const preset = PROVIDER_PRESETS.find((entry) => entry.id === option.value);
        if (preset !== undefined) askAddress(preset, taken);
      },
    });
  };

  const askAddress = (preset: ProviderPreset, taken: ReadonlySet<string>) => {
    const local = preset.baseUrl.includes("localhost");
    ask(
      `${preset.label}: server address`,
      local
        ? "Where it runs. localhost is this machine; if the server is on another one, use that machine's address, such as http://192.168.1.20:" + (preset.baseUrl.split(":").pop() ?? "8080") + "."
        : "The server's address, with or without /v1.",
      (url) => {
        const baseUrl = url.trim();
        if (baseUrl === "") return;
        if (preset.keyEnv === null) return findModels(preset, baseUrl, "", taken);
        ask(
          "Key: environment variable",
          "The NAME of the variable that holds the API key, not the key itself. Leave it empty if the server needs none. You can save the key on the profile afterwards.",
          (name) => findModels(preset, baseUrl, name.trim(), taken),
          preset.keyEnv,
          "OPENAI_API_KEY",
        );
      },
      preset.baseUrl,
      "http://192.168.1.20:8080",
    );
  };

  const findModels = (preset: ProviderPreset, baseUrl: string, keyEnv: string, taken: ReadonlySet<string>) => {
    const mine = (flow.current += 1);
    setOverlay({ type: "wait", title: "Looking for models…", message: `Asking ${baseUrl} which models it serves. esc cancels.` });
    void onDiscover(baseUrl, preset.apiFormat, keyEnv === "" ? undefined : keyEnv).then((result) => {
      if (flow.current !== mine) return;
      if (result.ok) {
        setOverlay({
          type: "multi",
          title: `Models on ${result.host}`,
          description: `${result.models.length} found. Space picks the ones to add; with none picked, enter adds the highlighted one. Type to filter.`,
          entries: result.models.map((model) => ({ id: model.id, label: model.id, detail: model.contextWindow === undefined ? "" : tokensShort(model.contextWindow) })),
          checked: [],
          filter: "",
          index: 0,
          done: (ids) => nameProvider(preset, baseUrl, keyEnv, taken, result.models.filter((model) => ids.includes(model.id))),
        });
      } else {
        ask("Model name", `${result.message}\nType the model's name as the server expects it, or esc to cancel and fix the address.`, (name) => name.trim() !== "" && nameProvider(preset, baseUrl, keyEnv, taken, [{ id: name.trim() }]));
      }
    });
  };

  const nameProvider = (preset: ProviderPreset, baseUrl: string, keyEnv: string, taken: ReadonlySet<string>, models: readonly DiscoveredModel[]) => {
    if (models.length === 0) return;
    ask("Name this provider", "Lowercase letters, digits, '.', '_' or '-'. It becomes harness/<id> in the model picker.", (id) => {
      const clean = id.trim().toLowerCase();
      if (clean === "") return;
      const saved = onSet(`${descriptor.key}[${clean}]`, profileDocument(preset, { baseUrl, keyEnv, models }));
      setScreen({ profile: clean, model: null });
      setCursor(0);
      // Check the connection right away, so the profile opens with its first answer.
      void Promise.resolve(saved).then((ok) => ok !== false && onTest(clean, models[0]!.id));
    }, freeName(preset.profileId, taken));
  };

  const startAddMcp = () => {
    const taken = new Set(items.map((item) => item.id));
    setOverlay({
      type: "pick",
      title: "Add an MCP server",
      description: "Pick a well-known server to start from, or enter your own. Models see its tools as mcp__<name>__<tool>.",
      options: [
        ...MCP_PRESETS.map((preset) => ({ value: preset.id, label: preset.label, description: preset.needs === undefined ? preset.hint : `${preset.hint} · needs ${preset.needs}` })),
        { value: "custom", label: "Custom", description: "a command to start, or an http(s) address" },
      ],
      index: 0,
      key: "",
      custom: (option) => {
        const preset = MCP_PRESETS.find((entry) => entry.id === option.value);
        const target = preset === undefined ? "" : mcpTarget(preset, mcpRunner);
        const save = (command: string, secret?: { env?: Record<string, string>; headers?: Record<string, string> }) =>
          ask("Name this server", "Letters, digits, '-' or '_'.", (name) => {
            const clean = name.trim();
            if (clean === "") return;
            const saved = onSet(`${descriptor.key}[${clean}]`, mcpDocument(command, secret));
            setScreen({ profile: clean, model: null });
            setCursor(0);
            // Connect right away and list what it offers.
            void Promise.resolve(saved).then((ok) => ok !== false && onTest(clean));
          }, freeName(preset?.name ?? "server", taken));
        // A well-known server is not asked for its command: Moxen fills it in (the command is under the server's Connection settings), and asks for the key it takes.
        if (preset !== undefined && preset.askTarget !== true && target !== "") {
          const secret = preset.secret;
          if (secret === undefined) return save(target);
          return ask(
            `${preset.label}: ${secret.label}`,
            `Kept in the OS keychain, never in the config file. Leave it empty to add the server now and set ${secret.env ?? secret.header} on it later.`,
            (key) => save(target, key.trim() === "" ? undefined : secret.header !== undefined ? { headers: { [secret.header]: key.trim() } } : secret.env !== undefined ? { env: { [secret.env]: key.trim() } } : undefined),
            "",
            "",
            true,
          );
        }
        ask(
          preset === undefined ? "Command or URL" : `${preset.label}: command`,
          preset?.needs === undefined ? "A program to start (npx -y some-mcp-server) or an http(s) address. Change it if you need another folder or option." : `A program to start, or an address. Needs ${preset.needs}.`,
          (text) => text.trim() !== "" && save(text.trim()),
          target,
          "npx -y @modelcontextprotocol/server-filesystem .",
        );
      },
    });
  };

  const canTest = kind.type === "list" && kind.actions.includes("test");
  const canProbe = kind.type === "list" && kind.actions.includes("probe");
  const selectedProfileId = screen.profile ?? items[at]?.id ?? null;

  const doTest = () => {
    if (canTest && selectedProfileId !== null && run?.running !== true) onTest(selectedProfileId, screen.model ?? undefined);
  };
  const doProbe = () => {
    if (!canProbe || selectedProfileId === null || run?.running === true) return;
    if (confirm?.action === "probe" && confirm.id === selectedProfileId) {
      setConfirm(null);
      onProbe(selectedProfileId, screen.model ?? profile?.fields.find((f) => f.path === "models")?.items?.[0]?.id);
    } else setConfirm({ action: "probe", id: selectedProfileId });
  };
  const doExport = () => {
    if (!canTransfer || selectedProfileId === null) return;
    ask("Export to a file", "Writes this profile as JSON. A saved key and probe results are left out, so the file is safe to share. `~/` is your home directory.", (file) => file.trim() !== "" && onExport(selectedProfileId, file), `~/${selectedProfileId}.moxen-profile.json`);
  };
  const doImport = () => {
    if (!canTransfer) return;
    ask("Import from a file", "A file made by Export (or `moxen harness profile export`). If its id is taken, it is added under a new one. Set the key afterwards if the server needs one.", (file) => file.trim() !== "" && onImport(file), "", "~/colab.moxen-profile.json");
  };
  const doCopy = () => {
    if (selectedProfileId === null) return;
    ask("Copy to a new id", "The copy keeps everything except probe results, which describe one server.", (newId) => onDuplicate(selectedProfileId, newId.trim()));
  };
  const doRemove = () => {
    const id = screen.model ?? selectedProfileId;
    if (id === null) return;
    const action = screen.model !== null ? "remove-model" : "remove-profile";
    if (confirm?.action === action && confirm.id === id) {
      setConfirm(null);
      onSet(action === "remove-model" ? keyFor() : `${descriptor.key}[${id}]`, "");
    } else setConfirm({ action, id });
  };

  useKeyboard((key) => {
    const escape = key.name === "escape" || key.name === "esc";
    const enter = key.name === "return" || key.name === "enter";
    // Both this editor and the settings page listen to every key. Leaving the
    // editor re-renders the page mid-dispatch, so without a claim the page would
    // see the same esc or left arrow once the editor is gone and act on it too
    // (closing, or stepping to another section). A claimed key is the page's no more.
    // A text field is the exception: it needs the keys it is typing.
    if (overlay?.type !== "text" || escape) key.preventDefault();
    if (overlay?.type === "text") {
      if (escape) setOverlay(null);
      return;
    }
    if (overlay?.type === "wait") {
      if (escape) {
        flow.current += 1;
        setToolsPending(null);
        setOverlay(null);
      }
      return;
    }
    if (overlay?.type === "multi") {
      const shown = filterEntries(overlay.entries, overlay.filter);
      if (escape) setOverlay(null);
      else if (key.name === "down") setOverlay({ ...overlay, index: Math.min(overlay.index + 1, Math.max(0, shown.length - 1)) });
      else if (key.name === "up") setOverlay({ ...overlay, index: Math.max(overlay.index - 1, 0) });
      else if (key.name === "space") {
        const entry = shown[overlay.index];
        if (entry !== undefined) setOverlay({ ...overlay, checked: overlay.checked.includes(entry.id) ? overlay.checked.filter((id) => id !== entry.id) : [...overlay.checked, entry.id] });
      } else if (enter) {
        const ids = overlay.exact === true || overlay.checked.length > 0 ? overlay.checked : shown[overlay.index] === undefined ? [] : [shown[overlay.index]!.id];
        if (ids.length > 0 || overlay.exact === true) {
          setOverlay(null);
          overlay.done(ids);
        }
      } else if (key.name === "backspace") setOverlay({ ...overlay, filter: overlay.filter.slice(0, -1), index: 0 });
      else if (!key.ctrl && !key.meta && key.sequence !== undefined && key.sequence.length === 1 && key.sequence >= " ") setOverlay({ ...overlay, filter: overlay.filter + key.sequence, index: 0 });
      return;
    }
    if (overlay?.type === "pick") {
      const slider = sliderChoices(overlay.options, width - 2);
      if (slider !== null) {
        const last = slider.stops.length - 1;
        if (escape) setOverlay(null);
        else if (key.name === "left" || key.name === "up" || key.name === "right" || key.name === "down") {
          setOverlay({ ...overlay, index: Math.max(0, Math.min(overlay.index + (key.name === "left" || key.name === "up" ? -1 : 1), last)) });
        } else if (enter || key.name === "space") {
          const option = slider.stops[overlay.index];
          if (option !== undefined) choose(overlay, option);
        } else if (key.name === "d" && slider.reset !== undefined) choose(overlay, slider.reset);
        else if ((key.name === "a" || key.name === "t") && slider.custom !== undefined) choose(overlay, slider.custom);
        return;
      }
      if (escape || key.name === "left") setOverlay(null);
      else if (key.name === "down" || (key.name === "j" && !key.ctrl)) setOverlay({ ...overlay, index: Math.min(overlay.index + 1, overlay.options.length - 1) });
      else if (key.name === "up" || (key.name === "k" && !key.ctrl)) setOverlay({ ...overlay, index: Math.max(overlay.index - 1, 0) });
      else if (enter || key.name === "space") {
        const option = overlay.options[overlay.index];
        if (option !== undefined) choose(overlay, option);
      }
      return;
    }
    if (escape || key.name === "left") return back(escape);
    if (key.name === "tab") return stepHeading(key.shift ? -1 : 1);
    if (key.name === "down" || (key.name === "j" && !key.ctrl)) return setCursor(Math.min(at + 1, Math.max(0, count - 1)));
    if (key.name === "up" || (key.name === "k" && !key.ctrl)) return setCursor(Math.max(at - 1, 0));
    const plain = !key.ctrl && !key.meta;
    if (plain && key.name === "a" && profile === undefined) return startAdd();
    if (plain && key.name === "t") return doTest();
    if (plain && key.name === "p") return doProbe();
    if (plain && key.name === "e") return doExport();
    if (plain && key.name === "i" && profile === undefined) return doImport();
    if (plain && key.name === "d") return doCopy();
    if (plain && key.name === "x") return doRemove();
    if (enter || key.name === "space" || key.name === "right") {
      if (profile === undefined) {
        const target = items[at];
        if (canTransfer && at === items.length + 1) doImport();
        else if (target === undefined) startAdd();
        else go({ profile: target.id, model: null });
        return;
      }
      if (activeRow?.kind === "field") edit(activeRow);
      else if (activeRow?.kind === "child") go({ profile: screen.profile, model: activeRow.id });
      else if (activeRow?.kind === "addChild") {
        ask("Model name", "The name the server expects.", (name) => {
          if (name.trim() !== "") onSet(`${descriptor.key}[${screen.profile}].models[${name.trim()}]`, "{}");
        });
      }
    }
  });

  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const scrollTarget = overlay?.type === "pick" || overlay?.type === "multi" ? `list-option-${overlay.index}` : `list-row-${profile === undefined ? at : rowIndex}`;
  useEffect(() => {
    const timer = setTimeout(() => scrollRef.current?.scrollChildIntoView(scrollTarget), 0);
    return () => clearTimeout(timer);
  }, [scrollTarget, screen]);

  const title = model !== undefined ? `${profile?.title} › ${model.title}` : profile !== undefined ? profile.title : descriptor.label;
  const hint = overlay?.type === "pick"
    ? "↑↓ choose · enter picks · esc back"
    : overlay?.type === "multi"
      ? "↑↓ move · space picks · type to filter · enter adds · esc cancels"
      : overlay?.type === "wait"
        ? "esc cancels"
    : overlay?.type === "text"
      ? "enter saves · esc cancels"
      : confirm?.action === "probe"
        ? PROBE_WARNING
        : confirm !== null
          ? `Press x again to remove ${confirm.id} · esc cancels`
          : profile === undefined
            ? `enter opens · a adds ${noun} · d copies${canTest ? " · t tests" : ""}${canProbe ? " · p probes" : ""}${canTransfer ? " · e exports · i imports" : ""} · x removes · esc back`
            : `enter edits · tab sections${canTest ? " · t test" : ""}${canProbe ? " · p probe" : ""}${canTransfer ? " · e export" : ""} · d copy · x remove · esc back · applies from the next ${kind.type === "list" && kind.add === "mcp-server" ? "session" : "message"}`;

  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }} backgroundColor={SURFACE.raised}>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }} backgroundColor={SURFACE.raised}>
        {canLeave === false && profile === undefined && overlay === null && confirm === null ? <text bg={SURFACE.raised}>{" "}</text> : <Chip label={`← ${model !== undefined ? profile?.title ?? "back" : profile !== undefined ? descriptor.label : "back"}`} onPress={() => back()} accent />}
        <text fg={saving !== null ? COLOR.faint : COLOR.dim} bg={SURFACE.raised} selectable={false}>{saving !== null ? "saving…" : ""}</text>
      </box>
      <box style={{ flexDirection: "column", flexShrink: 0, paddingTop: 1 }} backgroundColor={SURFACE.raised}>
        <text fg={COLOR.bright} bg={SURFACE.raised} selectable={false}>{truncate(title, width)}</text>
        {profile !== undefined && model === undefined ? <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{truncate(profile.summary, width)}</text> : null}
        {model !== undefined ? <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{truncate(model.summary, width)}</text> : null}
        {(model ?? profile)?.status ? <text fg={COLOR.warn} bg={SURFACE.raised} selectable={false}>{truncate((model ?? profile)?.status ?? "", width)}</text> : null}
        {profile !== undefined ? (
          <box style={{ flexDirection: "row", height: 1, flexShrink: 0, marginTop: 1 }} backgroundColor={SURFACE.raised}>
            {canTest ? <Chip label="Test" keyHint="t" onPress={doTest} disabled={run?.running === true} /> : null}
            {canProbe ? <Chip label="Probe" keyHint="p" onPress={doProbe} disabled={run?.running === true} /> : null}
            {canTransfer ? <Chip label="Export" keyHint="e" onPress={doExport} /> : null}
            <Chip label="Copy" keyHint="d" onPress={doCopy} />
            <Chip label={confirm?.action === "remove-profile" || confirm?.action === "remove-model" ? "Remove: click again" : "Remove"} keyHint="x" onPress={doRemove} danger />
          </box>
        ) : null}
      </box>
      <scrollbox ref={scrollRef} style={{ flexGrow: 1, marginTop: 1 }} stickyStart="top" backgroundColor={SURFACE.raised}>
        {overlay?.type === "wait" ? (
          <>
            <text fg={COLOR.bright} bg={SURFACE.raised} selectable={false}>{overlay.title}</text>
            <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>{overlay.message}</text>
          </>
        ) : overlay?.type === "multi" ? (
          <MultiPick overlay={overlay} width={width} move={(index) => setOverlay({ ...overlay, index })} toggle={(id) => setOverlay({ ...overlay, checked: overlay.checked.includes(id) ? overlay.checked.filter((entry) => entry !== id) : [...overlay.checked, id] })} />
        ) : overlay?.type === "pick" ? (
          <>
            <text fg={COLOR.bright} bg={SURFACE.raised} selectable={false}>{overlay.title}</text>
            <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>{overlay.description}</text>
            {sliderChoices(overlay.options, width - 2) !== null ? (
              <SliderPick overlay={overlay} width={width} choose={(option) => choose(overlay, option)} move={(index) => setOverlay({ ...overlay, index })} />
            ) : (
            <box style={{ flexDirection: "column", marginTop: 1 }} backgroundColor={SURFACE.raised}>
              {overlay.options.map((option, index) => (
                <Line key={`${option.value}:${index}`} id={`list-option-${index}`} left={`${index === overlay.index ? "● " : "○ "}${option.label}`} right={option.description ?? ""} active={index === overlay.index} width={width} onPress={() => choose(overlay, option)} />
              ))}
              {(() => {
                // What the row's one line cut short: the highlighted option's whole description.
                const current = overlay.options[overlay.index];
                if (current?.description === undefined || current.description.length <= Math.max(0, width - current.label.length - 12)) return null;
                return <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>{`\n${current.description}`}</text>;
              })()}
            </box>
            )}
          </>
        ) : overlay?.type === "text" ? (
          <>
            <text fg={COLOR.bright} bg={SURFACE.raised} selectable={false}>{overlay.title}</text>
            <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>{overlay.hint}</text>
            <TextField
              key={overlay.title}
              initial={overlay.initial}
              placeholder={overlay.placeholder}
              secret={overlay.secret}
              {...(overlay.secret ? { fallback: "removes the saved key" } : {})}
              width={width}
              onSubmit={(text) => {
                setOverlay(null);
                overlay.submit(text);
              }}
            />
          </>
        ) : profile === undefined ? (
          <>
            {items.length === 0 ? <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>{kind.type === "list" && kind.add === "mcp-server" ? "No MCP servers yet. Add one to give every thread its tools; each provider's page lets you switch servers off for that provider." : `No ${noun}s yet. Add one to point the Moxen Harness at a server; its models then show up in the model picker as harness/<id>.`}</text> : null}
            {items.map((item, index) => (
              <Line key={item.id} id={`list-row-${index}`} left={`${index === at ? "▌ " : "  "}${item.title}`} right={item.status ? `! ${item.status}` : item.summary} rightColor={item.status ? COLOR.warn : COLOR.dim} active={index === at} width={width} onPress={() => go({ profile: item.id, model: null })} />
            ))}
            <Line id={`list-row-${items.length}`} left={`${items.length === at ? "▌ " : "  "}+ Add ${noun}`} right="" active={items.length === at} width={width} accent onPress={startAdd} />
            {canTransfer ? <Line id={`list-row-${items.length + 1}`} left={`${items.length + 1 === at ? "▌ " : "  "}↓ Import from a file`} right="" active={items.length + 1 === at} width={width} accent onPress={doImport} /> : null}
          </>
        ) : (
          <>
          {run !== null && run.scope === (descriptor.key === "mcpServers" ? "mcp" : "harness") && run.profileId === screen.profile ? <RunPanel run={run} width={width} /> : null}
          {rows.map((row, index) => (
            <EditorLine key={`${row.kind}:${index}`} id={`list-row-${index}`} row={row} active={index === rowIndex} first={index === 0 || rows[index - 1]?.kind === "heading"} width={width} onPress={() => {
              setCursor(stops.indexOf(index));
              if (row.kind === "field") edit(row);
              else if (row.kind === "child") go({ profile: screen.profile, model: row.id });
              else if (row.kind === "addChild") ask("Model name", "The name the server expects.", (name) => name.trim() !== "" && onSet(`${descriptor.key}[${screen.profile}].models[${name.trim()}]`, "{}"));
            }} />
          ))}
          </>
        )}
        {overlay === null && notice !== null ? <text fg={notice.error ? COLOR.warn : COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>{notice.text}</text> : null}
      </scrollbox>
      <box style={{ flexDirection: "row", flexShrink: 0, marginTop: 1, ...(confirm?.action === "probe" ? {} : { height: 1 }) }} backgroundColor={SURFACE.raised}>
        <text fg={confirm !== null ? COLOR.warn : COLOR.faint} bg={SURFACE.raised} wrapMode="word" selectable={false}>{confirm?.action === "probe" ? hint : truncate(hint, width)}</text>
      </box>
    </box>
  );
}

/** A clickable label in the header: the way back, or an action on the open entry. */
function Chip({ label, keyHint, onPress, accent, danger, disabled }: { label: string; keyHint?: string; onPress: () => void; accent?: boolean; danger?: boolean; disabled?: boolean }) {
  const { hovered, handlers } = useHover();
  const bg = hovered && disabled !== true ? SURFACE.hover : SURFACE.raised;
  const fg = disabled === true ? COLOR.faint : danger ? COLOR.danger : accent ? COLOR.accent : COLOR.text;
  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0, marginRight: 1, paddingRight: 1 }} backgroundColor={bg} onMouseDown={() => disabled !== true && onPress()} selectable={false} {...handlers}>
      <text fg={fg} bg={bg} selectable={false}>{label}</text>
      {keyHint === undefined ? null : <text fg={COLOR.faint} bg={bg} selectable={false}>{` ${keyHint}`}</text>}
    </box>
  );
}

function MultiPick({ overlay, width, move, toggle }: { overlay: Extract<Overlay, { type: "multi" }>; width: number; move: (index: number) => void; toggle: (id: string) => void }) {
  const shown = filterEntries(overlay.entries, overlay.filter);
  const index = Math.min(overlay.index, Math.max(0, shown.length - 1));
  return (
    <>
      <text fg={COLOR.bright} bg={SURFACE.raised} selectable={false}>{overlay.title}</text>
      <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>{overlay.description}</text>
      <box style={{ flexDirection: "row", height: 1, marginTop: 1, paddingLeft: 1 }} backgroundColor={SURFACE.hover}>
        <text fg={COLOR.dim} bg={SURFACE.hover} selectable={false}>{"⌕  "}</text>
        <text fg={COLOR.bright} bg={SURFACE.hover} selectable={false}>{overlay.filter === "" ? "" : overlay.filter}</text>
        <text fg={overlay.filter === "" ? COLOR.faint : COLOR.accent} bg={SURFACE.hover} selectable={false}>{overlay.filter === "" ? "Search by name" : "▏"}</text>
      </box>
      <box style={{ flexDirection: "column", marginTop: 1 }} backgroundColor={SURFACE.raised}>
        {shown.length === 0 ? <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>No model matches.</text> : null}
        {shown.map((entry, at) => (
          <Line key={entry.id} id={`list-option-${at}`} left={`${at === index ? "▌ " : "  "}${overlay.checked.includes(entry.id) ? "☑" : "☐"} ${entry.label}`} right={entry.detail} active={at === index} width={width} onPress={() => { move(at); toggle(entry.id); }} />
        ))}
      </box>
      {overlay.checked.length > 0 ? <text fg={COLOR.accent} bg={SURFACE.raised} selectable={false}>{`${overlay.checked.length} picked · enter adds`}</text> : null}
    </>
  );
}

function SliderPick({
  overlay,
  width,
  choose,
  move,
}: {
  overlay: Extract<Overlay, { type: "pick" }>;
  width: number;
  choose: (option: EditorOption) => void;
  move: (index: number) => void;
}) {
  const slider = sliderChoices(overlay.options, width - 2)!;
  return (
    <>
      <Slider
        idPrefix="list-option"
        stops={slider.stops.map((option) => option.label)}
        active={overlay.index}
        chosen={slider.stops.findIndex((option) => option.value === overlay.value)}
        width={width - 2}
        {...(overlay.ends === undefined ? {} : { ends: overlay.ends })}
        caption={slider.stops[overlay.index]?.description}
        onMove={move}
        onPick={(at) => choose(slider.stops[at]!)}
      />
      {slider.reset === undefined ? null : (
        <SliderDefault id="list-option-reset" unset={overlay.value === undefined || overlay.value === ""} defaultLabel={undefined} onReset={() => choose(slider.reset!)} />
      )}
      {slider.custom === undefined ? null : <Line id="list-option-custom" left="○ Another value…" right="a" active={false} width={width} onPress={() => choose(slider.custom!)} />}
    </>
  );
}


function Line({
  id,
  left,
  right,
  rightColor,
  active,
  accent,
  width,
  onPress,
}: {
  id: string;
  left: string;
  right: string;
  rightColor?: string;
  active: boolean;
  accent?: boolean;
  width: number;
  onPress: () => void;
}) {
  const { hovered, handlers } = useHover();
  const bg = active ? SURFACE.hover : hovered ? SURFACE.border : SURFACE.raised;
  const rightWidth = Math.max(0, width - left.length - 4);
  return (
    <box id={id} style={{ flexDirection: "row", height: 1, flexShrink: 0, paddingLeft: 1, paddingRight: 1, justifyContent: "space-between" }} backgroundColor={bg} onMouseDown={onPress} selectable={false} {...handlers}>
      <text fg={accent ? COLOR.accent : active ? COLOR.bright : COLOR.text} bg={bg} selectable={false}>{truncate(left, Math.max(8, width - 4))}</text>
      {right === "" || rightWidth < 4 ? null : <text fg={rightColor ?? COLOR.dim} bg={bg} selectable={false}>{truncate(right, rightWidth)}</text>}
    </box>
  );
}

function EditorLine({ id, row, active, first, width, onPress }: { id: string; row: EditorRow; active: boolean; first: boolean; width: number; onPress: () => void }) {
  switch (row.kind) {
    case "heading":
      return (
        <box id={id} style={{ flexDirection: "row", height: 1, flexShrink: 0, marginTop: 1 }} backgroundColor={SURFACE.raised}>
          <text fg={COLOR.dim} bg={SURFACE.raised} attributes={TextAttributes.BOLD} selectable={false}>{truncate(row.label, width)}</text>
        </box>
      );
    case "resolved":
      return (
        <box id={id} style={{ flexDirection: "row", height: 1, flexShrink: 0, paddingLeft: 1, justifyContent: "space-between" }} backgroundColor={SURFACE.raised}>
          <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{truncate(`${row.label}: ${row.value}`, Math.max(8, width - row.origin.length - 6))}</text>
          <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{row.origin}</text>
        </box>
      );
    case "child":
      return <Line id={id} left={`${active ? "▌ " : "  "}${row.title}`} right={row.status ? `! ${row.summary}` : row.summary} rightColor={row.status ? COLOR.warn : COLOR.dim} active={active} width={width} onPress={onPress} />;
    case "addChild":
      return <Line id={id} left={`${active ? "▌ " : "  "}+ Add ${row.noun}`} right="" active={active} accent width={width} onPress={onPress} />;
    case "field":
      return <FieldCard id={id} row={row} active={active} first={first} width={width} onPress={onPress} />;
  }
}

const ICON = { pass: "✓", fail: "✗", inconclusive: "?", skipped: "–" } as const;
const TONE = { pass: COLOR.added, fail: COLOR.danger, inconclusive: COLOR.warn, skipped: COLOR.faint } as const;

/** The last test or probe, as a card: what ran, how it went in counts, then one row per check. */
function RunPanel({ run, width }: { run: HarnessRun; width: number }) {
  const what = run.kind === "test" ? "Test" : "Probe";
  const card = (children: React.ReactNode) => (
    <box style={{ flexDirection: "column", flexShrink: 0, marginTop: 1, paddingLeft: 1, paddingRight: 1, width }} backgroundColor={SURFACE.hover}>
      {children}
    </box>
  );
  if (run.running) {
    return card(<text fg={COLOR.dim} bg={SURFACE.hover} selectable={false}>{`${what} of ${run.profileId} running…`}</text>);
  }
  if ("error" in run) {
    return card(
      <>
        <text fg={COLOR.danger} bg={SURFACE.hover} attributes={TextAttributes.BOLD} selectable={false}>{`✗ ${what} of ${run.profileId} failed`}</text>
        <text fg={COLOR.dim} bg={SURFACE.hover} wrapMode="word" selectable={false}>{run.error}</text>
      </>,
    );
  }
  if (run.kind === "test") {
    const result = run.result;
    return card(
      <>
        <text fg={result.ok ? COLOR.added : COLOR.danger} bg={SURFACE.hover} attributes={TextAttributes.BOLD} selectable={false}>{result.ok ? `✓ ${what} of ${run.profileId} passed` : `✗ ${what} of ${run.profileId} failed`}</text>
        <text fg={COLOR.dim} bg={SURFACE.hover} wrapMode="word" selectable={false}>{result.message}</text>
      </>,
    );
  }
  const report = run.result;
  const count = (outcome: keyof typeof ICON) => report.checks.filter((check) => check.outcome === outcome).length;
  const titleWidth = Math.min(28, Math.max(0, ...report.checks.map((check) => check.title.length)));
  return card(
    <>
      <box style={{ flexDirection: "row", justifyContent: "space-between", height: 1 }} backgroundColor={SURFACE.hover}>
        <text fg={COLOR.bright} bg={SURFACE.hover} attributes={TextAttributes.BOLD} selectable={false}>{truncate(`Probe · ${report.model}`, Math.max(10, width - 24))}</text>
        <box style={{ flexDirection: "row" }} backgroundColor={SURFACE.hover}>
          {(["pass", "fail", "inconclusive"] as const).map((outcome) =>
            count(outcome) === 0 ? null : (
              <text key={outcome} fg={TONE[outcome]} bg={SURFACE.hover} selectable={false}>{`${ICON[outcome]} ${count(outcome)}  `}</text>
            ),
          )}
        </box>
      </box>
      <text fg={COLOR.dim} bg={SURFACE.hover} selectable={false}>{report.saved ? "What it found was saved to this model." : "Nothing was saved."}</text>
      <text bg={SURFACE.hover} selectable={false}>{" "}</text>
      {report.checks.map((check) => (
        <box key={check.id} style={{ flexDirection: "row", flexShrink: 0 }} backgroundColor={SURFACE.hover}>
          <text fg={TONE[check.outcome]} bg={SURFACE.hover} selectable={false}>{`${ICON[check.outcome]} `}</text>
          <box style={{ width: titleWidth + 2, flexShrink: 0 }} backgroundColor={SURFACE.hover}>
            <text fg={COLOR.text} bg={SURFACE.hover} selectable={false}>{truncate(check.title, titleWidth)}</text>
          </box>
          <box style={{ flexGrow: 1, flexShrink: 1 }} backgroundColor={SURFACE.hover}>
            <text fg={check.outcome === "fail" ? COLOR.warn : COLOR.dim} bg={SURFACE.hover} wrapMode="word" selectable={false}>{check.finding}</text>
          </box>
        </box>
      ))}
      {report.stopped ? <text fg={COLOR.warn} bg={SURFACE.hover} wrapMode="word" selectable={false}>{`\nStopped: ${report.stopped}`}</text> : null}
      {report.notes.map((note, index) => (
        <text key={index} fg={COLOR.dim} bg={SURFACE.hover} wrapMode="word" selectable={false}>{index === 0 ? `\n${note}` : note}</text>
      ))}
    </>,
  );
}

/** A field as the settings page draws one: label and value, then the description, all under one highlight. */
function FieldCard({ id, row, active, first, width, onPress }: { id: string; row: Extract<EditorRow, { kind: "field" }>; active: boolean; first: boolean; width: number; onPress: () => void }) {
  const { hovered, handlers } = useHover();
  const bg = active ? SURFACE.hover : hovered ? SURFACE.border : SURFACE.raised;
  const right = row.origin !== null ? `${row.shown}  · ${row.origin}` : row.shown;
  const rightWidth = Math.max(0, width - row.label.length - 6);
  return (
    <box id={id} style={{ flexDirection: "column", flexShrink: 0, marginTop: first ? 0 : 1, paddingLeft: 1, paddingRight: 1 }} backgroundColor={bg} onMouseDown={onPress} selectable={false} {...handlers}>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }} backgroundColor={bg}>
        <text fg={active ? COLOR.bright : COLOR.text} bg={bg} selectable={false}>{truncate(`${active ? "▌ " : "  "}${row.label}`, Math.max(8, width - 4))}</text>
        {rightWidth < 4 ? null : <text fg={row.explicit ? COLOR.accent : COLOR.dim} bg={bg} selectable={false}>{truncate(right, rightWidth)}</text>}
      </box>
      <box style={{ paddingLeft: 2 }} backgroundColor={bg}>
        <text fg={COLOR.dim} bg={bg} wrapMode="word" selectable={false}>{row.description}</text>
      </box>
    </box>
  );
}
