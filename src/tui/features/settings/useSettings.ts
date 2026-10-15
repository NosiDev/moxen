import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { useCallback, useEffect, useRef, useState } from "react";


import type { ClientApi, CommandResult, SettingsSnapshot } from "../../../server/api.js";
import type { UiConfig } from "../../../core/types.js";

/**
 * The settings page's state: one read on open, one write per edit, and
 * the server's answer is what gets rendered.
 *
 * Deliberately not optimistic. A setting can be rejected (a bad duration,
 * an out-of-range number) or normalized on the way in, so showing the
 * value we *sent* would be a lie half the time. Instead the row shows a
 * pending mark until the server answers with the whole snapshot, which is
 * also how a change another client made shows up.
 */
export interface SettingsState {
  readonly snapshot: SettingsSnapshot | null;
  readonly loading: boolean;
  /** The key currently being written, for a pending mark on that row. */
  readonly saving: string | null;
  readonly error: string | null;
  readonly set: (key: string, value: string) => void;
  /** Copy a list entry under a new id. */
  readonly duplicate: (key: string, id: string, newId: string) => void;
  /** The test or probe of a harness profile: running, or the last answer. */
  readonly run: HarnessRun | null;
  readonly test: (profileId: string, model?: string) => void;
  /** Start one MCP server and list its tools. */
  readonly testMcp: (name: string) => void;
  readonly probe: (profileId: string, model?: string) => void;
  /** Write a harness profile to a file (no key, no probe results), or add one from such a file. */
  readonly exportProfile: (profileId: string, file: string) => void;
  readonly importProfile: (file: string) => void;
  /** What the last export or import did, in a line. */
  readonly notice: { readonly text: string; readonly error: boolean } | null;
  readonly reload: () => void;
}

/** One test or probe against a harness endpoint, from start to answer. */
export type HarnessRun =
  | { readonly kind: "test" | "probe"; readonly profileId: string; readonly running: true }
  | { readonly kind: "test"; readonly profileId: string; readonly running: false; readonly result: { readonly ok: boolean; readonly message: string } }
  | { readonly kind: "probe"; readonly profileId: string; readonly running: false; readonly result: CommandResult<"harness.profile.probe"> }
  | { readonly kind: "test" | "probe"; readonly profileId: string; readonly running: false; readonly error: string };

