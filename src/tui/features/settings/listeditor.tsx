import { useEffect, useMemo, useRef, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";

import { TextField } from "./textfield.js";
import { useHover } from "../../hooks/useHover.js";
import { COLOR, SURFACE, truncate } from "../../theme.js";
import { TEXT_OPTION, itemRows, pairNames, selectable, withPair, type EditorOption, type EditorRow } from "../../model/listeditor.js";
import type { ListField, ListItemView, SettingDescriptor } from "../../../core/configschema.js";
import type { HarnessRun } from "./useSettings.js";

/**
 * The editor behind a list setting: today the harness profiles. Three screens
 * (the profiles, one profile, one of its models) drawn from the schema's field
 * table and the server's item views, so a field added to the schema appears
 * here with its label, choices and "where does this come from" note, and no
 * rule about a value is restated. Every change is one `settings.set` on a key
 * that addresses the entry by id; the server answers with the whole snapshot.
 */

type Screen = { readonly profile: string | null; readonly model: string | null };

type Overlay =
  | { readonly type: "pick"; readonly title: string; readonly description: string; readonly options: readonly EditorOption[]; readonly index: number; readonly key: string; readonly custom?: (option: EditorOption) => void }
  | { readonly type: "text"; readonly title: string; readonly hint: string; readonly initial: string; readonly placeholder: string; readonly secret: boolean; readonly submit: (text: string) => void };

type Confirm = { readonly action: "remove-profile" | "remove-model" | "probe"; readonly id: string };

const PROBE_WARNING = "Runs about a dozen tiny requests, one at a time. On a one-slot server they replace the cached prompt of your last conversation. Press p again to run, esc to cancel.";

export function ListEditor({
  descriptor,
  items,
  saving,
  onSet,
  onDuplicate,
  run,
  onTest,
  onProbe,
  onExport,
  onImport,
  notice,
  width,
  onExit,
}: {
  descriptor: SettingDescriptor;
  items: readonly ListItemView[];
  saving: string | null;
  onSet: (key: string, value: string) => void;
  onDuplicate: (id: string, newId: string) => void;
  run: HarnessRun | null;
  onTest: (profileId: string, model?: string) => void;
  onProbe: (profileId: string, model?: string) => void;
  onExport: (profileId: string, file: string) => void;
  onImport: (file: string) => void;
  notice: { readonly text: string; readonly error: boolean } | null;
  width: number;
  onExit: () => void;
}) {
  const kind = descriptor.kind;
  const profileFields: readonly ListField[] = kind.type === "list" ? kind.fields : [];
  const modelFields = useMemo<readonly ListField[]>(() => {
    const models = profileFields.find((field) => field.path === "models");
    return models?.kind.type === "list" ? models.kind.fields : [];
  }, [profileFields]);
  const noun = kind.type === "list" ? kind.noun : "entry";

  const [screen, setScreen] = useState<Screen>({ profile: null, model: null });
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

  const rows = useMemo<readonly EditorRow[]>(() => {
    if (profile === undefined) return [];
    if (model !== undefined) return itemRows(modelFields, model);
    return itemRows(profileFields, profile);
  }, [profile, model, profileFields, modelFields]);
  // The profiles screen has its own rows: one per profile, then "add".
  const canTransfer = kind.type === "list" && kind.actions.includes("transfer");
  const listCount = items.length + 1 + (canTransfer ? 1 : 0);
  const stops = useMemo(() => (profile === undefined ? [] : rows.map((row, index) => (selectable(row) ? index : -1)).filter((index) => index >= 0)), [profile, rows]);
  const count = profile === undefined ? listCount : stops.length;
  const at = Math.min(cursor, Math.max(0, count - 1));
  const rowIndex = profile === undefined ? at : (stops[at] ?? -1);
  const activeRow = profile === undefined ? undefined : rows[rowIndex];

  const go = (next: Screen) => {
    setScreen(next);
    setCursor(0);
    setConfirm(null);
  };

  /** One step up: cancel a pending confirm, else model → profile → list → the settings tabs. */
  const back = () => {
    if (confirm !== null) setConfirm(null);
    else if (screen.model !== null) go({ profile: screen.profile, model: null });
    else if (screen.profile !== null) go({ profile: null, model: null });
    else onExit();
  };

  const keyFor = (path?: string): string => {
    const base = `${descriptor.key}[${screen.profile}]`;
    if (screen.model !== null) return `${base}.models[${screen.model}]${path ? `.${path}` : ""}`;
    return `${base}${path ? `.${path}` : ""}`;
  };

  const ask = (title: string, hint: string, submit: (text: string) => void, initial = "", placeholder = "", secret = false) =>
    setOverlay({ type: "text", title, hint, initial, placeholder, secret, submit });

  const edit = (row: Extract<EditorRow, { kind: "field" }>) => {
    const key = keyFor(row.path);
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
    setOverlay({ type: "pick", title: row.label, description: row.description, options, index: Math.max(0, options.findIndex((option) => option.value === current)), key });
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

  const startAdd = () => {
    if (kind.type === "list" && kind.add === "mcp-server") return startAddMcp();
    // Each step's submit runs after the input closed itself, so asking again here simply replaces it.
    ask(`New ${noun}: id`, "Lowercase letters, digits, '.', '_' or '-'. It becomes harness/<id>.", (id) => {
      const clean = id.trim();
      if (clean === "") return;
      ask("Base URL", "The server's address, with or without /v1.", (url) => {
        ask("First model", "The model name the server expects.", (name) => {
          onSet(`${descriptor.key}[${clean}]`, JSON.stringify({ baseUrl: url.trim(), models: [{ id: name.trim() }] }));
          setScreen({ profile: clean.toLowerCase(), model: null });
          setCursor(0);
        });
      }, "", "http://localhost:8080");
    });
  };

  const startAddMcp = () => {
    ask("New server: name", "Letters, digits, '-' or '_'. Models see its tools as mcp__<name>__<tool>.", (name) => {
      const clean = name.trim();
      if (clean === "") return;
      ask("Command or URL", "A program to start (npx -y some-mcp-server) or an http(s) address.", (target) => {
        const text = target.trim();
        if (text === "") return;
        const entry = /^https?:\/\//i.test(text) ? { type: "http", url: text } : { type: "stdio", command: text.split(/\s+/)[0]!, ...(text.split(/\s+/).length > 1 ? { args: text.split(/\s+/).slice(1) } : {}) };
        onSet(`${descriptor.key}[${clean}]`, JSON.stringify(entry));
        setScreen({ profile: clean, model: null });
        setCursor(0);
      }, "", "npx -y @modelcontextprotocol/server-filesystem .");
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
    if (overlay?.type === "text") {
      if (escape) setOverlay(null);
      return;
    }
    if (overlay?.type === "pick") {
      if (escape || key.name === "left") setOverlay(null);
      else if (key.name === "down" || (key.name === "j" && !key.ctrl)) setOverlay({ ...overlay, index: Math.min(overlay.index + 1, overlay.options.length - 1) });
      else if (key.name === "up" || (key.name === "k" && !key.ctrl)) setOverlay({ ...overlay, index: Math.max(overlay.index - 1, 0) });
      else if (enter || key.name === "space") {
        const option = overlay.options[overlay.index];
        if (option !== undefined) choose(overlay, option);
      }
      return;
    }
    if (escape || key.name === "left") return back();
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
  const scrollTarget = overlay?.type === "pick" ? `list-option-${overlay.index}` : `list-row-${profile === undefined ? at : rowIndex}`;
  useEffect(() => {
    const timer = setTimeout(() => scrollRef.current?.scrollChildIntoView(scrollTarget), 0);
    return () => clearTimeout(timer);
  }, [scrollTarget, screen]);

  const title = model !== undefined ? `${profile?.title} › ${model.title}` : profile !== undefined ? profile.title : descriptor.label;
  const hint = overlay?.type === "pick"
    ? "↑↓ choose · enter picks · esc back"
    : overlay?.type === "text"
      ? "enter saves · esc cancels"
      : confirm?.action === "probe"
        ? PROBE_WARNING
        : confirm !== null
          ? `Press x again to remove ${confirm.id} · esc cancels`
          : profile === undefined
            ? `enter opens · a adds ${noun} · d copies${canTest ? " · t tests" : ""}${canProbe ? " · p probes" : ""}${canTransfer ? " · e exports · i imports" : ""} · x removes · esc back`
            : `enter edits${canTest ? " · t test" : ""}${canProbe ? " · p probe" : ""}${canTransfer ? " · e export" : ""} · d copy · x remove · esc back · applies from the next ${kind.type === "list" && kind.add === "mcp-server" ? "session" : "message"}`;

  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }} backgroundColor={SURFACE.raised}>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }} backgroundColor={SURFACE.raised}>
        <Chip label={`← ${model !== undefined ? profile?.title ?? "back" : profile !== undefined ? descriptor.label : "back"}`} onPress={back} accent />
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
        {overlay?.type === "pick" ? (
          <>
            <text fg={COLOR.bright} bg={SURFACE.raised} selectable={false}>{overlay.title}</text>
            <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>{overlay.description}</text>
            <box style={{ flexDirection: "column", marginTop: 1 }} backgroundColor={SURFACE.raised}>
              {overlay.options.map((option, index) => (
                <Line key={`${option.value}:${index}`} id={`list-option-${index}`} left={`${index === overlay.index ? "● " : "○ "}${option.label}`} right={option.description ?? ""} active={index === overlay.index} width={width} onPress={() => choose(overlay, option)} />
              ))}
            </box>
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
            {items.length === 0 ? <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>{kind.type === "list" && kind.add === "mcp-server" ? "No MCP servers yet. Add one to give every thread its tools; you can limit which providers get it afterwards." : `No ${noun}s yet. Add one to point the Moxen Harness at a server; its models then show up in the model picker as harness/<id>.`}</text> : null}
            {items.map((item, index) => (
              <Line key={item.id} id={`list-row-${index}`} left={`${index === at ? "▌ " : "  "}${item.title}`} right={item.status ? `! ${item.status}` : item.summary} rightColor={item.status ? COLOR.warn : COLOR.dim} active={index === at} width={width} onPress={() => go({ profile: item.id, model: null })} />
            ))}
            <Line id={`list-row-${items.length}`} left={`${items.length === at ? "▌ " : "  "}+ Add ${noun}`} right="" active={items.length === at} width={width} accent onPress={startAdd} />
            {canTransfer ? <Line id={`list-row-${items.length + 1}`} left={`${items.length + 1 === at ? "▌ " : "  "}↓ Import from a file`} right="" active={items.length + 1 === at} width={width} accent onPress={doImport} /> : null}
          </>
        ) : (
          rows.map((row, index) => (
            <EditorLine key={`${row.kind}:${index}`} id={`list-row-${index}`} row={row} active={index === rowIndex} first={index === 0 || rows[index - 1]?.kind === "heading"} width={width} onPress={() => {
              setCursor(stops.indexOf(index));
              if (row.kind === "field") edit(row);
              else if (row.kind === "child") go({ profile: screen.profile, model: row.id });
              else if (row.kind === "addChild") ask("Model name", "The name the server expects.", (name) => name.trim() !== "" && onSet(`${descriptor.key}[${screen.profile}].models[${name.trim()}]`, "{}"));
            }} />
          ))
        )}
        {overlay === null && notice !== null ? <text fg={notice.error ? COLOR.warn : COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>{notice.text}</text> : null}
        {overlay === null && run !== null && (screen.profile === null || run.profileId === screen.profile) ? <RunPanel run={run} width={width} /> : null}
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

/** The last test or probe, in plain sentences. */
function RunPanel({ run, width }: { run: HarnessRun; width: number }) {
  const what = run.kind === "test" ? "Test" : "Probe";
  if (run.running) {
    return <text fg={COLOR.dim} bg={SURFACE.raised} selectable={false}>{`\n${what} of ${run.profileId} running…`}</text>;
  }
  if ("error" in run) {
    return <text fg={COLOR.danger} bg={SURFACE.raised} wrapMode="word" selectable={false}>{`\n${what} of ${run.profileId} failed: ${run.error}`}</text>;
  }
  if (run.kind === "test") {
    const result = run.result;
    return <text fg={result.ok ? COLOR.added : COLOR.danger} bg={SURFACE.raised} wrapMode="word" selectable={false}>{`\n${result.ok ? "✓" : "✗"} ${result.message}`}</text>;
  }
  const report = run.result;
  return (
    <box style={{ flexDirection: "column", flexShrink: 0, marginTop: 1 }} backgroundColor={SURFACE.raised}>
      <text fg={COLOR.bright} bg={SURFACE.raised} selectable={false}>{truncate(`Probe of ${report.profileId} / ${report.model}${report.saved ? " · saved" : " · nothing saved"}`, width)}</text>
      {report.checks.map((check) => (
        <text key={check.id} fg={TONE[check.outcome]} bg={SURFACE.raised} wrapMode="word" selectable={false}>{`${ICON[check.outcome]} ${check.title}: ${check.finding}`}</text>
      ))}
      {report.stopped ? <text fg={COLOR.warn} bg={SURFACE.raised} wrapMode="word" selectable={false}>{`Stopped: ${report.stopped}`}</text> : null}
      {report.notes.map((note, index) => (
        <text key={index} fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>{`Note: ${note}`}</text>
      ))}
    </box>
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
