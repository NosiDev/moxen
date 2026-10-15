import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { StyledText, TextAttributes, fg } from "@opentui/core";
import { useKeyboard } from "@opentui/react";

import { ListEditor } from "./listeditor.js";
import { TextField } from "./textfield.js";
import type { HarnessRun } from "./useSettings.js";
import type { ListItemView } from "../../../core/configschema.js";
import { ModalShell } from "../../ui/modalshell.js";
import { markModalDismissed } from "../../model/modalDismiss.js";
import { useHover } from "../../hooks/useHover.js";
import { COLOR, SURFACE, truncate } from "../../theme.js";
import { splitInlineCode } from "../../model/inlinecode.js";
import { providerVersionLine, settingControl, settingValueLabel, updatableProviderOf, type LatestView, type ProviderCheckView, type SettingControl } from "../../model/settings.js";
import type { LatestVersions, UpdatableProvider } from "../../../core/catalog/update.js";
import {
  SECTION_LABEL,
  SETTING_SECTIONS,
  type SettingDescriptor,
  type SettingSection,
  type SettingValue,
} from "../../../core/configschema.js";
import type { ProviderSummary } from "../../../core/catalog/summary.js";
import type { SettingsSnapshot } from "../../../server/api.js";

/**
 * The settings page: one tab per schema section down the left, a rule, and
 * that section's settings on the right.
 *
 * Every row is generated from the core schema table rather than written
 * here, which is the whole point: a setting added to `core/configschema.ts`
 * shows up in this page and in `moxen config set` at the same time, with
 * the same label, the same choices and the same validation. There is no
 * list of keys in this file.
 *
 * Nothing is typed that can be picked (`model/settings.ts` decides): a
 * boolean flips in place, everything with a known set of values — enums,
 * presets, the provider catalog's providers, models and efforts — opens a
 * list in the right pane, and only what only the user knows (a path, extra
 * instructions) swaps the row for an input. Nothing is optimistic — see
 * `useSettings` — so a refused value visibly stays refused.
 */

interface SettingItem {
  readonly descriptor: SettingDescriptor;
  readonly value: SettingValue;
  readonly explicit: boolean;
  readonly control: SettingControl;
  /** The entries of a list setting. */
  readonly entries?: readonly ListItemView[];
}

/** The left column: section labels plus the selection bar and a gap. */
const TAB_WIDTH = 20;

