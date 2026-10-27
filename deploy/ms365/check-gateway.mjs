import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const key = readFileSync(new URL('./connector-key', import.meta.url), 'utf8').trim();
const base = process.argv[2] || 'http://127.0.0.1:3001/mcp';
for (const headers of [{}, { 'X-Connector-Key': 'incorrect' }]) {
  const response = await fetch(base, { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 401, 'Invalid connector credentials must fail');
}
console.log('Missing and incorrect keys rejected');
const client = new Client({ name: 'homelab-gateway-check', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(base), {
    requestInit: { headers: { 'X-Connector-Key': key } },
  }));
  const { tools } = await client.listTools();
  const names = tools.map(t => t.name);
  assert(names.includes('list-mail-messages'));
  for (const name of ['login', 'logout', 'verify-login', 'select-account', 'remove-account', 'send-mail', 'delete-mail-message', 'graph-batch', 'download-bytes-to-file']) {
    assert(!names.includes(name), `Unexpected remote tool: ${name}`);
  }
  console.log(JSON.stringify({ handshake: 'passed', readOnlyTools: names.length }));
  const result = await client.callTool({ name: 'list-mail-messages', arguments: { top: 1, select: ['id'] } });
  assert(!result.isError, 'Authenticated mailbox request failed');
  const data = JSON.parse(result.content.find(c => c.type === 'text').text);
  assert(Array.isArray(data.value));
  console.log(JSON.stringify({ mailboxRead: 'passed', messagesReturned: data.value.length }));
} finally {
  await client.close();
}
