import { useEffect, useRef, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";

import { useHover } from "../../hooks/useHover.js";
import { COLOR, SURFACE, truncate } from "../../theme.js";
import { handoffStops, handoffTokensLabel, type HandoffModelEntry } from "../../model/settings.js";
import { sliderLayout } from "../../model/slider.js";
import { Slider, SliderDefault } from "../../ui/slider.js";

/**
 * The hand-off or compaction size of each model of one provider. A list of the provider's
 * models, each with its own size or "uses provider setting"; enter opens a
 * slider of sizes for that model, and `d` takes its override away. A choice
 * is applied at once; the setting keeps every other model's override as it was.
 */
export function HandoffModelsEditor({
  title,
  description,
  action,
  models,
  width,
  catalogReady,
  onChange,
  onExit,
}: {
  title: string;
  description: string;
  /** What happens at the size: "handed off" or "compacted". */
  action: "handed off" | "compacted";
  models: readonly HandoffModelEntry[];
  width: number;
  /** False while the provider catalog is still loading, so an empty list is not read as "no models". */
  catalogReady: boolean;
  /** Set a model's size, or null to remove its override. */
  onChange: (slug: string, tokens: number | null) => void;
  onExit: () => void;
}) {
  const [cursor, setCursor] = useState(0);
  /** The model whose slider is open, and the stop it is over. */
  const [sliding, setSliding] = useState<{ slug: string; index: number } | null>(null);
  const at = Math.min(cursor, Math.max(0, models.length - 1));
  const open = sliding === null ? undefined : models.find((model) => model.slug === sliding.slug);
  const stops = handoffStops(open?.tokens ?? null);
  const labels = stops.map(handoffTokensLabel);
  const track = sliderLayout(labels, width - 2).fits;

  const openSlider = (model: HandoffModelEntry | undefined) => {
    if (model === undefined) return;
    const list = handoffStops(model.tokens);
    // Nothing set opens on 200K, a middling window, rather than at an end.
    const start = model.tokens === null ? list.indexOf(200_000) : list.indexOf(model.tokens);
    setSliding({ slug: model.slug, index: Math.max(0, start) });
  };
  const pick = (index: number) => {
    if (open === undefined || stops[index] === undefined) return;
    onChange(open.slug, stops[index]!);
    setSliding(null);
  };
  const clear = (model: HandoffModelEntry | undefined) => {
    if (model === undefined || model.tokens === null) return;
    onChange(model.slug, null);
    setSliding(null);
  };

  useKeyboard((key) => {
    // Claimed, so the page behind does not also read this esc or arrow.
    key.preventDefault();
    const escape = key.name === "escape" || key.name === "esc";
    const enter = key.name === "return" || key.name === "enter";
    const clearKey = !key.ctrl && !key.meta && (key.name === "d" || key.name === "backspace" || key.name === "delete");
    if (sliding !== null && open !== undefined) {
      const last = stops.length - 1;
      if (escape) return setSliding(null);
      if (clearKey) return clear(open);
      if (enter || key.name === "space") return pick(sliding.index);
      if (key.name === "home") return setSliding({ ...sliding, index: 0 });
      if (key.name === "end") return setSliding({ ...sliding, index: last });
      if (key.name === "left" || (track ? false : key.name === "up") || (key.name === "h" && !key.ctrl) || (!track && key.name === "k" && !key.ctrl)) return setSliding({ ...sliding, index: Math.max(0, sliding.index - 1) });
      if (key.name === "right" || (track ? false : key.name === "down") || (key.name === "l" && !key.ctrl) || (!track && key.name === "j" && !key.ctrl)) return setSliding({ ...sliding, index: Math.min(last, sliding.index + 1) });
      return;
    }
    if (escape || key.name === "left") return onExit();
    if (key.name === "down" || (key.name === "j" && !key.ctrl)) return setCursor(Math.min(at + 1, Math.max(0, models.length - 1)));
    if (key.name === "up" || (key.name === "k" && !key.ctrl)) return setCursor(Math.max(at - 1, 0));
    if (enter || key.name === "space" || key.name === "right") return openSlider(models[at]);
    if (clearKey) return clear(models[at]);
  });

  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => scrollRef.current?.scrollChildIntoView(`handoff-model-${at}`), 0);
    return () => clearTimeout(timer);
  }, [at, sliding === null]);

  const set = models.filter((model) => model.tokens !== null).length;
  if (sliding !== null && open !== undefined) {
    return (
      <box style={{ flexDirection: "column", flexGrow: 1 }} backgroundColor={SURFACE.raised}>
        <Back onBack={() => setSliding(null)} />
        <box style={{ flexDirection: "column", flexShrink: 0, paddingTop: 1 }} backgroundColor={SURFACE.raised}>
          <text fg={COLOR.bright} bg={SURFACE.raised} selectable={false}>{truncate(`${title}: ${open.name}`, width)}</text>
          <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>{`Tokens of context at which a thread on ${open.slug} is ${action}. Nothing chosen: it follows this provider's setting.`}</text>
        </box>
        {track ? (
          <Slider
            idPrefix="handoff-stop"
            stops={labels}
            active={sliding.index}
            chosen={open.tokens === null ? -1 : stops.indexOf(open.tokens)}
            width={width - 2}
            ends={{ low: "Earlier", high: "Later" }}
            caption={`${stops[sliding.index]!.toLocaleString("en-US")} tokens`}
            onMove={(index) => setSliding({ ...sliding, index })}
            onPick={pick}
          />
        ) : (
          <scrollbox ref={scrollRef} style={{ flexGrow: 1, marginTop: 1 }} stickyStart="top" backgroundColor={SURFACE.raised}>
            {labels.map((label, index) => (
              <StopRow key={label} id={`handoff-stop-${index}`} label={label} active={index === sliding.index} chosen={stops[index] === open.tokens} width={width} onPress={() => pick(index)} />
            ))}
          </scrollbox>
        )}
        <SliderDefault id="handoff-stop-reset" unset={open.tokens === null} defaultLabel="the provider setting" onReset={() => clear(open)} />
        <box style={{ flexDirection: "row", flexShrink: 0, height: 1, marginTop: 1 }} backgroundColor={SURFACE.raised}>
          <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{truncate(`${track ? "←→ move" : "↑↓ move"} · enter picks · d clears it · esc back`, width)}</text>
        </box>
      </box>
    );
  }

  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }} backgroundColor={SURFACE.raised}>
      <Back onBack={onExit} />
      <box style={{ flexDirection: "column", flexShrink: 0, paddingTop: 1 }} backgroundColor={SURFACE.raised}>
        <text fg={COLOR.bright} bg={SURFACE.raised} selectable={false}>{title}</text>
        <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>{description}</text>
      </box>
      <scrollbox ref={scrollRef} style={{ flexGrow: 1, marginTop: 1 }} stickyStart="top" backgroundColor={SURFACE.raised}>
        {models.length === 0 ? <text fg={COLOR.dim} bg={SURFACE.raised} wrapMode="word" selectable={false}>{catalogReady ? "This provider lists no models yet." : "Loading the provider catalog…"}</text> : null}
        {models.map((model, index) => (
          <Row key={model.slug} id={`handoff-model-${index}`} model={model} active={index === at} width={width} onPress={() => { setCursor(index); openSlider(model); }} />
        ))}
      </scrollbox>
      <box style={{ flexDirection: "row", flexShrink: 0, height: 1, marginTop: 1 }} backgroundColor={SURFACE.raised}>
        <text fg={COLOR.faint} bg={SURFACE.raised} selectable={false}>{truncate(models.length === 0 ? "esc back" : `${set} of ${models.length} set · enter picks a size · d clears it · esc back · applies from the next message`, width)}</text>
      </box>
    </box>
  );
}

