import { describe, expect, it } from "vitest";

import { normalizeConfig } from "../../../core/config.js";
import { describeSettings } from "../../../core/configschema.js";
import { longThreadPolicy } from "../../../core/threads/longthreads.js";
import { longThreadConfigFromSnapshot } from "../../features/settings/useSettings.js";

describe("the long-thread config the TUI rebuilds from settings", () => {
  const config = normalizeConfig({
    longThreads: { compaction: "ask" },
    providers: { harness: { profiles: [{ id: "local", baseUrl: "http://localhost:1234/v1", models: [{ id: "m", contextWindow: 200_000 }] }] } },
  });
  const snapshot = { path: "/tmp/config.json", exists: true, settings: describeSettings(config) };

  it("carries the global Compaction, and the Harness profiles it is given, so a Harness card sits where the server's does", () => {
    const rebuilt = longThreadConfigFromSnapshot(snapshot, config.providers?.harness?.profiles);
    expect(rebuilt?.longThreads?.compaction).toBe("ask");
    expect(longThreadPolicy(rebuilt!, "harness/local", "m").compact).toEqual(longThreadPolicy(config, "harness/local", "m").compact);
    expect(longThreadPolicy(rebuilt!, "harness/local", "m").compact).toEqual({ mode: "ask", line: { tokens: 140_000 } });
  });
});
