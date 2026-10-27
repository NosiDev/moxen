/**
 * Reads a shell command before it runs and says how risky it is.
 *
 * This is what makes the harness's Auto mode possible without a model judging
 * its own calls: the model is trusted to do the work, and this refuses what
 * should never happen by accident (deleting the project or the home folder,
 * force-pushing, piping the network into a shell, touching the user's keys
 * and shell startup files) and asks about what leaves the machine (push,
 * publish). It reads commands the way a shell would for the cases that
 * matter: quoting, separators, pipes, `$(…)`, wrappers such as `sudo`, `env`
 * and `bash -c`, and redirections. It is a guard rail, not a sandbox: a
 * determined script can hide intent from any static reader, and the docs say
 * so.
 *
 * Levels:
 * - `safe`: nothing to flag.
 * - `sensitive`: reaches outside the machine or changes shared state (push,
 *   publish, upload). Auto mode asks.
 * - `dangerous`: destroys or escapes the project (recursive delete outside the
 *   checkout, `reset --hard`, `sudo`, edits to `.git` internals or shell
 *   startup files). Auto mode refuses with the reason; supervised modes show
 *   the reason in the question.
 * - `catastrophic`: wipes the machine (rm -rf of `/` or the home folder,
 *   formatting a disk, shutting down). Refused in every mode.
 *
 * Pure: no filesystem access, so every rule is testable with strings.
 */
import os from "node:os";
import path from "node:path";

export type RiskLevel = "safe" | "sensitive" | "dangerous" | "catastrophic";

export interface Assessment {
  readonly level: RiskLevel;
  /** Why, in words the model can act on. Absent when safe. */
  readonly reason?: string;
}

export interface AssessContext {
  readonly cwd: string;
  /** The user's home folder; defaults to this process's. */
  readonly home?: string;
  readonly tmp?: readonly string[];
  readonly shell?: "posix" | "powershell";
  /** Extra folders the session is allowed to change (a worktree's main checkout is not one). */
  readonly allowed?: readonly string[];
}

const ORDER: Record<RiskLevel, number> = { safe: 0, sensitive: 1, dangerous: 2, catastrophic: 3 };

const worse = (a: Assessment, b: Assessment): Assessment => (ORDER[b.level] > ORDER[a.level] ? b : a);
const SAFE: Assessment = { level: "safe" };
const finding = (level: RiskLevel, reason: string): Assessment => ({ level, reason });

// -- tokenising -----------------------------------------------------------------

interface Simple {
  readonly words: string[];
  /** The text of the command, for rules that read it whole. */
  readonly raw: string;
  /** What fed its standard input: the previous command in a pipeline. */
  readonly pipedFrom: Simple | null;
  /** Redirect targets (`>`, `>>`, `&>`), as words. */
  readonly redirects: string[];
}

interface Parsed {
  readonly commands: Simple[];
  /** Text inside `$(…)`, backticks and `<(…)`, each its own command line. */
  readonly nested: string[];
  /** Here-document bodies, in order. */
  readonly heredocs: string[];
}

/** Find the end of a `$(` … `)` (or `(`) group starting after the opener; returns the index of its `)`. */
function groupEnd(text: string, from: number): number {
  let depth = 1;
  let quote: string | null = null;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === "\\" && quote === '"') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "\\") i += 1;
    else if (ch === "(") depth += 1;
    else if (ch === ")" && --depth === 0) return i;
  }
  return text.length;
}

