// Smoke test for the MCP server against a running dashboard.
//   cd server && HOMELAB_KEY=... node test-mcp.mjs          (defaults to the demo key + :3000)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/mcp.js"],
  env: { ...process.env, HOMELAB_URL: process.env.HOMELAB_URL ?? "http://127.0.0.1:3000", HOMELAB_KEY: process.env.HOMELAB_KEY ?? "demo-key-not-secret" },
  stderr: "pipe",
});
const client = new Client({ name: "test-client", version: "0.0.1" });
await client.connect(transport);

const show = (label, r) => console.log(`\n== ${label}\n${String(r.content?.[0]?.text ?? "").slice(0, 700)}`);

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));
const resources = await client.listResources();
console.log("resources:", resources.resources.map((r) => r.uri).join(", "));

show("get_alerts (problems only, 5)", await client.callTool({ name: "get_alerts", arguments: { problemsOnly: true, limit: 5 } }));
show("minecraft_rcon list", await client.callTool({ name: "minecraft_rcon", arguments: { command: "list" } }));
show("list_scripts", await client.callTool({ name: "list_scripts", arguments: {} }));
show("append_instructions", await client.callTool({ name: "append_instructions", arguments: { text: "- MCP smoke test ran successfully.", note: "mcp smoke test" } }));
show("read_instructions (tail)", { content: [{ text: (await client.callTool({ name: "read_instructions", arguments: {} })).content[0].text.slice(-200) }] });

await client.close();
console.log("\nOK");
