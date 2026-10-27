import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOAuthGateway } from './oauth-gateway.mjs';
import { OutlookOAuthProvider, CALLBACKS } from './oauth-provider.mjs';

const key = 'test-owner-key-'.repeat(5);
const issuer = 'https://ms365.xgold.tech';
const resource = issuer + '/mcp';
const callback = CALLBACKS[0];
const challenge = verifier => createHash('sha256').update(verifier).digest('base64url');
const verifier = () => randomBytes(32).toString('base64url');

async function fixture(t) {
  let forwarded = 0;
  const upstream = http.createServer((req, res) => {
    forwarded++;
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers['x-connector-key'], undefined);
    res.setHeader('Content-Type', 'application/json');
    res.end('{"ok":true}');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const dir = mkdtempSync(join(tmpdir(), 'outlook-oauth-'));
  const stateFile = join(dir, 'oauth-state.json');
  const { server, provider } = createOAuthGateway({ key, stateFile, upstreamPort: upstream.address().port });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections(); server.close();
    upstream.closeAllConnections(); upstream.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(base + path, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body),
  });
  const register = async (redirect = callback) => fetch(base + '/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: 'none', client_name: 'Claude' }),
  });
  const begin = async (client, proof = verifier()) => {
    const q = new URLSearchParams({ client_id: client.client_id, redirect_uri: callback,
      response_type: 'code', code_challenge: challenge(proof), code_challenge_method: 'S256',
      scope: 'mail.read', state: 'client-state', resource });
    const response = await fetch(base + '/authorize?' + q, { redirect: 'manual' });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const html = await response.text();
    assert(!html.includes(key));
    return { proof, transaction: html.match(/name="transaction" value="([\w-]+)"/)[1] };
  };
  const approve = async transaction => {
    const response = await post('/approve', { transaction, key }, { origin: issuer });
    assert.equal(response.status, 303);
    const url = new URL(response.headers.get('location'));
    assert.equal(url.origin + url.pathname, callback);
    assert.equal(url.searchParams.get('state'), 'client-state');
    return url.searchParams.get('code');
  };
  const exchange = (client, code, proof, overrides = {}) => post('/token', {
    grant_type: 'authorization_code', client_id: client.client_id,
    code, code_verifier: proof, redirect_uri: callback, resource, ...overrides,
  });
  return { base, post, register, begin, approve, exchange, provider, stateFile, count: () => forwarded };
}