export function useSettings(client: ClientApi, open: boolean): SettingsState {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ readonly text: string; readonly error: boolean } | null>(null);
  // Guards a response arriving after the page closed (or after a newer
  // request overtook it) from overwriting what is on screen.
  const generation = useRef(0);

  const load = useCallback(() => {
    const mine = (generation.current += 1);
    setLoading(true);
    void client
      .query({ type: "settings.read" })
      .then((next) => {
        if (generation.current !== mine) return;
        setSnapshot(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (generation.current !== mine) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (generation.current === mine) setLoading(false);
      });
  }, [client]);

  useEffect(() => {
    if (!open) return;
    load();
  }, [open, load]);

  const set = useCallback(
    (key: string, value: string) => {
      const mine = (generation.current += 1);
      setSaving(key);
      void client
        .dispatch({ type: "settings.set", key, value })
        .then((result) => {
          if (generation.current !== mine) return;
          setSnapshot({ path: result.path, exists: result.exists, settings: result.settings });
          setError(null);
        })
        .catch((cause: unknown) => {
          if (generation.current !== mine) return;
          // The value stays as it was: the server refused it, so the row
          // keeps showing what is actually in force.
          setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => {
          if (generation.current === mine) setSaving(null);
        });
    },
    [client],
  );

  const duplicate = useCallback(
    (key: string, id: string, newId: string) => {
      const mine = (generation.current += 1);
      setSaving(key);
      void client
        .dispatch({ type: "settings.duplicate", key, id, newId })
        .then((result) => {
          if (generation.current !== mine) return;
          setSnapshot({ path: result.path, exists: result.exists, settings: result.settings });
          setError(null);
        })
        .catch((cause: unknown) => {
          if (generation.current === mine) setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => {
          if (generation.current === mine) setSaving(null);
        });
    },
    [client],
  );

  // A test or probe is slow and spends requests on someone's server: one at a time.
  const [run, setRun] = useState<HarnessRun | null>(null);
  const runs = useRef(0);
  const busy = useRef(false);
  const start = useCallback(
    (kind: "test" | "probe", profileId: string, model?: string) => {
      if (busy.current) return;
      busy.current = true;
      const mine = (runs.current += 1);
      setRun({ kind, profileId, running: true });
      const finish = (next: HarnessRun) => {
        busy.current = false;
        if (runs.current === mine) setRun(next);
      };
      const failed = (cause: unknown) => finish({ kind, profileId, running: false, error: cause instanceof Error ? cause.message : String(cause) });
      if (kind === "test") {
        void client.dispatch({ type: "harness.profile.test", profileId, ...(model ? { model } : {}) }).then((result) => finish({ kind, profileId, running: false, result }), failed);
        return;
      }
      void client
        .dispatch({ type: "harness.profile.probe", profileId, ...(model ? { model } : {}) })
        .then((result) => {
          finish({ kind: "probe", profileId, running: false, result });
          // The probe wrote to the config: show it.
          load();
        }, failed);
    },
    [client, load],
  );
  const test = useCallback((profileId: string, model?: string) => start("test", profileId, model), [start]);
  const testMcp = useCallback(
    (name: string) => {
      if (busy.current) return;
      busy.current = true;
      const mine = (runs.current += 1);
      setRun({ kind: "test", profileId: name, running: true });
      const finish = (next: HarnessRun) => {
        busy.current = false;
        if (runs.current === mine) setRun(next);
      };
      void client.dispatch({ type: "mcp.server.test", name }).then(
        (result) => finish({ kind: "test", profileId: name, running: false, result }),
        (cause: unknown) => finish({ kind: "test", profileId: name, running: false, error: cause instanceof Error ? cause.message : String(cause) }),
      );
    },
    [client],
  );
  const probe = useCallback((profileId: string, model?: string) => start("probe", profileId, model), [start]);

  const exportProfile = useCallback(
    (profileId: string, file: string) => {
      setNotice(null);
      void client
        .query({ type: "harness.profile.export", profileId })
        .then(async ({ text }) => {
          const target = resolveFile(file);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, text, "utf8");
          setNotice({ text: `Exported ${profileId} to ${target}. It holds no saved key.`, error: false });
        })
        .catch((cause: unknown) => setNotice({ text: cause instanceof Error ? cause.message : String(cause), error: true }));
    },
    [client],
  );

  const importProfile = useCallback(
    (file: string) => {
      setNotice(null);
      const mine = (generation.current += 1);
      void readFile(resolveFile(file), "utf8")
        .catch(() => {
          throw new Error(`Cannot read ${file}.`);
        })
        .then(async (text) => {
          const result = await client.dispatch({ type: "harness.profile.import", text, onConflict: "rename" });
          if (generation.current === mine) setSnapshot({ path: result.path, exists: result.exists, settings: result.settings });
          setNotice({ text: `Imported as ${result.id}${result.id === result.fileId ? "" : ` (${result.fileId} was taken)`}. Set its key if the server needs one.`, error: false });
        })
        .catch((cause: unknown) => setNotice({ text: cause instanceof Error ? cause.message : String(cause), error: true }));
    },
    [client],
  );

  return { snapshot, loading, saving, error, set, duplicate, run, test, testMcp, probe, exportProfile, importProfile, notice, reload: load };
}

/** A path as typed: `~/` is the home directory, a relative one is from where Moxen was started. */
function resolveFile(file: string): string {
  const trimmed = file.trim();
  return path.resolve(trimmed.startsWith("~/") ? path.join(os.homedir(), trimmed.slice(2)) : trimmed);
}

/**
 * The `ui.*` values from a snapshot, as the shape the app draws with. The
 * app starts from the config it launched with and switches to this once a
 * snapshot exists, so an edit on the settings page redraws immediately
 * rather than after a restart.
 */
export function uiFromSnapshot(snapshot: SettingsSnapshot | null): UiConfig | null {
  if (snapshot === null) return null;
  const value = (key: string): unknown => snapshot.settings.find((view) => view.descriptor.key === key)?.value;
  const backdrop = value("ui.backdrop");
  const modelScenes = value("ui.modelScenes");
  const side = value("ui.defaultSidePanel");
  const context = value("ui.contextRefreshSeconds");
  const usage = value("ui.usageRefreshSeconds");
  const handoff = value("ui.autoHandoff");
  const handoffPercent = value("ui.autoHandoffPercent");
  return {
    ...(backdrop === "animated" || backdrop === "static" || backdrop === "off" ? { backdrop } : {}),
    ...(typeof modelScenes === "boolean" ? { modelScenes } : {}),
    ...(side === "context" || side === "git" || side === "agents" || side === "background" ? { defaultSidePanel: side } : {}),
    ...(typeof context === "number" ? { contextRefreshSeconds: context } : {}),
    ...(typeof usage === "number" ? { usageRefreshSeconds: usage } : {}),
    ...(handoff === "off" || handoff === "ask" || handoff === "auto" ? { autoHandoff: handoff } : {}),
    ...(typeof handoffPercent === "number" ? { autoHandoffPercent: handoffPercent } : {}),
  };
}