function Back({ onBack }: { onBack: () => void }) {
  const { hovered, handlers } = useHover();
  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }} backgroundColor={SURFACE.raised} onMouseDown={onBack} selectable={false} {...handlers}>
      <text fg={hovered ? COLOR.bright : COLOR.accent} bg={SURFACE.raised} selectable={false}>{"← back"}</text>
    </box>
  );
}

function Row({ id, model, active, width, onPress }: { id: string; model: HandoffModelEntry; active: boolean; width: number; onPress: () => void }) {
  const { hovered, handlers } = useHover();
  const bg = active ? SURFACE.hover : hovered ? SURFACE.border : SURFACE.raised;
  const right = model.tokens === null ? "uses provider setting" : handoffTokensLabel(model.tokens);
  const left = `${active ? "▌ " : "  "}${model.name}`;
  const rightWidth = Math.min(right.length, Math.max(0, width - 8));
  return (
    <box id={id} style={{ flexDirection: "row", height: 1, flexShrink: 0, paddingLeft: 1, paddingRight: 1, justifyContent: "space-between" }} backgroundColor={bg} onMouseDown={onPress} selectable={false} {...handlers}>
      <text fg={active ? COLOR.bright : COLOR.text} bg={bg} selectable={false}>{truncate(left, Math.max(8, width - rightWidth - 5))}</text>
      <text fg={model.tokens === null ? COLOR.dim : COLOR.accent} bg={bg} selectable={false}>{truncate(right, rightWidth)}</text>
    </box>
  );
}

function StopRow({ id, label, active, chosen, width, onPress }: { id: string; label: string; active: boolean; chosen: boolean; width: number; onPress: () => void }) {
  const { hovered, handlers } = useHover();
  const bg = active ? SURFACE.hover : hovered ? SURFACE.border : SURFACE.raised;
  return (
    <box id={id} style={{ flexDirection: "row", height: 1, flexShrink: 0, paddingLeft: 1, paddingRight: 1 }} backgroundColor={bg} onMouseDown={onPress} selectable={false} {...handlers}>
      <text fg={active ? COLOR.bright : chosen ? COLOR.accent : COLOR.text} bg={bg} selectable={false}>{truncate(`${active ? "▌ " : "  "}${label}${chosen ? "  ✓" : ""}`, width - 2)}</text>
    </box>
  );
}
