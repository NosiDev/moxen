/**
 * glob and grep, in plain Node so they behave the same everywhere and need
 * nothing installed. They skip the usual build and dependency folders but do
 * not read `.gitignore`; ripgrep acceleration is a later step.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { resolveToolPath } from "./files.js";
import type { HarnessTool, ToolResult } from "./types.js";

const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "build", "target", ".next", ".turbo", ".cache", "__pycache__", ".venv", "venv", ".gradle", "coverage"]);
const MAX_FILE_BYTES = 2_000_000;
const MAX_GLOB_RESULTS = 200;
const DEFAULT_GREP_LIMIT = 250;
const MAX_MATCH_LINE_CHARS = 500;

const fail = (content: string): ToolResult => ({ content, isError: true });

/** Every file under `root`, as a path relative to it, in a stable order. Symlinked directories are not followed. */
async function* walk(root: string, signal: AbortSignal, relative = ""): AsyncGenerator<string> {
  if (signal.aborted) return;
  let entries;
  try {
    entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const next = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) yield* walk(root, signal, next);
    } else if (entry.isFile()) {
      yield next;
    }
  }
}

function braces(pattern: string): string[] {
  const open = pattern.indexOf("{");
  if (open === -1) return [pattern];
  let depth = 0;
  for (let index = open; index < pattern.length; index += 1) {
    if (pattern[index] === "{") depth += 1;
    else if (pattern[index] === "}" && --depth === 0) {
      const parts: string[] = [];
      let from = open + 1;
      let nested = 0;
      for (let at = open + 1; at < index; at += 1) {
        if (pattern[at] === "{") nested += 1;
        else if (pattern[at] === "}") nested -= 1;
        else if (pattern[at] === "," && nested === 0) {
          parts.push(pattern.slice(from, at));
          from = at + 1;
        }
      }
      parts.push(pattern.slice(from, index));
      return parts.flatMap((part) => braces(pattern.slice(0, open) + part + pattern.slice(index + 1)));
    }
  }
  return [pattern];
}

function globSource(pattern: string): string {
  let out = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        const slash = pattern[index + 2] === "/";
        out += slash ? "(?:.*/)?" : ".*";
        index += slash ? 2 : 1;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") out += "[^/]";
    else if (char === "[") {
      const close = pattern.indexOf("]", index + 1);
      if (close === -1) out += "\\[";
      else {
        out += `[${pattern.slice(index + 1, close).replace(/^!/, "^")}]`;
        index = close;
      }
    } else out += char.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return out;
}

/** A glob as a matcher over `/`-separated relative paths. A pattern with no `/` matches the file name at any depth. */
export function globMatcher(pattern: string): (relative: string) => boolean {
  const regexes = braces(pattern.trim()).map((variant) => {
    const anywhere = !variant.includes("/");
    return { anywhere, regex: new RegExp(`^${globSource(variant.replace(/^\.\//, ""))}$`) };
  });
  return (relative) => regexes.some(({ anywhere, regex }) => regex.test(anywhere ? (relative.split("/").at(-1) ?? relative) : relative));
}

async function isDirectory(target: string): Promise<boolean | null> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return null;
  }
}

// -- glob ---------------------------------------------------------------------

interface GlobArgs {
  pattern: string;
  path?: string;
}

export const globTool: HarnessTool<GlobArgs> = {
  readOnly: true,
  definition: {
    name: "glob",
    description: [
      "Finds files by name pattern, e.g. \"**/*.ts\", \"src/**/test_*.py\" or \"*.{json,yaml}\". Returns absolute paths, most recently modified first.",
      "",
      "- Use it to find files by name or location. To search inside files use grep.",
      "- Build, dependency and VCS folders (node_modules, dist, .git, …) are skipped.",
      `- At most ${MAX_GLOB_RESULTS} paths are returned; narrow the pattern or the path if there are more.`,
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The glob pattern to match file paths against." },
        path: { type: "string", description: "Directory to search in. Defaults to the working directory." },
      },
      required: ["pattern"],
    },
  },
  intent: (args, context) => ({ action: "read", paths: [resolveToolPath(context.cwd, args.path ?? ".")] }),
  async run(args, context) {
    const root = resolveToolPath(context.cwd, args.path ?? ".");
    if ((await isDirectory(root)) !== true) return fail(`${root} is not a directory.`);
    const matches = globMatcher(args.pattern);
    const found: Array<{ file: string; mtime: number }> = [];
    for await (const relative of walk(root, context.signal)) {
      if (!matches(relative)) continue;
      try {
        found.push({ file: path.join(root, relative), mtime: (await fs.stat(path.join(root, relative))).mtimeMs });
      } catch {
        // Removed while walking.
      }
    }
    if (found.length === 0) return { content: `No files match ${args.pattern} under ${root}.` };
    found.sort((a, b) => b.mtime - a.mtime || (a.file < b.file ? -1 : 1));
    const shown = found.slice(0, MAX_GLOB_RESULTS).map((entry) => entry.file);
    const more = found.length > shown.length ? `\n\n(${found.length - shown.length} more not shown; narrow the pattern or path.)` : "";
    return { content: shown.join("\n") + more };
  },
};

