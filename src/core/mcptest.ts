/**
 * "Does this MCP server start, and what does it offer": connects with the
 * harness's MCP client, lists the tools, and disconnects. Used by the
 * settings page's test action so a user can see the tool names to hide.
 */
import { McpClient } from "./providers/harness/mcpclient.js";
import { outOfProcess, resolveMcpServers, type McpServerEntry } from "./mcp.js";

export interface McpTestResult {
  readonly ok: boolean;
  readonly name: string;
  readonly message: string;
  /** The server's tool names, sorted. */
  readonly tools: readonly string[];
}

export async function testMcpServer(name: string, servers: Readonly<Record<string, McpServerEntry>> | undefined, cwd: string, connect: typeof McpClient.connect = McpClient.connect): Promise<McpTestResult> {
  const spec = (await resolveMcpServers(servers, null)).find((candidate) => candidate.name === name);
  if (spec === undefined) return { ok: false, name, message: `There is no MCP server called "${name}".`, tools: [] };
  const started = Date.now();
  try {
    const client = await connect(outOfProcess(spec), cwd);
    try {
      const tools = client.tools.map((tool) => tool.name);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      return { ok: true, name, message: `${name} answered in ${seconds}s with ${tools.length} tool${tools.length === 1 ? "" : "s"}${tools.length > 0 ? `: ${tools.join(", ")}` : ""}.`, tools };
    } finally {
      await client.close().catch(() => undefined);
    }
  } catch (error) {
    return { ok: false, name, message: `${name} did not start: ${(error as Error).message}`, tools: [] };
  }
}
