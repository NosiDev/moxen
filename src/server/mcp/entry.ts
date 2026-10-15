/**
 * The bundle's entry for the moxen MCP server. `import.meta.main` does not
 * survive bundling into a shared chunk, so this entry starts the server
 * unconditionally, like `../daemon.ts` does for the server process.
 */
import { runMcpMain } from "./main.js";

await runMcpMain();
