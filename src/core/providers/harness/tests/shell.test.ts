import { describe, expect, it } from "vitest";

import { availableShells, commandEnv, findPosixShell, findPowerShell } from "../tools/shell.js";
import { builtinTools } from "../tools/index.js";

const files = (...present: string[]) => (file: string) => present.includes(file);

describe("shell lookup", () => {
  it("uses a POSIX $SHELL, else bash, else sh, off Windows", () => {
    expect(findPosixShell({ platform: "linux", env: { SHELL: "/usr/bin/zsh" }, exists: files("/usr/bin/zsh", "/bin/bash") })?.program).toBe("/usr/bin/zsh");
    expect(findPosixShell({ platform: "linux", env: { SHELL: "/usr/bin/fish" }, exists: files("/usr/bin/fish", "/bin/bash") })?.program).toBe("/bin/bash");
    expect(findPosixShell({ platform: "linux", env: {}, exists: files("/bin/sh") })?.program).toBe("/bin/sh");
    expect(findPosixShell({ platform: "linux", env: {} })?.argsFor("echo hi")).toEqual(["-c", "echo hi"]);
  });

  it("finds Git Bash on Windows, never WSL's bash", () => {
    const programFiles = "C:\\Program Files";
    const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
    expect(findPosixShell({ platform: "win32", env: { ProgramFiles: programFiles }, exists: files(gitBash) })?.program).toBe(gitBash);
    expect(findPosixShell({ platform: "win32", env: { PATH: "C:\\Windows\\System32" }, exists: files("C:\\Windows\\System32\\bash.exe") })).toBeNull();
    // Found from git.exe on PATH when installed somewhere unusual.
    const found = findPosixShell({ platform: "win32", env: { PATH: "D:\\tools\\Git\\cmd" }, exists: files("D:\\tools\\Git\\cmd\\git.exe", "D:\\tools\\Git\\bin\\bash.exe") });
    expect(found?.program).toBe("D:\\tools\\Git\\bin\\bash.exe");
  });

  it("prefers pwsh, else Windows PowerShell, only on Windows", () => {
    const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    expect(findPowerShell({ platform: "win32", env: { PATH: "C:\\Program Files\\PowerShell\\7" }, exists: files(pwsh) })?.program).toBe(pwsh);
    const builtin = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const spec = findPowerShell({ platform: "win32", env: { SystemRoot: "C:\\Windows" }, exists: files(builtin) });
    expect(spec?.program).toBe(builtin);
    expect(spec?.argsFor("Get-Date").slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    expect(findPowerShell({ platform: "linux", env: {}, exists: files(pwsh) })).toBeNull();
  });

  it("offers a shell tool only for a shell that exists", () => {
    const win = availableShells({ platform: "win32", env: { SystemRoot: "C:\\Windows" }, exists: files("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe") });
    expect(win.bash).toBeNull();
    const names = builtinTools(win).map((tool) => tool.definition.name);
    expect(names).toContain("powershell");
    expect(names).not.toContain("bash");
  });
});

describe("command environment", () => {
  it("drops the keys moxen reads, keeps the user's other variables", () => {
    const env = commandEnv(["MY_MODEL_KEY"], { PATH: "/bin", ANTHROPIC_API_KEY: "a", my_model_key: "b", GITHUB_TOKEN: "keep", HOME: "/h" });
    expect(env.PATH).toBe("/bin");
    expect(env.GITHUB_TOKEN).toBe("keep");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.my_model_key).toBeUndefined();
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });
});
