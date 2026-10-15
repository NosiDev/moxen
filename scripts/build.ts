/**
 * Bundles moxen into `dist/` for `bun dist/cli/index.js` (the `moxen` bin).
 *
 * Bundling does the transpile once, here, instead of on every launch through
 * Bun's runtime transpiler and its on-disk cache (which has served stale
 * output). It also bakes in the production JSX runtime — `process.env.NODE_ENV`
 * is replaced at build time, including inside React — so the TUI no longer has
 * to re-exec itself under `NODE_ENV=production`. Code splitting keeps the TUI
 * (React, OpenTUI, the grammars) out of the startup path of plain commands.
 */
import { rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });

const result = await Bun.build({
  // The server and the moxen MCP server are spawned as their own processes
  // (`src/server/client.ts`, `src/server/mcp/main.ts`).
  entrypoints: ["src/cli/index.ts", "src/server/daemon.ts", "src/server/mcp/entry.ts"],
  outdir: "dist",
  target: "bun",
  format: "esm",
  splitting: true,
  minify: true,
  sourcemap: "linked",
  define: { "process.env.NODE_ENV": '"production"' },
  naming: { entry: "[dir]/[name].[ext]", chunk: "chunks/[name]-[hash].[ext]", asset: "assets/[name]-[hash].[ext]" },
  // Native libraries are located on disk at runtime: leave them to node_modules.
  external: ["@opentui/core-*"],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// The grammar, worker and runtime-wasm imports are `import("./x", { with: { type: "file" | "wasm" } })`:
// at build time that makes `x` an asset, but the bundler leaves the attribute
// on the call, now pointing at the chunk that exports the asset's path — so at
// runtime Bun answers with the chunk's own path instead of running it. Dropping
// the attribute lets the chunk run and hand back the asset path it carries.
let stripped = 0;
for (const output of result.outputs) {
  if (output.kind !== "entry-point" && output.kind !== "chunk") continue;
  const source = await output.text();
  const rewritten = source.replace(/(import\("\.\/[^"]+\.js"),\{with:\{type:"(?:file|wasm)"\}\}\)/g, (_match, call) => {
    stripped += 1;
    return `${call})`;
  });
  if (rewritten !== source) await Bun.write(output.path, rewritten);
}
console.log(`built ${result.outputs.length} files into dist/ (${stripped} file imports rewritten)`);