test('discovery challenges unauthenticated clients and registration restricts callbacks', async t => {
  const f = await fixture(t);
  const denied = await fetch(f.base + '/mcp', { method: 'POST', body: '{}' });
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get('www-authenticate'), /resource_metadata="https:\/\/ms365.xgold.tech\/\.well-known\/oauth-protected-resource\/mcp"/);
  const metadata = await (await fetch(f.base + '/.well-known/oauth-authorization-server')).json();
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
  assert.equal(metadata.registration_endpoint, issuer + '/register');
  const prm = await (await fetch(f.base + '/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(prm.resource, resource);
  assert.equal((await f.register('https://attacker.example/callback')).status, 400);
  assert.equal((await f.register(callback + '?attacker=1')).status, 400);
  assert.equal((await f.register()).status, 201);
  assert.equal(f.count(), 0);
});

test('owner approval, PKCE, client, callback, resource and one-use code are enforced', async t => {
  const f = await fixture(t);
  const client = await (await f.register()).json();
  const other = await (await f.register()).json();
  const { proof, transaction } = await f.begin(client);
  assert.equal((await f.post('/approve', { transaction, key }, { origin: 'https://attacker.example' })).status, 403);
  assert.equal((await f.post('/approve', { transaction, key: 'wrong' }, { origin: issuer })).status, 403);
  const code = await f.approve(transaction);
  assert.equal((await f.post('/approve', { transaction, key }, { origin: issuer })).status, 403);
  assert.equal((await f.exchange(other, code, proof)).status, 400);
  assert.equal((await f.exchange(client, code, verifier())).status, 400);
  assert.equal((await f.exchange(client, code, proof, { redirect_uri: 'https://attacker.example' })).status, 400);
  assert.equal((await f.exchange(client, code, proof, { resource: 'https://attacker.example/mcp' })).status, 400);
  const response = await f.exchange(client, code, proof);
  assert.equal(response.status, 200);
  const tokens = await response.json();
  assert.equal((await f.exchange(client, code, proof)).status, 400);
  assert.equal((await fetch(f.base + '/mcp', { headers: { authorization: 'Bearer ' + tokens.access_token } })).status, 200);
  assert.equal(f.count(), 1);
  const saved = readFileSync(f.stateFile, 'utf8');
  for (const secret of [key, code, tokens.access_token, tokens.refresh_token]) assert(!saved.includes(secret));
  assert.equal(statSync(f.stateFile).mode & 0o777, 0o600);
  const restarted = new OutlookOAuthProvider({ key, stateFile: f.stateFile });
  assert.equal((await restarted.verifyAccessToken(tokens.access_token)).clientId, client.client_id);
  const rotated = new OutlookOAuthProvider({ key: 'new-owner-key-'.repeat(5), stateFile: f.stateFile });
  await assert.rejects(rotated.verifyAccessToken(tokens.access_token));
});

test('refresh rotates credentials, prevents client/resource/scope misuse, and revokes grants', async t => {
  const f = await fixture(t);
  const client = await (await f.register()).json();
  const other = await (await f.register()).json();
  const { proof, transaction } = await f.begin(client);
  const tokens = await (await f.exchange(client, await f.approve(transaction), proof)).json();
  const refresh = overrides => f.post('/token', {
    grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token, resource, ...overrides,
  });
  assert.equal((await refresh({ client_id: other.client_id })).status, 400);
  assert.equal((await refresh({ scope: 'mail.write' })).status, 400);
  assert.equal((await refresh({ resource: 'https://attacker.example/mcp' })).status, 400);
  const response = await refresh({});
  assert.equal(response.status, 200);
  const renewed = await response.json();
  await assert.rejects(f.provider.verifyAccessToken(tokens.access_token));
  assert.equal((await f.provider.verifyAccessToken(renewed.access_token)).resource.href, resource);
  assert.equal((await f.post('/revoke', { client_id: client.client_id, token: renewed.refresh_token })).status, 200);
  await assert.rejects(f.provider.verifyAccessToken(renewed.access_token));
  const replayed = f.provider.issue(client.client_id);
  const rotated = await f.provider.exchangeRefreshToken(client, replayed.refresh_token);
  await assert.rejects(f.provider.exchangeRefreshToken(client, replayed.refresh_token));
  await assert.rejects(f.provider.verifyAccessToken(rotated.access_token));
  await assert.rejects(f.provider.exchangeRefreshToken(client, rotated.refresh_token));
  assert.equal(f.count(), 0);
});

test('expired codes and access tokens are rejected; legacy key still works', async t => {
  const f = await fixture(t);
  const client = await (await f.register()).json();
  const { proof, transaction } = await f.begin(client);
  const code = await f.approve(transaction);
  for (const record of f.provider.codes.values()) record.expiresAt = 0;
  assert.equal((await f.exchange(client, code, proof)).status, 400);
  const tokens = f.provider.issue(client.client_id);
  for (const record of Object.values(f.provider.state.access)) record.expiresAt = 0;
  assert.equal((await fetch(f.base + '/mcp', { headers: { authorization: 'Bearer ' + tokens.access_token } })).status, 401);
  assert.equal((await fetch(f.base + '/mcp', { headers: { 'X-Connector-Key': key } })).status, 200);
  assert.equal((await fetch(f.base + '/mcp', { headers: { 'X-Connector-Key': 'wrong' } })).status, 401);
  assert.equal(f.count(), 1);
});