export function parseCommand(text: string): Parsed {
  const commands: Simple[] = [];
  const nested: string[] = [];
  const heredocs: string[] = [];
  const pendingHeredocs: Array<{ tag: string; strip: boolean }> = [];

  let words: string[] = [];
  let redirects: string[] = [];
  let start = 0;
  let previous: Simple | null = null;
  let current = "";
  let hasWord = false;
  let redirectNext = false;
  let heredocNext: { strip: boolean } | null = null;

  const endWord = (): void => {
    if (!hasWord) return;
    if (heredocNext !== null) {
      pendingHeredocs.push({ tag: current, strip: heredocNext.strip });
      heredocNext = null;
    } else if (redirectNext) {
      redirects.push(current);
      redirectNext = false;
    } else {
      words.push(current);
    }
    current = "";
    hasWord = false;
  };

  const endCommand = (pipe: boolean, at: number): void => {
    endWord();
    if (words.length > 0 || redirects.length > 0) {
      const simple: Simple = { words, raw: text.slice(start, at).trim(), pipedFrom: previous, redirects };
      commands.push(simple);
      previous = pipe ? simple : null;
    } else if (!pipe) {
      previous = null;
    }
    words = [];
    redirects = [];
    start = at;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    // A here-document body starts on the line after the operator.
    if (ch === "\n" && pendingHeredocs.length > 0) {
      endCommand(false, i);
      let at = i + 1;
      for (const { tag, strip } of pendingHeredocs.splice(0)) {
        const body: string[] = [];
        while (at <= text.length) {
          const eol = text.indexOf("\n", at);
          const line = text.slice(at, eol === -1 ? text.length : eol);
          at = eol === -1 ? text.length + 1 : eol + 1;
          if ((strip ? line.trim() : line) === tag) break;
          body.push(line);
          if (eol === -1) break;
        }
        heredocs.push(body.join("\n"));
      }
      i = at - 2;
      start = at;
      continue;
    }
    if (ch === "'") {
      const close = text.indexOf("'", i + 1);
      const end = close === -1 ? text.length : close;
      current += text.slice(i + 1, end);
      hasWord = true;
      i = end;
      continue;
    }
    if (ch === '"') {
      hasWord = true;
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\" && j + 1 < text.length) {
          current += text[j + 1];
          j += 2;
        } else if (text[j] === "$" && text[j + 1] === "(") {
          const end = groupEnd(text, j + 2);
          nested.push(text.slice(j + 2, end));
          current += "$(…)";
          j = end + 1;
        } else if (text[j] === "`") {
          const end = text.indexOf("`", j + 1);
          nested.push(text.slice(j + 1, end === -1 ? text.length : end));
          current += "`…`";
          j = end === -1 ? text.length : end + 1;
        } else {
          current += text[j];
          j += 1;
        }
      }
      i = j;
      continue;
    }
    if (ch === "\\" && i + 1 < text.length) {
      current += text[i + 1];
      hasWord = true;
      i += 1;
      continue;
    }
    if (ch === "$" && text[i + 1] === "(") {
      const end = groupEnd(text, i + 2);
      nested.push(text.slice(i + 2, end));
      current += "$(…)";
      hasWord = true;
      i = end;
      continue;
    }
    if ((ch === "<" || ch === ">") && text[i + 1] === "(") {
      const end = groupEnd(text, i + 2);
      nested.push(text.slice(i + 2, end));
      current += `${ch}(…)`;
      hasWord = true;
      i = end;
      continue;
    }
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      nested.push(text.slice(i + 1, end === -1 ? text.length : end));
      current += "`…`";
      hasWord = true;
      i = end === -1 ? text.length : end;
      continue;
    }
    if (ch === "#" && !hasWord && (i === 0 || /\s/.test(text[i - 1]!))) {
      while (i < text.length && text[i] !== "\n") i += 1;
      i -= 1;
      continue;
    }
    if (/\s/.test(ch) && ch !== "\n") {
      endWord();
      continue;
    }
    if (ch === "\n" || ch === ";" || ch === "&" || ch === "|") {
      const two = text.slice(i, i + 2);
      // `>&2`, `2>&1`, `&>file`: a redirect, not a separator.
      if (ch === "&" && (text[i - 1] === ">" || text[i + 1] === ">")) {
        if (text[i + 1] === ">") {
          redirectNext = true;
          i += text[i + 2] === ">" ? 2 : 1;
        }
        continue;
      }
      const op = two === "&&" || two === "||" || two === "|&" ? two : ch;
      endCommand(op === "|" || op === "|&", i);
      i += op.length - 1;
      start = i + 1;
      continue;
    }
    if (ch === "<" && text[i + 1] === "<" && text[i + 2] !== "<") {
      endWord();
      const strip = text[i + 2] === "-";
      heredocNext = { strip };
      i += strip ? 2 : 1;
      continue;
    }
    if (ch === ">" || ch === "<") {
      // `2>file`: the digit belongs to the operator.
      if (hasWord && /^\d+$/.test(current)) {
        current = "";
        hasWord = false;
      } else {
        endWord();
      }
      if (ch === ">") {
        if (text[i + 1] === ">") i += 1;
        if (text[i + 1] === "|") i += 1;
        redirectNext = true;
      } else {
        // Input redirection: the next word is read, not written.
        redirectNext = false;
        const rest = text.slice(i + 1).match(/^\s*(\S+)/);
        if (rest) {
          i += rest[0].length;
          words.push(`${INPUT_MARK}${rest[1]}`);
        }
      }
      continue;
    }
    current += ch;
    hasWord = true;
  }
  endCommand(false, text.length);
  return { commands, nested, heredocs };
}

// -- paths ----------------------------------------------------------------------

type Where = "cwd" | "tmp" | "home" | "root" | "system" | "outside" | "git" | "secret" | "startup" | "unknown";

/** Marks a word that is an input redirect (`< file`), so it is read from, not written to. */
const INPUT_MARK = "\u0000<";

