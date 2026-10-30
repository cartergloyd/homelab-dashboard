import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const requests = [];
const server = http.createServer((req, res) => {
  requests.push({ path: req.url, runId: req.headers['x-homelab-run-id'] });
  req.resume();
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(req.url === '/api/sidecar/approvals' ? { id: 'fixture', status: 'pending' } : { ok: true }));
}).listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  for (const managed of [false, true]) {
    const client = new Client({ name: 'approval-routing-test', version: '1.0' });
    const env = { ...process.env, HOMELAB_URL: `http://127.0.0.1:${server.address().port}`, HOMELAB_KEY: 'fixture' };
    delete env.HOMELAB_RUN_ID;
    if (managed) env.HOMELAB_RUN_ID = 'dedicated-run';
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: ['server/dist/mcp.js'], env }));
      const tools = await client.listTools();
      const approval = tools.tools.find(t => t.name === 'request_approval');
      assert.ok(approval.description.includes(managed ? 'STOP and end your turn' : 'current CLI or assistant conversation'));
      const before = requests.length;
      const answer = await client.callTool({ name: 'request_approval', arguments: { action: 'minecraft_service:restart', reason: 'fixture only' } });
      assert.equal(answer.isError, undefined);
      assert.equal(requests.length, before + Number(managed), 'interactive questions must not create dashboard holds');
      await client.callTool({ name: 'minecraft_service', arguments: { action: 'restart' } });
      assert.equal(requests.at(-1).path, '/api/minecraft/action');
      assert.equal(requests.at(-1).runId, managed ? 'dedicated-run' : undefined, 'dedicated run identity must reach the API');
    } finally { await client.close(); }
  }
  console.log('approval-routing: interactive conversation guidance and dedicated assistant run headers passed (mock API only)');
} finally { await new Promise(resolve => server.close(resolve)); }