// -- grep ---------------------------------------------------------------------

interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: "content" | "files_with_matches" | "count";
  case_insensitive?: boolean;
  context?: number;
  head_limit?: number;
}

export const grepTool: HarnessTool<GrepArgs> = {
  readOnly: true,
  definition: {
    name: "grep",
    description: [
      "Searches file contents with a regular expression (JavaScript syntax), e.g. \"function\\s+\\w+\" or \"TODO|FIXME\".",
      "",
      "- output_mode \"files_with_matches\" (default) lists files, \"content\" shows matching lines with file and line number, \"count\" shows match counts per file.",
      "- Narrow with glob (e.g. \"*.ts\") or path. Add context to see lines around each match so you often do not need to read the file.",
      `- Results stop after head_limit lines (default ${DEFAULT_GREP_LIMIT}); refine the search rather than raising it.`,
      "- Use this instead of running grep or rg in the shell. Build and dependency folders are skipped.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for." },
        path: { type: "string", description: "File or directory to search. Defaults to the working directory." },
        glob: { type: "string", description: "Only search files whose path matches this glob." },
        output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], description: "What to return." },
        case_insensitive: { type: "boolean", description: "Ignore case." },
        context: { type: "integer", description: "Lines of context before and after each match (content mode)." },
        head_limit: { type: "integer", description: "Maximum number of result lines." },
      },
      required: ["pattern"],
    },
  },
  intent: (args, context) => ({ action: "read", paths: [resolveToolPath(context.cwd, args.path ?? ".")] }),
  async run(args, context) {
    let regex: RegExp;
    try {
      regex = new RegExp(args.pattern, args.case_insensitive === true ? "i" : "");
    } catch (error) {
      return fail(`The pattern is not a valid regular expression: ${(error as Error).message}`);
    }
    const target = resolveToolPath(context.cwd, args.path ?? ".");
    const kind = await isDirectory(target);
    if (kind === null) return fail(`${target} does not exist.`);
    const root = kind ? target : path.dirname(target);
    const only = kind ? null : path.basename(target);
    const filter = args.glob ? globMatcher(args.glob) : null;
    const mode = args.output_mode ?? "files_with_matches";
    const limit = Math.max(1, args.head_limit ?? DEFAULT_GREP_LIMIT);
    const around = Math.max(0, Math.min(args.context ?? 0, 20));
    const out: string[] = [];
    let truncated = false;

    const files = only !== null ? (async function* () { yield only; })() : walk(root, context.signal);
    for await (const relative of files) {
      if (filter && !filter(relative)) continue;
      const file = path.join(root, relative);
      let buffer: Buffer;
      try {
        const stat = await fs.stat(file);
        if (stat.size > MAX_FILE_BYTES) continue;
        buffer = await fs.readFile(file);
      } catch {
        continue;
      }
      if (buffer.subarray(0, 8000).includes(0)) continue;
      const lines = buffer.toString("utf8").split("\n");
      if (lines.at(-1) === "") lines.pop();
      const hits: number[] = [];
      for (let index = 0; index < lines.length; index += 1) if (regex.test(lines[index]!)) hits.push(index);
      if (hits.length === 0) continue;
      if (mode === "files_with_matches") out.push(file);
      else if (mode === "count") out.push(`${file}:${hits.length}`);
      else {
        const shown = new Set<number>();
        for (const hit of hits) for (let at = Math.max(0, hit - around); at <= Math.min(lines.length - 1, hit + around); at += 1) shown.add(at);
        const hitSet = new Set(hits);
        let previous = -2;
        for (const index of [...shown].sort((a, b) => a - b)) {
          if (around > 0 && previous >= 0 && index > previous + 1) out.push("--");
          const text = lines[index]!.length > MAX_MATCH_LINE_CHARS ? `${lines[index]!.slice(0, MAX_MATCH_LINE_CHARS)}…` : lines[index]!;
          out.push(`${file}${hitSet.has(index) ? ":" : "-"}${index + 1}${hitSet.has(index) ? ":" : "-"}${text}`);
          previous = index;
        }
      }
      if (out.length >= limit) {
        truncated = true;
        break;
      }
    }
    if (out.length === 0) return { content: `No matches for ${args.pattern}.` };
    const lines = out.slice(0, limit);
    return { content: lines.join("\n") + (truncated ? `\n\n(Stopped at ${limit} result lines; narrow the search with glob or path.)` : "") };
  },
};