export function SettingsModal({
  snapshot,
  loading,
  saving,
  error,
  onSet,
  onDuplicate,
  run,
  onTest,
  onTestMcp,
  onProbe,
  onExport,
  onImport,
  notice,
  versions,
  latest,
  updating,
  onUpdate,
  providers,
  screenWidth,
  screenHeight,
  left,
  top,
  width,
  height,
  onClose,
}: {
  snapshot: SettingsSnapshot | null;
  loading: boolean;
  saving: string | null;
  error: string | null;
  onSet: (key: string, value: string) => void;
  onDuplicate: (key: string, id: string, newId: string) => void;
  /** The last test or probe of a harness profile, while it runs and after. */
  run: HarnessRun | null;
  onTest: (profileId: string, model?: string) => void;
  /** Start an MCP server and list its tools. */
  onTestMcp: (name: string) => void;
  onProbe: (profileId: string, model?: string) => void;
  onExport: (profileId: string, file: string) => void;
  onImport: (file: string) => void;
  notice: { readonly text: string; readonly error: boolean } | null;
  /** Each updatable provider's install, from the doctor query; null until it answers. */
  versions: { readonly claude: ProviderCheckView; readonly opencode: ProviderCheckView } | null;
  /** The newest release of each, from the registry; null until it answers. */
  latest: LatestVersions | null;
  /** The providers whose updater is running now. */
  updating: ReadonlySet<UpdatableProvider>;
  onUpdate: (provider: UpdatableProvider) => void;
  /** The provider catalog: what the model defaults offer. Null while it loads. */
  providers: readonly ProviderSummary[] | null;
  screenWidth: number;
  screenHeight: number;
  left: number;
  top: number;
  width: number;
  height: number;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<SettingSection>(SETTING_SECTIONS[0]);
  const [index, setIndex] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  /** The setting whose list is open in the right pane, and the highlighted option. */
  const [picking, setPicking] = useState<{ key: string; index: number } | null>(null);
  /** The list setting whose editor fills the right pane. */
  const [listOpen, setListOpen] = useState<string | null>(null);

  const sections = useMemo(
    () => SETTING_SECTIONS.filter((section) => snapshot?.settings.some((view) => view.descriptor.section === section) === true),
    [snapshot],
  );
  const items = useMemo<readonly SettingItem[]>(() => {
    if (!snapshot) return [];
    const valueOf = (key: string): string => {
      const view = snapshot.settings.find((entry) => entry.descriptor.key === key);
      return view?.value === undefined ? "" : String(view.value);
    };
    return snapshot.settings
      .filter((view) => view.descriptor.section === tab)
      .filter((view) => view.descriptor.visibleWhen === undefined || view.descriptor.visibleWhen.in.includes(valueOf(view.descriptor.visibleWhen.key)))
      .map((view) => ({
        descriptor: view.descriptor,
        value: view.value,
        explicit: view.explicit,
        control: settingControl(view.descriptor, view.value, snapshot.settings, providers),
        ...(view.items ? { entries: view.items } : {}),
      }));
  }, [snapshot, tab, providers]);

  /** The provider the open tab is about, when it can be updated from here. */
  const updatable = updatableProviderOf(tab);

  const safe = items.length === 0 ? -1 : Math.min(index, items.length - 1);
  const current = safe >= 0 ? items[safe] : undefined;
  const pickItem = picking === null ? undefined : items.find((item) => item.descriptor.key === picking.key);
  const pickOptions = pickItem?.control.kind === "pick" ? pickItem.control.options : [];

  // Leaving a row abandons an edit in progress rather than carrying the
  // half-typed text onto the next setting.
  useEffect(() => setEditing(null), [safe, tab]);

  const switchTab = (next: SettingSection) => {
    setTab(next);
    setIndex(0);
    setPicking(null);
    setListOpen(null);
  };
  const stepTab = (delta: number) => {
    if (sections.length === 0) return;
    const at = Math.max(0, sections.indexOf(tab));
    switchTab(sections[(at + delta + sections.length) % sections.length]!);
  };

  const activate = (item: SettingItem) => {
    if (item.control.kind === "list") {
      setListOpen(item.descriptor.key);
      return;
    }
    if (item.control.kind === "toggle") {
      onSet(item.descriptor.key, item.value === true ? "false" : "true");
      return;
    }
    if (item.control.kind === "text" || item.control.kind === "secret") {
      setEditing(item.descriptor.key);
      return;
    }
    const currentValue = item.value === undefined ? "" : String(item.value);
    if (item.control.kind !== "pick") return;
    setPicking({ key: item.descriptor.key, index: Math.max(0, item.control.options.findIndex((entry) => entry.value === currentValue)) });
  };
  const choose = (key: string, value: string) => {
    setPicking(null);
    onSet(key, value);
  };

  const listItem = listOpen === null ? undefined : items.find((item) => item.descriptor.key === listOpen);

  useKeyboard((key) => {
    // The list editor owns every key while it is open.
    if (listOpen !== null) return;
    const escape = key.name === "escape" || key.name === "esc";
    const enter = key.name === "return" || key.name === "enter";
    if (editing !== null) {
      // The input owns its own keys; only escape is taken back, so a
      // half-typed value can be abandoned without closing the page.
      if (escape) setEditing(null);
      return;
    }
    if (picking !== null) {
      if (escape || key.name === "left") setPicking(null);
      else if (key.name === "down" || (key.name === "j" && !key.ctrl)) {
        setPicking({ ...picking, index: Math.min(picking.index + 1, Math.max(0, pickOptions.length - 1)) });
      } else if (key.name === "up" || (key.name === "k" && !key.ctrl)) {
        setPicking({ ...picking, index: Math.max(picking.index - 1, 0) });
      } else if (enter || key.name === "space") {
        const option = pickOptions[picking.index];
        if (option !== undefined) choose(picking.key, option.value);
      }
      return;
    }
    if (escape) {
      markModalDismissed();
      onClose();
      return;
    }
    if (key.name === "u" && !key.ctrl && !key.meta && updatable !== null) {
      onUpdate(updatable);
      return;
    }
    if (key.name === "tab") {
      stepTab(key.shift ? -1 : 1);
      return;
    }
    if (key.name === "left" || key.name === "right") {
      stepTab(key.name === "left" ? -1 : 1);
      return;
    }
    if (key.name === "down" || (key.name === "j" && !key.ctrl)) {
      setIndex((at) => Math.min(at + 1, Math.max(0, items.length - 1)));
      return;
    }
    if (key.name === "up" || (key.name === "k" && !key.ctrl)) {
      setIndex((at) => Math.max(at - 1, 0));
      return;
    }
    if ((enter || key.name === "space") && current !== undefined) activate(current);
  });

  // Keep the selected setting (or option) in view. Cards wrap their
  // descriptions, so their heights are the layout's to know, not ours.
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const scrollTarget = picking !== null ? `settings-option-${picking.index}` : current === undefined ? null : editing !== null ? `settings-edit-${editing}` : `settings-row-${current.descriptor.key}`;
  useEffect(() => {
    if (scrollTarget === null) return;
    // An opening editor changes the card's height after this render, so it gets a moment to lay out.
    const timer = setTimeout(() => scrollRef.current?.scrollChildIntoView(scrollTarget), scrollTarget.startsWith("settings-edit-") ? 120 : 0);
    return () => clearTimeout(timer);
  }, [scrollTarget]);

  const inner = Math.max(40, width - 4);
  const paneWidth = Math.max(24, inner - TAB_WIDTH - 3);

  const base =
    picking !== null
      ? "↑↓ choose · enter picks · esc back"
      : current?.control.kind === "text" || current?.control.kind === "secret"
        ? "enter edits · tab next section · esc closes"
        : current?.control.kind === "toggle"
          ? "enter switches · tab next section · esc closes"
          : "enter opens the choices · tab next section · esc closes";
  const hint = listOpen !== null ? "" : picking === null && updatable !== null ? `u updates · ${base}` : base;

  return (
    <ModalShell screenWidth={screenWidth} screenHeight={screenHeight} left={left} top={top} width={width} height={height} onClose={onClose}>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }}>
        <text fg={COLOR.bright} bg={SURFACE.raised} selectable={false}>{"Settings"}</text>
        <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{"esc"}</text>
      </box>
      {snapshot === null ? (
        <box style={{ flexDirection: "column", marginTop: 1 }}>
          <text fg={COLOR.dim} bg={SURFACE.raised}>{loading ? "Reading settings…" : (error ?? "No settings available.")}</text>
        </box>
      ) : (
        <>
          <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
            <text fg={COLOR.faint} bg={SURFACE.raised}>
              {truncate(snapshot.exists ? snapshot.path : `${snapshot.path} (not created yet)`, inner)}
            </text>
          </box>
          <box style={{ flexDirection: "row", flexGrow: 1, marginTop: 1 }}>
            <box style={{ flexDirection: "column", width: TAB_WIDTH, flexShrink: 0 }}>
              {sections.map((section) => (
                <SectionTab key={section} label={SECTION_LABEL[section]} active={section === tab} width={TAB_WIDTH} onSelect={() => switchTab(section)} />
              ))}
            </box>
            <box
              style={{ flexDirection: "column", flexGrow: 1, paddingLeft: 2 }}
              border={["left"]}
              borderColor={SURFACE.border}
              backgroundColor={SURFACE.raised}
            >
              {listItem !== undefined && listOpen !== null ? (
                <ListEditor
                  descriptor={listItem.descriptor}
                  items={listItem.entries ?? []}
                  saving={saving}
                  onSet={onSet}
                  onDuplicate={(id, newId) => onDuplicate(listItem.descriptor.key, id, newId)}
                  run={run}
                  onTest={(id, model) => (listItem.descriptor.key === "mcpServers" ? onTestMcp(id) : onTest(id, model))}
                  onProbe={onProbe}
                  onExport={onExport}
                  onImport={onImport}
                  notice={notice}
                  width={paneWidth}
                  onExit={() => setListOpen(null)}
                />
              ) : pickItem !== undefined && picking !== null ? (
                <>
                  <BackButton onBack={() => setPicking(null)} />
                  <box style={{ flexDirection: "column", flexShrink: 0, paddingTop: 1 }}>
                    <text fg={COLOR.bright} bg={SURFACE.raised} selectable={false}>{pickItem.descriptor.label}</text>
                    <text content={prose(pickItem.descriptor.description, COLOR.dim)} bg={SURFACE.raised} wrapMode="word" />
                  </box>
                  <scrollbox ref={scrollRef} style={{ flexGrow: 1, marginTop: 1 }} stickyStart="top" backgroundColor={SURFACE.raised}>
                    {pickOptions.length <= 1 && pickItem.descriptor.kind.type === "string" && providers === null ? (
                      <text fg={COLOR.dim} bg={SURFACE.raised}>{"Loading the provider catalog…"}</text>
                    ) : null}
                    {pickOptions.map((option, optionIndex) => (
                      <OptionRow
                        key={`${option.value}:${optionIndex}`}
                        id={`settings-option-${optionIndex}`}
                        label={option.label}
                        description={option.description}
                        chosen={option.value === (pickItem.value === undefined ? "" : String(pickItem.value))}
                        active={optionIndex === picking.index}
                        width={paneWidth}
                        onPick={() => choose(pickItem.descriptor.key, option.value)}
                      />
                    ))}
                  </scrollbox>
                </>
              ) : (
                <>
                  {updatable === null ? null : (
                    <ProviderUpdateCard
                      provider={updatable}
                      check={versions?.[updatable]}
                      latest={latest === null ? undefined : { enabled: latest.enabled, ...latest[updatable] }}
                      updating={updating.has(updatable)}
                      width={paneWidth}
                      onUpdate={() => onUpdate(updatable)}
                    />
                  )}
                <scrollbox ref={scrollRef} style={{ flexGrow: 1 }} stickyStart="top" backgroundColor={SURFACE.raised}>
                  {items.map((item, itemIndex) => {
                    const group = item.descriptor.group;
                    const startsGroup = group !== undefined && group !== items[itemIndex - 1]?.descriptor.group;
                    return (
                    <Fragment key={item.descriptor.key}>
                    {startsGroup ? (
                      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, marginTop: itemIndex === 0 ? 0 : 1, paddingLeft: 1 }} backgroundColor={SURFACE.raised}>
                        <text fg={COLOR.dim} bg={SURFACE.raised} attributes={TextAttributes.BOLD} selectable={false}>{truncate(group ?? "", paneWidth)}</text>
                      </box>
                    ) : null}
                    <SettingCard
                      item={item}
                      first={itemIndex === 0 || startsGroup}
                      active={itemIndex === safe}
                      editing={editing === item.descriptor.key}
                      pending={saving === item.descriptor.key}
                      width={paneWidth}
                      onGrow={() => scrollRef.current?.scrollChildIntoView(`settings-edit-${item.descriptor.key}`)}
                      onActivate={() => {
                        setIndex(itemIndex);
                        activate(item);
                      }}
                      onSubmit={(text) => {
                        setEditing(null);
                        onSet(item.descriptor.key, text);
                      }}
                    />
                    </Fragment>
                    );
                  })}
                </scrollbox>
                </>
              )}
            </box>
          </box>
          <box style={{ flexDirection: "column", flexShrink: 0, marginTop: 1 }}>
            {error === null ? null : (
              <box style={{ flexDirection: "row", height: 1 }}>
                <text fg={COLOR.danger} bg={SURFACE.raised}>{truncate(error, inner)}</text>
              </box>
            )}
            <box style={{ flexDirection: "row", height: 1 }}>
              <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{truncate(hint, inner)}</text>
            </box>
          </box>
        </>
      )}
    </ModalShell>
  );
}

