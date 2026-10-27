import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createGateway } from './gateway.mjs';

test('gateway rejects missing/wrong credentials and closes OAuth routes', async t => {
  let forwarded = 0;
  const upstream = http.createServer((req, res) => { forwarded++; res.end('{}'); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const gateway = createGateway({ key: 'x'.repeat(64), upstreamPort: upstream.address().port });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  t.after(() => { gateway.closeAllConnections(); gateway.close(); upstream.closeAllConnections(); upstream.close(); });
  const base = `http://127.0.0.1:${gateway.address().port}`;
  for (const headers of [{}, { 'X-Connector-Key': 'wrong' }, { Authorization: 'Bearer ' + 'x'.repeat(64) }]) {
    assert.equal((await fetch(base + '/mcp', { method: 'POST', headers, body: '{}' })).status, 401);
  }
  for (const path of ['/authorize', '/token', '/register', '/.well-known/oauth-protected-resource']) {
    assert.equal((await fetch(base + path, { headers: { 'X-Connector-Key': 'x'.repeat(64) } })).status, 404);
  }
  assert.equal(forwarded, 0);
});

test('authenticated requests preserve MCP content and strip credentials', async t => {
  const upstream = http.createServer((req, res) => {
    assert.equal(req.url, '/mcp');
    assert.equal(req.headers['x-connector-key'], undefined);
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers['mcp-protocol-version'], '2025-03-26');
    res.setHeader('Content-Type', 'application/json');
    req.pipe(res);
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const gateway = createGateway({ key: 'x'.repeat(64), upstreamPort: upstream.address().port });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  t.after(() => { gateway.closeAllConnections(); gateway.close(); upstream.closeAllConnections(); upstream.close(); });
  const response = await fetch(`http://127.0.0.1:${gateway.address().port}/mcp`, {
    method: 'POST', headers: { 'X-Connector-Key': 'x'.repeat(64), Authorization: 'should-not-forward', 'MCP-Protocol-Version': '2025-03-26', 'Content-Type': 'application/json' },
    body: '{"jsonrpc":"2.0","id":1}',
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { jsonrpc: '2.0', id: 1 });
});

test('oversized authenticated requests never reach the upstream', async t => {
  let forwarded = 0;
  const upstream = http.createServer((req, res) => { forwarded++; res.end('{}'); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const gateway = createGateway({ key: 'x'.repeat(64), upstreamPort: upstream.address().port });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  t.after(() => { gateway.closeAllConnections(); gateway.close(); upstream.closeAllConnections(); upstream.close(); });
  const response = await fetch(`http://127.0.0.1:${gateway.address().port}/mcp`, {
    method: 'POST', headers: { 'X-Connector-Key': 'x'.repeat(64) }, body: 'x'.repeat(1024 * 1024 + 1),
  });
  assert.equal(response.status, 413);
  assert.equal(forwarded, 0);
});
