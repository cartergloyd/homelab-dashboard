import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import http from 'node:http';
import { createOAuthGateway } from './oauth-gateway.mjs';
import { OutlookOAuthProvider } from './oauth-provider.mjs';

test('browser approval sends the same origin and reaches the Claude callback', async t => {
  const key = 'test-browser-owner-key-'.repeat(3);
  let callback;
  // A second local origin stands in for Claude. No network request leaves the test.
  const callbackServer = http.createServer((req, res) => {
    callback = new URL(req.url, 'http://127.0.0.1');
    assert.equal(req.headers.referer, base + '/');
    res.end('Claude callback reached');
  });
  callbackServer.listen(0, '127.0.0.1'); await once(callbackServer, 'listening');
  t.after(() => { callbackServer.closeAllConnections(); callbackServer.close(); });
  const callbackUrl = `http://127.0.0.1:${callbackServer.address().port}/callback`;
  const provider = new OutlookOAuthProvider({ key, issuer: 'http://127.0.0.1', callbacks: [callbackUrl] });
  const { server } = createOAuthGateway({ key, provider });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  // Configure the provider's owner form for the dynamically allocated origin.
  // Discovery metadata is covered separately by the HTTP tests.
  provider.issuer = base;
  provider.resource = base + '/mcp';
  const client = await provider.clientsStore.registerClient({ redirect_uris: [callbackUrl], token_endpoint_auth_method: 'none' });
  const proof = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: callbackUrl,
    response_type: 'code', code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(proof).digest('base64url'),
    scope: 'microsoft.manage', resource: provider.resource, state: 'browser-test-state' });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(base + '/authorize?' + params);
  await page.getByLabel('Connector key').fill(key);
  const submitted = page.waitForResponse(response => response.url() === base + '/approve');
  await page.getByRole('button', { name: 'Allow Microsoft account management' }).click();
  const response = await submitted;
  assert.equal(response.request().headers().origin, base);
  assert.equal(response.status(), 303);
  // Referrer policy must not disclose authorization parameters to Claude.
  assert.equal(response.request().headers().referer, base + '/');
  await page.waitForURL(url => url.origin + url.pathname === callbackUrl);
  assert.equal(callback.searchParams.get('state'), 'browser-test-state');
  assert(callback.searchParams.get('code'));
});