/** Prose whose `backticked` parts read as code: a colour of their own, and no backticks printed. */
function prose(text: string, base: string): StyledText {
  return new StyledText(splitInlineCode(text).map((segment) => fg(segment.code ? COLOR.command : base)(segment.text)));
}

/** Back out of a setting's choices to the list: the click twin of esc and the left arrow. */
function BackButton({ onBack }: { onBack: () => void }) {
  const { hovered, handlers } = useHover();
  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }} backgroundColor={SURFACE.raised} onMouseDown={onBack} selectable={false} {...handlers}>
      <text fg={hovered ? COLOR.bright : COLOR.accent} bg={SURFACE.raised} selectable={false}>{"← back"}</text>
    </box>
  );
}

const PROVIDER_NAME: Record<UpdatableProvider, string> = { claude: "Claude Code", opencode: "OpenCode" };
const PROVIDER_UPDATER: Record<UpdatableProvider, string> = { claude: "claude update", opencode: "opencode upgrade" };

/**
 * Where a provider's install stands, and the button that runs its own updater
 * (`claude update`, `opencode upgrade`): the version, whether it meets what
 * Moxen needs, and what pressing it does. Sessions already running are never
 * restarted; the result lands in a toast.
 */
function ProviderUpdateCard({
  provider,
  check,
  latest,
  updating,
  width,
  onUpdate,
}: {
  provider: UpdatableProvider;
  check: ProviderCheckView | undefined;
  latest: LatestView | undefined;
  updating: boolean;
  width: number;
  onUpdate: () => void;
}) {
  const { hovered, handlers } = useHover();
  const line = providerVersionLine(check, latest);
  const tone = line.tone === "warn" ? COLOR.warn : line.tone === "update" ? COLOR.accent : line.tone === "ok" ? COLOR.added : COLOR.dim;
  const button = updating ? "[ Updating… ]" : line.button;
  // Nothing newer to go to: the button says so and steps back, though pressing it still runs the updater.
  const buttonColor = updating || line.settled ? COLOR.dim : hovered ? COLOR.bright : COLOR.accent;
  return (
    <box
      style={{ flexDirection: "column", flexShrink: 0, marginBottom: 1, paddingTop: 1, paddingBottom: 1, paddingLeft: 1, paddingRight: 1, width }}
      backgroundColor={SURFACE.panel}
      selectable={false}
    >
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }} backgroundColor={SURFACE.panel}>
        <box style={{ flexDirection: "row" }} backgroundColor={SURFACE.panel}>
          <text fg={COLOR.bright} bg={SURFACE.panel} selectable={false}>{PROVIDER_NAME[provider]}</text>
          <text fg={COLOR.dim} bg={SURFACE.panel} selectable={false}>{`  ${line.version ?? "—"}`}</text>
        </box>
        <box {...(updating ? {} : { onMouseDown: onUpdate, ...handlers })} backgroundColor={SURFACE.panel}>
          <text fg={buttonColor} bg={SURFACE.panel} selectable={false}>{button}</text>
        </box>
      </box>
      <text fg={tone} bg={SURFACE.panel} wrapMode="word" selectable={false}>{line.status}</text>
      <text content={prose(`Runs \`${PROVIDER_UPDATER[provider]}\`. Sessions already running keep the old build until they restart.`, COLOR.dim)} bg={SURFACE.panel} wrapMode="word" selectable={false} />
    </box>
  );
}