const SYSTEM_DIRS = ["/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/dev", "/proc", "/sys", "/var/lib", "/var/log", "/opt", "/System", "/Library", "/Applications", "/private/etc", "/Volumes"];
const WINDOWS_SYSTEM = /^(?:[a-z]:)?[\\/](?:windows|program files|program files \(x86\)|programdata)(?:[\\/]|$)/i;
const SECRET_DIRS = [".ssh", ".aws", ".gnupg", ".kube", ".docker", ".config/gh", ".config/gcloud", ".azure", ".npmrc", ".netrc", ".pypirc", ".git-credentials", ".config/op", "Library/Keychains"];
const STARTUP_FILES = [".bashrc", ".bash_profile", ".bash_login", ".profile", ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".config/fish", ".gitconfig", ".config/git", ".inputrc", ".tmux.conf", ".vimrc"];

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function classifyPath(word: string, context: AssessContext): Where {
  const home = context.home ?? os.homedir();
  const tmpRoots = context.tmp ?? [os.tmpdir(), "/tmp", "/var/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
  let text = word;
  if (text === "" || text === "-") return "unknown";
  if (text.startsWith(INPUT_MARK)) text = text.slice(INPUT_MARK.length);
  // `dir/*` and `dir/.*` name what is in `dir`; judge `dir`.
  if (/[\\/]\.?\*+$/.test(text)) text = text.replace(/[\\/]\.?\*+$/, "") || "/";
  if (/^(?:\$HOME|\$\{HOME\}|~)(?:[\\/]|$)/.test(text)) text = path.join(home, text.replace(/^(?:\$HOME|\$\{HOME\}|~)/, ""));
  else if (/^~[A-Za-z_]/.test(text)) return "home";
  else if (/\$|\*\*|\$\(…\)|`…`/.test(text) && !/^\.{0,2}[\\/]?[\w.@+-]*\*?$/.test(text)) return "unknown";
  if (text === "/dev/null" || text === "/dev/stdout" || text === "/dev/stderr" || text === "/dev/tty") return "tmp";
  // A Git Bash path (/c/Users/me) is the drive's.
  const resolved = path.resolve(context.cwd, text.replace(/^\/([a-zA-Z])\//, (_m, d: string) => `${d.toUpperCase()}:/`));
  if (resolved === path.parse(resolved).root) return "root";
  if (/(?:^|[\\/])\.git(?:[\\/]|$)/.test(resolved) && (isInside(context.cwd, resolved) || (context.allowed ?? []).some((root) => isInside(root, resolved)))) return "git";
  for (const secret of SECRET_DIRS) if (isInside(path.join(home, secret), resolved)) return "secret";
  for (const startup of STARTUP_FILES) if (isInside(path.join(home, startup), resolved)) return "startup";
  if (isInside(context.cwd, resolved) || (context.allowed ?? []).some((root) => isInside(root, resolved))) return "cwd";
  for (const tmp of tmpRoots) if (isInside(tmp, resolved)) return "tmp";
  // `path.relative` resolves both sides, so a home given with another case or separator style still matches.
  if (path.relative(home, resolved) === "") return "home";
  if (SYSTEM_DIRS.some((dir) => isInside(dir, resolved)) || WINDOWS_SYSTEM.test(resolved)) return "system";
  if (isInside(home, resolved)) return "outside";
  return "outside";
}

// -- rules ----------------------------------------------------------------------

const WRAPPERS = new Set(["env", "command", "nohup", "time", "exec", "nice", "ionice", "stdbuf", "timeout", "setsid", "builtin", "caffeinate"]);
const ELEVATORS = new Set(["sudo", "doas", "su", "pkexec", "runas"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "pwsh", "powershell"]);
const INTERPRETERS = new Set(["python", "python3", "node", "ruby", "perl", "php", "deno", "bun"]);
const DOWNLOADERS = new Set(["curl", "wget", "fetch", "iwr", "irm", "http", "https"]);
const DISK_TOOLS = new Set(["mkfs", "fdisk", "sfdisk", "parted", "wipefs", "gdisk", "cfdisk", "format", "diskpart"]);
const POWER = new Set(["shutdown", "reboot", "halt", "poweroff", "telinit"]);

const baseName = (word: string): string => word.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");

function flagsOf(words: readonly string[], after = 1): { letters: Set<string>; long: Set<string>; args: string[] } {
  const letters = new Set<string>();
  const long = new Set<string>();
  const args: string[] = [];
  let ended = false;
  for (const word of words.slice(after)) {
    if (!ended && word === "--") ended = true;
    else if (!ended && word.startsWith("--") && word.length > 2) long.add(word.slice(2).split("=")[0]!);
    else if (!ended && word.startsWith("-") && word.length > 1 && !/^-\d+$/.test(word)) for (const letter of word.slice(1)) letters.add(letter);
    else args.push(word);
  }
  return { letters, long, args };
}

function describePath(where: Where): string {
  return where === "root" ? "the filesystem root" : where === "home" ? "your home folder" : where === "system" ? "a system folder" : where === "secret" ? "credentials" : where === "startup" ? "a shell startup file" : where === "git" ? ".git internals" : "a place outside the project";
}

function assessRemoval(simple: Simple, context: AssessContext): Assessment {
  const { letters, long, args } = flagsOf(simple.words);
  const recursive = letters.has("r") || letters.has("R") || long.has("recursive");
  let result = SAFE;
  for (const target of args) {
    const where = classifyPath(target, context);
    const bare = /^(?:\.|\.\/|\*|\.\/\*|\.\*)$/.test(target);
    if (where === "root" || where === "home") {
      result = worse(result, recursive || where === "root" ? finding("catastrophic", `This would delete ${describePath(where)}.`) : finding("dangerous", `Deleting ${describePath(where)}.`));
    } else if (where === "system" || where === "secret" || where === "startup") {
      result = worse(result, finding(recursive ? "catastrophic" : "dangerous", `Deleting ${describePath(where)}.`));
    } else if (where === "git") {
      result = worse(result, finding("dangerous", "Deleting inside .git would damage the repository's history or configuration."));
    } else if (where === "outside") {
      result = worse(result, finding("dangerous", `Deleting a path outside the project (${target}). Only files inside the working directory may be deleted.`));
    } else if (where === "unknown" && recursive) {
      result = worse(result, finding("sensitive", `A recursive delete whose target (${target}) cannot be resolved before it runs.`));
    } else if (where === "cwd" && recursive && (bare || path.resolve(context.cwd, target) === path.resolve(context.cwd))) {
      result = worse(result, finding("dangerous", "A recursive delete of the whole working directory."));
    }
  }
  if (recursive && args.length === 0 && simple.words.length > 1) result = worse(result, finding("sensitive", "A recursive delete with no clear target."));
  return result;
}

function assessGit(words: readonly string[], context: AssessContext): Assessment {
  // Skip global options: git -C dir -c k=v <sub> …
  let index = 1;
  while (index < words.length && words[index]!.startsWith("-")) index += words[index] === "-C" || words[index] === "-c" || words[index] === "--git-dir" || words[index] === "--work-tree" ? 2 : 1;
  const sub = words[index];
  const rest = words.slice(index + 1);
  const has = (...names: string[]): boolean => rest.some((word) => names.includes(word));
  const forced = rest.some((word) => word === "-f" || word === "--force" || word.startsWith("--force-with-lease") || word === "--force-if-includes" || /^\+[^+]/.test(word) || (/^-[a-zA-Z]*f[a-zA-Z]*$/.test(word) && sub === "push"));
  switch (sub) {
    case "push":
      if (forced) return finding("dangerous", "A force push can overwrite other people's commits on the remote. Push without --force, or ask the user.");
      if (has("--delete", "-d", "--mirror", "--prune") || rest.some((word) => word.startsWith(":"))) return finding("dangerous", "This push deletes remote branches or refs.");
      return finding("sensitive", "git push publishes commits to a remote.");
    case "reset":
      return has("--hard", "--merge", "--keep") && has("--hard") ? finding("dangerous", "git reset --hard throws away uncommitted work that cannot be recovered. Use git stash, or ask the user.") : SAFE;
    case "clean":
      return rest.some((word) => /^-[a-zA-Z]*[fdx][a-zA-Z]*$/.test(word) || word === "--force") && !has("-n", "--dry-run") ? finding("dangerous", "git clean deletes untracked files for good. Run it with -n first, or ask the user.") : SAFE;
    case "checkout":
    case "restore": {
      const discards = (has("--") && rest.slice(rest.indexOf("--") + 1).length > 0) || (sub === "restore" && !has("--staged") ) || has(".");
      return discards && (has(".") || has("--") || sub === "restore") ? finding("dangerous", `git ${sub} here discards uncommitted changes. Stash them first, or ask the user.`) : SAFE;
    }
    case "stash":
      return has("drop", "clear") ? finding("dangerous", "This deletes stashed work.") : SAFE;
    case "branch":
      return rest.some((word) => word === "-D" || word === "--delete" || word === "-d" || word === "-M") && has("-D", "--force", "-M") ? finding("dangerous", "This deletes or overwrites a branch.") : SAFE;
    case "tag":
      return has("-d", "--delete") ? finding("dangerous", "This deletes a tag.") : SAFE;
    case "filter-branch":
    case "filter-repo":
    case "replace":
      return finding("dangerous", `git ${sub} rewrites history.`);
    case "reflog":
      return has("expire", "delete") ? finding("dangerous", "This deletes the reflog, the safety net for lost commits.") : SAFE;
    case "gc":
      return rest.some((word) => word.startsWith("--prune=now") || word === "--aggressive") ? finding("dangerous", "This permanently drops unreachable commits.") : SAFE;
    case "rebase":
    case "commit":
      return rest.includes("--amend") || has("--root") ? finding("sensitive", `git ${sub} rewrites existing commits.`) : SAFE;
    case "config":
      return has("--global", "--system") && !has("--get", "--list", "-l", "--get-all") ? finding("dangerous", "Changing the user's global git configuration.") : SAFE;
    case "submodule":
      return has("deinit") && has("-f", "--force") ? finding("dangerous", "This force-removes a submodule.") : SAFE;
    default:
      return SAFE;
  }
}

function assessCopyMove(simple: Simple, program: string, context: AssessContext): Assessment {
  const { args, letters, long } = flagsOf(simple.words);
  if (args.length === 0) return SAFE;
  let result = SAFE;
  const targetFlag = simple.words.findIndex((word, i) => i > 0 && (word === "-t" || word.startsWith("--target-directory")));
  const destination = targetFlag !== -1 ? (simple.words[targetFlag]!.includes("=") ? simple.words[targetFlag]!.split("=")[1]! : simple.words[targetFlag + 1]) : args.at(-1);
  const sources = targetFlag !== -1 ? args : args.slice(0, -1);
  void letters;
  void long;
  if (destination !== undefined) {
    const where = classifyPath(destination, context);
    if (where === "system" || where === "secret" || where === "startup" || where === "root" || where === "git") {
      result = worse(result, finding("dangerous", `Writing to ${describePath(where)} (${destination}).`));
    } else if (where === "outside" || where === "home") {
      result = worse(result, finding("dangerous", `Writing outside the project (${destination}). Changes belong inside the working directory.`));
    }
  }
  if (program === "mv") {
    for (const source of sources) {
      const where = classifyPath(source, context);
      if (where === "outside" || where === "home" || where === "system" || where === "secret" || where === "startup" || where === "root" || where === "git") {
        result = worse(result, finding("dangerous", `Moving ${describePath(where)} (${source}) takes it out of where it is.`));
      }
    }
  }
  return result;
}

function assessRedirect(target: string, context: AssessContext): Assessment {
  if (/^\/dev\/(?:sd|hd|nvme|disk|rdisk|mmcblk|vd)/.test(target)) return finding("catastrophic", `Writing straight to a disk device (${target}).`);
  const where = classifyPath(target, context);
  switch (where) {
    case "system":
    case "root":
    case "secret":
    case "startup":
    case "git":
      return finding("dangerous", `Redirecting output into ${describePath(where)} (${target}).`);
    case "outside":
    case "home":
      return finding("dangerous", `Redirecting output to a file outside the project (${target}).`);
    default:
      return SAFE;
  }
}

const SQL_DESTRUCTIVE = /\b(?:drop\s+(?:database|schema|table)|truncate\s+table|delete\s+from\s+\w+\s*(?:;|$|"|'))/i;

/** One command, with any wrapper peeled off. */
function assessSimple(simple: Simple, context: AssessContext, depth: number): Assessment {
  let result = SAFE;
  for (const target of simple.redirects) result = worse(result, assessRedirect(target, context));
  let words = simple.words.filter((word) => !word.startsWith(INPUT_MARK));
  // VAR=value prefixes.
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words = words.slice(1);
  if (words.length === 0) return result;
  let program = baseName(words[0]!);
  if (ELEVATORS.has(program)) return worse(result, finding("dangerous", `${program} runs a command with elevated privileges. Run it without, or ask the user.`));
  if (program === "!" || program === "{") words = words.slice(1), (program = baseName(words[0] ?? ""));
  while (WRAPPERS.has(program) && words.length > 1) {
    let next = 1;
    // Skip the wrapper's own options and VAR=value assignments (and timeout's duration).
    while (next < words.length && (words[next]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[next]!) || (["timeout", "nice", "ionice", "stdbuf"].includes(program) && /^\d+[smhd]?$/.test(words[next]!)))) next += 1;
    words = words.slice(next);
    program = baseName(words[0] ?? "");
    if (ELEVATORS.has(program)) return worse(result, finding("dangerous", `${program} runs a command with elevated privileges.`));
  }
  if (words.length === 0) return result;
  const inner: Simple = { ...simple, words, raw: words.join(" ") };

  if (program === "xargs") {
    const rest = words.slice(1).filter((word) => !word.startsWith("-"));
    if (rest.length > 0) {
      const wrapped = assessSimple({ ...simple, words: rest, raw: rest.join(" "), redirects: [] }, context, depth + 1);
      // Its arguments come from input we cannot see: a removal there is a removal of anything.
      if (["rm", "rmdir", "shred", "unlink"].includes(baseName(rest[0]!))) result = worse(result, finding("dangerous", "xargs rm deletes whatever its input names, which cannot be checked before it runs."));
      result = worse(result, wrapped);
    }
    return result;
  }
  if (program === "find") {
    if (words.includes("-delete") || (words.includes("-exec") && words.some((word) => ["rm", "rmdir", "shred"].includes(baseName(word))))) {
      const roots = flagsOf(words).args.filter((word) => !word.startsWith("-") && !word.startsWith("(") && !word.startsWith("!")).slice(0, 1);
      for (const root of roots.length > 0 ? roots : ["."]) {
        const where = classifyPath(root, context);
        result = worse(result, where === "cwd" ? SAFE : finding(where === "root" || where === "home" || where === "system" ? "catastrophic" : "dangerous", `find … -delete outside the project (${root}).`));
      }
    }
    return result;
  }
  if (SHELLS.has(program) && depth < 4) {
    const flag = words.findIndex((word, i) => i > 0 && /^-[a-zA-Z]*c$/.test(word));
    const psFlag = words.findIndex((word, i) => i > 0 && /^-(?:command|c|encodedcommand|e|enc)$/i.test(word));
    const code = flag !== -1 ? words[flag + 1] : psFlag !== -1 ? words[psFlag + 1] : undefined;
    if (/^-(?:encodedcommand|e|enc)$/i.test(words[psFlag] ?? "")) result = worse(result, finding("dangerous", "An encoded PowerShell command hides what it does."));
    else if (code !== undefined) result = worse(result, assessCommandLine(code, { ...context, shell: program === "pwsh" || program === "powershell" ? "powershell" : "posix" }, depth + 1));
    if (code === undefined && words.some((word) => word.includes("<(…)"))) result = worse(result, finding("dangerous", "Running the output of a command as a script runs code nobody has read."));
    // A shell that reads what a download or a decoder wrote: nothing to look at, so no.
    if (code === undefined && simple.pipedFrom !== null) {
      const feeder = baseName(simple.pipedFrom.words.find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) ?? "");
      if (DOWNLOADERS.has(feeder)) result = worse(result, finding("dangerous", "Piping a download into a shell runs code nobody has read. Download it, read it, then run it."));
      else if (feeder === "base64" || feeder === "openssl" || feeder === "xxd") result = worse(result, finding("dangerous", "Running decoded text in a shell hides what it does."));
      else result = worse(result, finding("sensitive", "A shell that runs whatever is piped into it."));
    }
    return result;
  }
  if (program === "eval") return worse(result, words.length > 1 ? assessCommandLine(words.slice(1).join(" "), context, depth + 1) : SAFE);
  if (program === "source" || program === ".") {
    if (words.some((word) => word.includes("<(…)"))) result = worse(result, finding("dangerous", "Sourcing the output of a command runs code nobody has read."));
    return result;
  }

  if (["rm", "rmdir", "shred", "unlink"].includes(program)) return worse(result, assessRemoval(inner, context));
  if (program === "git") return worse(result, assessGit(words, context));
  if (program === "mv" || program === "cp" || program === "ln" || program === "install" || program === "rsync") {
    if (program === "rsync" && words.some((word) => word === "--delete" || word.startsWith("--delete-"))) result = worse(result, finding("dangerous", "rsync --delete removes files at the destination that are not at the source."));
    if (program === "rsync" && words.some((word) => /^[^/\\:\s]+@?[\w.-]+:/.test(word) && !/^[A-Za-z]:[\\/]/.test(word))) result = worse(result, finding("sensitive", "rsync to or from a remote machine."));
    return worse(result, assessCopyMove(inner, program, context));
  }
  if (program === "scp" || program === "sftp" || program === "ssh" || program === "sshfs") return worse(result, finding("sensitive", `${program} reaches another machine.`));
  if (["chmod", "chown", "chgrp"].includes(program)) {
    const { letters, long, args } = flagsOf(words);
    const recursive = letters.has("R") || long.has("recursive");
    const targets = args.slice(1);
    for (const target of targets) {
      const where = classifyPath(target, context);
      if (where === "root" || where === "system" || where === "home" || where === "secret" || where === "startup") result = worse(result, finding(recursive ? "catastrophic" : "dangerous", `Changing permissions or ownership of ${describePath(where)}.`));
      else if (where === "outside") result = worse(result, finding("dangerous", `Changing permissions or ownership outside the project (${target}).`));
    }
    if (program === "chmod" && /^(?:0?777|a\+rwx|ugo\+rwx)$/.test(args[0] ?? "")) result = worse(result, finding("sensitive", "chmod 777 makes the file writable by everyone."));
    return result;
  }
  if (program === "dd") {
    const out = words.find((word) => word.startsWith("of="));
    if (out !== undefined) {
      const target = out.slice(3);
      if (/^\/dev\/(?:sd|hd|nvme|disk|rdisk|mmcblk|vd)/.test(target)) return worse(result, finding("catastrophic", `dd writing straight to a disk (${target}).`));
      result = worse(result, assessRedirect(target, context));
    }
    return result;
  }
  if (DISK_TOOLS.has(program) || program.startsWith("mkfs") || (program === "diskutil" && words.some((word) => /^(?:erase|reformat|partition|zero|secure)/i.test(word)))) {
    return worse(result, finding("catastrophic", `${program} can destroy a disk.`));
  }
  if (POWER.has(program) || (program === "init" && words[1] === "0") || (program === "systemctl" && ["poweroff", "reboot", "halt"].includes(words[1] ?? ""))) {
    return worse(result, finding("catastrophic", "This would shut down or restart the machine."));
  }
  if (program === "kill") {
    if (words.some((word) => word === "-1" || word === "1")) result = worse(result, finding("catastrophic", "This signals every process, or the init process."));
    else if (words.some((word) => /^\$\(…\)|`…`/.test(word))) result = worse(result, finding("dangerous", "Killing processes found by a search: stop one by the pid you started instead."));
    return result;
  }
  if (program === "pkill" || program === "killall" || (program === "taskkill" && words.some((word) => /^\/im$/i.test(word)))) {
    return worse(result, finding("dangerous", `${program} kills processes by name, which can hit the user's own programs. Stop only the process you started, by its pid.`));
  }
  if (program === "crontab" && words.includes("-r")) return worse(result, finding("dangerous", "This deletes the user's crontab."));
  if (["launchctl", "systemctl", "service", "sc"].includes(program) && words.some((word) => ["stop", "disable", "mask", "unload", "bootout", "remove", "delete"].includes(word))) {
    return worse(result, finding("dangerous", `${program} changes system services.`));
  }
  if (program === "security" && words.some((word) => /^(?:find|dump|export|delete)-/.test(word) || word === "dump-keychain")) return worse(result, finding("dangerous", "Reading or changing the system keychain."));
  if (program === "networksetup" || (program === "defaults" && words[1] === "write") || program === "csrutil" || program === "spctl") return worse(result, finding("dangerous", `${program} changes system settings.`));
  if (["brew", "apt", "apt-get", "dnf", "yum", "pacman", "apk", "snap", "choco", "winget", "scoop"].includes(program) && words.some((word) => ["uninstall", "remove", "purge", "autoremove", "erase", "-R", "-Rs"].includes(word))) {
    return worse(result, finding("dangerous", `${program} would remove software from this machine.`));
  }
  if (["npm", "pnpm", "yarn", "bun"].includes(program)) {
    if (words.includes("publish")) result = worse(result, finding("sensitive", `${program} publish releases a package to a registry.`));
    if ((words.includes("-g") || words.includes("--global") || words.includes("global")) && words.some((word) => ["install", "add", "i", "uninstall", "remove", "rm", "link"].includes(word))) result = worse(result, finding("sensitive", "A global install changes the machine outside the project."));
    return result;
  }
  if (["cargo", "twine", "gem", "poetry", "flit"].includes(program) && words.some((word) => word === "publish" || word === "upload" || word === "push")) return worse(result, finding("sensitive", `${program} ${words[1] ?? "publish"} releases a package.`));
  if (["pip", "pip3"].includes(program) && words.includes("uninstall")) return worse(result, finding("sensitive", "pip uninstall removes packages."));
  if (program === "docker" || program === "podman" || program === "kubectl" || program === "helm" || program === "terraform" || program === "tofu" || program === "pulumi") {
    if (words.some((word) => ["prune", "destroy"].includes(word)) || (program === "docker" && words.includes("rm") && words.includes("-f")) || (program === "docker" && words.some((word) => word === "--privileged" || /^-v$/.test(word) && /^\/(?::|$)/.test(words[words.indexOf(word) + 1] ?? "")))) {
      return worse(result, finding("dangerous", `${program} ${words[1] ?? ""} destroys containers, volumes or infrastructure.`));
    }
    if ((program === "kubectl" || program === "helm") && words.some((word) => ["delete", "uninstall", "drain", "cordon", "apply", "upgrade", "install", "rollout"].includes(word))) return worse(result, finding("sensitive", `${program} changes a cluster.`));
    if ((program === "terraform" || program === "tofu" || program === "pulumi") && words.some((word) => ["apply", "up", "import"].includes(word))) return worse(result, finding("sensitive", `${program} changes real infrastructure.`));
    if (program === "docker" && (words[1] === "push" || words[1] === "login")) return worse(result, finding("sensitive", "docker publishes or authenticates to a registry."));
    return result;
  }
  if (program === "gh" || program === "glab") {
    if (words.some((word) => ["delete", "release", "merge", "close", "transfer", "archive"].includes(word))) return worse(result, finding("sensitive", `${program} ${words.slice(1, 3).join(" ")} changes the remote project.`));
    if (words[1] === "api" && words.some((word) => ["DELETE", "PUT", "POST", "PATCH", "-X"].includes(word))) return worse(result, finding("sensitive", `${program} api writes to the remote project.`));
    return result;
  }
  if (program === "aws" || program === "gcloud" || program === "az" || program === "doctl" || program === "flyctl" || program === "fly" || program === "heroku" || program === "vercel" || program === "netlify" || program === "wrangler") {
    if (words.some((word) => /^(?:delete|terminate|destroy|remove|rm|deploy|publish|put|update|create)/.test(word))) return worse(result, finding("sensitive", `${program} changes cloud resources.`));
    return result;
  }
  if (DOWNLOADERS.has(program)) {
    const { args } = flagsOf(words);
    const carriesFile = words.some((word, i) => {
      if (word === "-T" || word === "--upload-file" || word.startsWith("--upload-file=")) return true;
      const flag = /^(-d|--data|--data-binary|--data-raw|--data-urlencode|-F|--form|--post-file|--body-file)(?:=(.*))?$/.exec(word);
      if (flag === null) return false;
      const value = flag[2] ?? words[i + 1] ?? "";
      return value.startsWith("@") || /^[\w-]+=@/.test(value);
    });
    if (carriesFile && args.some((arg) => /^https?:\/\//i.test(arg) && !/^https?:\/\/(?:localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(arg))) {
      result = worse(result, finding("sensitive", "This uploads a local file to an outside address."));
    }
    const out = words.findIndex((word) => word === "-o" || word === "-O" || word === "--output" || word === "-P" || word === "--output-document" || word === "--directory-prefix");
    if (out !== -1 && words[out + 1] !== undefined) result = worse(result, assessRedirect(words[out + 1]!, context));
    return result;
  }
  if (program === "tee") {
    for (const target of flagsOf(words).args) result = worse(result, assessRedirect(target, context));
    return result;
  }
  if ((program === "sed" || program === "perl" || program === "awk" || program === "gawk" || program === "ruby") && words.some((word) => /^-[a-zA-Z]*i/.test(word) || word === "-i" || word.startsWith("--in-place") || word === "inplace")) {
    const files = words.slice(1).filter((word) => !word.startsWith("-") && !/[;{}'"$]|^s\//.test(word));
    for (const file of files.slice(-3)) {
      const where = classifyPath(file, context);
      if (where !== "cwd" && where !== "tmp" && where !== "unknown") result = worse(result, finding("dangerous", `In-place edit of ${describePath(where)} (${file}).`));
    }
    return result;
  }
  if (program === "truncate" || program === "fallocate") {
    for (const file of flagsOf(words).args) {
      const where = classifyPath(file, context);
      if (where !== "cwd" && where !== "tmp" && where !== "unknown") result = worse(result, finding("dangerous", `${program} on ${describePath(where)}.`));
    }
    return result;
  }
  if (["cat", "less", "more", "head", "tail", "cp", "grep", "rg", "xxd", "strings", "base64", "open", "bat"].includes(program)) {
    for (const file of flagsOf(words).args) {
      if (classifyPath(file, context) === "secret") result = worse(result, finding("dangerous", `Reading credentials (${file}). Secrets are not for the model to see.`));
    }
    return result;
  }
  if (["nc", "ncat", "netcat", "socat"].includes(program) && words.some((word) => word === "-e" || word === "-c" || /exec:|system:/i.test(word))) {
    return worse(result, finding("catastrophic", `${program} wired to a shell is a reverse shell.`));
  }
  if (["sqlite3", "psql", "mysql", "mariadb", "mongosh", "redis-cli"].includes(program) || (INTERPRETERS.has(program) && words.some((word) => /^-[ce]$/.test(word)))) {
    if (SQL_DESTRUCTIVE.test(simple.raw)) result = worse(result, finding("dangerous", "A destructive database statement."));
  }
  if (INTERPRETERS.has(program) && words.some((word) => /^-[ce]$|^--eval$|^-p$/.test(word))) {
    if (/(?:rmtree|rmSync|rm\(|unlinkSync|os\.remove|os\.system|subprocess|child_process|exec\s*\(|spawn)/.test(simple.raw) && /(?:["'`]\/["'`]|["']~|\$HOME|os\.homedir|["']\/(?:usr|etc|bin|System|Users)\b)/.test(simple.raw)) {
      result = worse(result, finding("dangerous", `Inline ${program} code that deletes or runs commands against the root, the home folder or a system path.`));
    }
  }
  if (program === ":" && /:\s*\(\s*\)\s*\{/.test(simple.raw)) return finding("catastrophic", "A fork bomb.");
  return result;
}

const POWERSHELL_RULES: ReadonlyArray<{ readonly pattern: RegExp; readonly level: RiskLevel; readonly reason: string }> = [
  { pattern: /\b(?:Format-Volume|Clear-Disk|Remove-Partition|Initialize-Disk|Stop-Computer|Restart-Computer)\b/i, level: "catastrophic", reason: "This formats a disk or restarts the machine." },
  { pattern: /\b(?:Remove-Item|rm|del|erase|rd|rmdir|ri)\b[^|;\n]*(?:-Recurse|-r\b)[^|;\n]*(?:\s|["'])(?:[a-z]:[\\/]?|~[\\/]?|\$HOME[\\/]?|\$env:(?:USERPROFILE|HOMEPATH|SystemRoot)[\\/]?)["']?(?:\s|$)/i, level: "catastrophic", reason: "A recursive delete of a drive root, the home folder or the system folder." },
  { pattern: /\b(?:Remove-Item|rm|del|erase|rd|rmdir|ri)\b[^|;\n]*(?:-Recurse|-r\b)[^|;\n]*(?:-Force|-fo\b)|\b(?:Remove-Item|rm|del|erase|rd|rmdir|ri)\b[^|;\n]*(?:-Force|-fo\b)[^|;\n]*(?:-Recurse|-r\b)/i, level: "sensitive", reason: "A forced recursive delete." },
  { pattern: /\b(?:iex|Invoke-Expression)\b[^\n]*\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod|DownloadString|curl|wget)\b|\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod|DownloadString|curl|wget)\b[^\n]*\|\s*(?:iex|Invoke-Expression)\b/i, level: "dangerous", reason: "Running downloaded text as code. Download it, read it, then run it." },
  { pattern: /\b(?:Set-ExecutionPolicy|Add-MpPreference|Set-MpPreference|Disable-NetFirewallRule|Set-NetFirewallProfile|Disable-WindowsOptionalFeature|New-Service|Set-Service|sc\.exe\s+(?:delete|stop|config)|schtasks(?:\.exe)?\s+\/(?:create|delete)|Register-ScheduledTask|Unregister-ScheduledTask|bcdedit|diskpart|cipher\s+\/w)\b/i, level: "dangerous", reason: "This changes system security, services or scheduled tasks." },
  { pattern: /\b(?:reg(?:\.exe)?\s+(?:delete|add|import)|Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|Remove-Item)\b[^\n]*\b(?:HKLM|HKEY_LOCAL_MACHINE|HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run)\b/i, level: "dangerous", reason: "This changes the registry in a place that affects the whole machine or startup." },
  { pattern: /\bStart-Process\b[^\n]*-Verb\s+RunAs\b/i, level: "dangerous", reason: "This asks for administrator rights." },
  { pattern: /\b(?:Stop-Process|taskkill(?:\.exe)?)\b[^\n]*(?:-Name|\s\/IM\b)/i, level: "dangerous", reason: "This kills processes by name, which can hit the user's own programs. Stop only the process you started, by its id." },
  { pattern: /(?:Get-Content|cat|type|gc)\b[^\n]*(?:\.ssh|\.aws|\.gnupg|\.git-credentials|\.npmrc|\.netrc)/i, level: "dangerous", reason: "Reading credentials. Secrets are not for the model to see." },
  { pattern: /\b(?:cmdkey|vaultcmd)\b[^\n]*\/(?:list|delete)|\bGet-StoredCredential\b/i, level: "dangerous", reason: "This reads or deletes stored Windows credentials." },
  { pattern: /\b(?:Invoke-WebRequest|iwr|Invoke-RestMethod|irm|curl)\b[^\n]*-(?:InFile|Body)\b[^\n]*(?:Get-Content|\[IO\.File\]|@)/i, level: "sensitive", reason: "This uploads a local file to an outside address." },
];

function assessPowerShell(line: string, context: AssessContext): Assessment {
  let result = SAFE;
  for (const rule of POWERSHELL_RULES) if (rule.pattern.test(line)) result = worse(result, finding(rule.level, rule.reason));
  // `git` and a few native tools read the same in PowerShell.
  for (const segment of line.split(/[;\n]|\|\||&&/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    if (words[0] === "git") result = worse(result, assessGit(words.map((word) => word.replace(/^["']|["']$/g, "")), context));
  }
  return result;
}

const FORK_BOMB = /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/;
const REVERSE_SHELL = /(?:\/dev\/(?:tcp|udp)\/|bash\s+-i\s*>&|mkfifo\s+\S+\s*;\s*nc\b)/;

/** Assess a whole command line as the model wrote it. */
export function assessCommandLine(command: string, context: AssessContext, depth = 0): Assessment {
  if (command.trim() === "") return SAFE;
  if (depth > 4) return finding("sensitive", "A command nested too deeply to read.");
  let result = SAFE;
  if (FORK_BOMB.test(command)) return finding("catastrophic", "A fork bomb.");
  if (REVERSE_SHELL.test(command)) return finding("catastrophic", "This opens a remote shell or sends data through a raw network socket.");
  if (SQL_DESTRUCTIVE.test(command) && /\b(?:psql|mysql|mariadb|sqlite3|mongosh|redis-cli|sqlcmd)\b/.test(command)) result = worse(result, finding("dangerous", "A destructive database statement."));
  if (context.shell === "powershell") result = worse(result, assessPowerShell(command, context));
  const parsed = parseCommand(command);
  for (const simple of parsed.commands) result = worse(result, assessSimple(simple, context, depth));
  for (const inner of parsed.nested) result = worse(result, assessCommandLine(inner, context, depth + 1));
  // A here-document fed to a shell is a script; fed to anything else it is data.
  const feedsShell = parsed.commands.some((simple) => SHELLS.has(baseName(simple.words.find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) ?? "")));
  if (feedsShell) for (const body of parsed.heredocs) result = worse(result, assessCommandLine(body, context, depth + 1));
  return result;
}
