// This is a protocol smoke check, not proof of a successful Claude UI connection.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = 'https://ms365.xgold.tech';
const resource = base + '/mcp';
const callback = 'https://claude.ai/api/mcp/auth_callback';
const key = readFileSync(new URL('./connector-key', import.meta.url), 'utf8').trim();
const request = (url, options = {}) => fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'manual', ...options });
const post = (path, body, headers = {}) => request(base + path, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body),
});
const denied = await request(resource, { method: 'POST', body: '{}' });
assert.equal(denied.status, 401);
assert(denied.headers.get('www-authenticate').includes('/.well-known/oauth-protected-resource/mcp'));
const metadata = await (await request(base + '/.well-known/oauth-authorization-server')).json();
assert.equal(metadata.authorization_endpoint, base + '/authorize');
assert.equal(metadata.token_endpoint, base + '/token');
assert.equal(metadata.registration_endpoint, base + '/register');
const registered = await request(metadata.registration_endpoint, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ redirect_uris: [callback], token_endpoint_auth_method: 'none', client_name: 'Gold OAuth smoke check' }),
});
assert.equal(registered.status, 201);
const { client_id } = await registered.json();
const proof = randomBytes(32).toString('base64url');
const params = new URLSearchParams({ client_id, redirect_uri: callback, response_type: 'code',
  code_challenge: createHash('sha256').update(proof).digest('base64url'), code_challenge_method: 'S256',
  scope: 'microsoft.manage', resource, state: 'gold-smoke-check' });
const page = await request(metadata.authorization_endpoint + '?' + params);
assert.equal(page.status, 200);
const transaction = (await page.text()).match(/name="transaction" value="([\w-]+)"/)[1];
const approval = await post('/approve', { transaction, key }, { origin: base });
assert.equal(approval.status, 303);
const redirect = new URL(approval.headers.get('location'));
assert.equal(redirect.origin + redirect.pathname, callback);
assert.equal(redirect.searchParams.get('state'), 'gold-smoke-check');
const response = await post('/token', { grant_type: 'authorization_code', client_id,
  code: redirect.searchParams.get('code'), code_verifier: proof, redirect_uri: callback, resource });
assert.equal(response.status, 200);
const tokens = await response.json();
const client = new Client({ name: 'gold-oauth-smoke', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(resource), {
    requestInit: { headers: { authorization: 'Bearer ' + tokens.access_token } },
  }));
  const { tools } = await client.listTools();
  const names = tools.map(tool => tool.name);
  for (const name of ['send-mail', 'create-mail-rule', 'update-mail-rule', 'delete-mail-rule', 'create-calendar-event', 'update-calendar-event', 'delete-calendar-event', 'upload-file-content', 'create-todo-task', 'graph-batch']) assert(names.includes(name), `Missing tool: ${name}`);
  const result = await client.callTool({ name: 'list-mail-messages', arguments: { top: 1, select: ['id'] } });
  assert(!result.isError);
  const data = JSON.parse(result.content.find(c => c.type === 'text').text);
  assert(Array.isArray(data.value));
  console.log(JSON.stringify({ oauthDiscovery: 'passed', ownerApproval: 'passed', pkceExchange: 'passed',
    mcpHandshake: 'passed', managementTools: tools.length, mailboxRead: 'passed', messagesReturned: data.value.length }));
} finally {
  await client.close();
  const revoke = await post('/revoke', { client_id, token: tokens.refresh_token });
  assert.equal(revoke.status, 200);
  const revoked = await request(resource, { method: 'POST', body: '{}', headers: { authorization: 'Bearer ' + tokens.access_token } });
  assert.equal(revoked.status, 401);
  console.log('Smoke-check grant revoked');
}