function SectionTab({ label, active, width, onSelect }: { label: string; active: boolean; width: number; onSelect: () => void }) {
  const { hovered, handlers } = useHover();
  const bg = active ? SURFACE.hover : hovered ? SURFACE.border : SURFACE.raised;
  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0, marginRight: 1 }} backgroundColor={bg} onMouseDown={onSelect} selectable={false} {...handlers}>
      <text fg={active ? COLOR.accent : COLOR.faint} bg={bg} selectable={false}>{active ? "▌ " : "  "}</text>
      <text fg={active ? COLOR.bright : hovered ? COLOR.text : COLOR.dim} bg={bg} selectable={false}>{truncate(label, width - 3)}</text>
    </box>
  );
}

/** The value side of a card: a switch, a list to open, or text to edit. */
function valueText(item: SettingItem): string {
  const label = settingValueLabel(item.descriptor, item.value, item.control, item.entries?.length);
  if (item.control.kind === "list") return `${label}  ›`;
  if (item.control.kind === "toggle") return item.value === true ? "● On" : "○ Off";
  if (item.control.kind === "pick") return `${label}  ›`;
  return label;
}

function SettingCard({
  item,
  first,
  active,
  editing,
  pending,
  width,
  onActivate,
  onGrow,
  onSubmit,
}: {
  item: SettingItem;
  /** The top card sits flush with the first tab beside it; the others are spaced from the one above. */
  first: boolean;
  active: boolean;
  editing: boolean;
  pending: boolean;
  width: number;
  onActivate: () => void;
  onGrow: () => void;
  onSubmit: (text: string) => void;
}) {
  const { hovered, handlers } = useHover();
  const { descriptor, value, explicit } = item;
  const secret = descriptor.kind.type === "secret";
  const bg = active ? SURFACE.hover : hovered ? SURFACE.border : SURFACE.raised;
  const shown = `${pending ? "· " : ""}${valueText(item)}`;
  const note = descriptor.restartRequired === true ? "  next start" : "";
  const labelWidth = Math.max(8, width - shown.length - note.length - 4);
  const valueColor = pending
    ? COLOR.faint
    : item.control.kind === "toggle"
      ? value === true
        ? COLOR.added
        : COLOR.dim
      : explicit
        ? COLOR.accent
        : COLOR.text;

  return (
    <box
      id={`settings-row-${descriptor.key}`}
      style={{ flexDirection: "column", flexShrink: 0, marginTop: first ? 0 : 1, paddingLeft: 1, paddingRight: 1 }}
      backgroundColor={bg}
      {...(editing ? {} : { onMouseDown: onActivate })}
      selectable={false}
      {...handlers}
    >
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, justifyContent: "space-between" }} backgroundColor={bg}>
        <box style={{ flexDirection: "row", height: 1, flexShrink: 1 }} backgroundColor={bg}>
          <text fg={active ? COLOR.bright : COLOR.text} bg={bg} selectable={false}>{truncate(descriptor.label, labelWidth)}</text>
          {note === "" ? null : <text fg={COLOR.faint} bg={bg} selectable={false}>{note}</text>}
        </box>
        {editing ? null : <text fg={valueColor} bg={bg} selectable={false}>{shown}</text>}
      </box>
      {editing ? (
        <TextField
          id={`settings-edit-${descriptor.key}`}
          initial={secret || value === undefined ? "" : String(value)}
          placeholder={secret ? "paste the key, then press enter" : descriptor.kind.type === "string" ? (descriptor.kind.placeholder ?? "") : ""}
          multiline={descriptor.kind.type === "string" && descriptor.kind.multiline === true}
          secret={secret}
          fallback={secret ? "removes the saved key" : descriptor.defaultValue === undefined || descriptor.defaultValue === "" ? "unset" : `the default, ${String(descriptor.defaultValue)}`}
          width={width}
          onGrow={onGrow}
          onSubmit={onSubmit}
        />
      ) : null}
      <text content={prose(descriptor.description, COLOR.dim)} bg={bg} wrapMode="word" selectable={false} />
    </box>
  );
}

function OptionRow({
  id,
  label,
  description,
  chosen,
  active,
  width,
  onPick,
}: {
  id: string;
  label: string;
  description: string | undefined;
  chosen: boolean;
  active: boolean;
  width: number;
  onPick: () => void;
}) {
  const { hovered, handlers } = useHover();
  const bg = active ? SURFACE.hover : hovered ? SURFACE.border : SURFACE.raised;
  const detail = description === undefined ? "" : truncate(description, Math.max(0, width - label.length - 8));
  return (
    <box id={id} style={{ flexDirection: "row", height: 1, flexShrink: 0, paddingLeft: 1, paddingRight: 1, justifyContent: "space-between" }} backgroundColor={bg} onMouseDown={onPick} selectable={false} {...handlers}>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }} backgroundColor={bg}>
        <text fg={chosen ? COLOR.accent : COLOR.faint} bg={bg} selectable={false}>{chosen ? "● " : "○ "}</text>
        <text fg={active || chosen ? COLOR.bright : COLOR.text} bg={bg} selectable={false}>{label}</text>
      </box>
      {detail === "" ? null : <text fg={COLOR.dim} bg={bg} selectable={false}>{detail}</text>}
    </box>
  );
}
