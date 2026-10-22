import { describe, expect, it } from "vitest";

import { isOfferedClaudeCommand } from "../commands.js";

const own = (name: string) => ({ name, builtin: true });

describe("which Claude Code commands are offered", () => {
  it("keeps bundled skills and the commands that work as a prompt", () => {
    for (const name of ["code-review", "simplify", "verify", "debug", "batch", "loop", "update-config", "init", "context", "usage", "recap", "security-review", "compact"]) {
      expect(isOfferedClaudeCommand(own(name)), name).toBe(true);
    }
  });

  it("drops the commands that need the interactive app, an account, or the session Moxen owns", () => {
    for (const name of ["clear", "model", "effort", "fast", "rename", "config", "mcp", "agents", "goal", "ultrareview", "usage-credits", "__remote-workflow"]) {
      expect(isOfferedClaudeCommand(own(name)), name).toBe(false);
    }
  });

  it("never touches a user's, project's, plugin's or MCP server's own command, even one named like a built-in", () => {
    expect(isOfferedClaudeCommand({ name: "model" })).toBe(true);
    expect(isOfferedClaudeCommand({ name: "clear", builtin: false })).toBe(true);
    expect(isOfferedClaudeCommand({ name: "handoff" })).toBe(true);
  });
});
