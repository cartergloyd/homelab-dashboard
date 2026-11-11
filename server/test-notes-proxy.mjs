import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';

// A stand-in for AppFlowy's nginx: records what reaches it, answers pages, bodies and websockets.
const seen = [];
const upstream = http.createServer((req, res) => {
  let size = 0;
  req.on('data', (c) => (size += c.length));
  req.on('end', () => {
    seen.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'text/plain', 'content-security-policy': "default-src 'none'", 'x-frame-options': 'DENY' });
    res.end(req.method === 'POST' ? `len:${size}` : `upstream:${req.url}`);
  });
});
const sync = new WebSocketServer({ server: upstream });
sync.on('connection', (ws, req) => {
  ws.send(`hello ${req.url}`);
  ws.on('message', (m) => ws.send(`echo ${m}`));
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');

process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'homelab-notes-proxy-'));
process.env.ALLOWED_LOGINS = 'owner@example.com';
process.env.NOTES_UPSTREAM = `http://127.0.0.1:${upstream.address().port}`;
const { notesProxy, attachNotesSocket } = await import('./dist/services/notesProxy.js');
const { attachLogSocket } = await import('./dist/ws.js');

const app = express();
app.use(notesProxy);
app.get('/api/config', (_req, res) => res.send('dash'));
const dash = http.createServer(app);
attachLogSocket(dash); // the dash's own sockets must keep working next to the proxy
attachNotesSocket(dash);
dash.listen(0, '127.0.0.1');
await once(dash, 'listening');
const base = `http://127.0.0.1:${dash.address().port}`;
const owner = { 'tailscale-user-login': 'owner@example.com' };
const get = (p, headers = owner, init = {}) => fetch(base + p, { redirect: 'manual', headers, ...init });

try {
  // nobody gets through without a dash sign-in
  assert.equal((await get('/appflowy/api/health', {})).status, 401);
  assert.equal(seen.length, 0, 'an unauthenticated request never reaches AppFlowy');

  // /appflowy/* is forwarded without the prefix; AppFlowy's own bearer token passes, the dash's credentials do not
  const r = await get('/appflowy/api/workspace/1?z=2', { ...owner, authorization: 'Bearer appflowy-jwt', cookie: 'CF_Authorization=secret' });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'upstream:/api/workspace/1?z=2');
  assert.equal(seen[0].headers.authorization, 'Bearer appflowy-jwt');
  assert.equal(seen[0].headers.cookie, undefined);
  assert.equal(seen[0].headers['tailscale-user-login'], undefined);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');

  // the entry point opens the app; the root paths AppFlowy asks for by absolute path are forwarded as-is
  for (const p of ['/appflowy', '/appflowy/', '/appflowy/?x=1']) {
    const e = await get(p);
    assert.equal(e.status, 302);
    assert.equal(e.headers.get('location'), '/app');
  }
  assert.equal(await (await get('/static/js/a.js')).text(), 'upstream:/static/js/a.js');
  assert.equal(await (await get('/app/ws1/view2')).text(), 'upstream:/app/ws1/view2');

  // everything else is still the dash's
  const before = seen.length;
  assert.equal(await (await get('/api/config')).text(), 'dash');
  assert.equal(seen.length, before);

  // bodies are streamed, not parsed or capped (the dash's JSON limit is 1 MB)
  const body = JSON.stringify({ d: 'x'.repeat(2_000_000) });
  const big = await get('/appflowy/api/import', { ...owner, 'content-type': 'application/json' }, { method: 'POST', body });
  assert.equal(await big.text(), `len:${body.length}`);

  // websocket: sync traffic round-trips, and a socket without a dash sign-in is refused
  const ws = new WebSocket(`${base.replace('http', 'ws')}/appflowy/ws/v2/abc?x=1`, { headers: owner });
  const msgs = [];
  ws.on('message', (m) => msgs.push(String(m)));
  await once(ws, 'open');
  ws.send('hi');
  while (msgs.length < 2) await new Promise((ok) => setTimeout(ok, 10));
  assert.deepEqual(msgs, ['hello /ws/v2/abc?x=1', 'echo hi']);
  ws.close();
  const denied = new WebSocket(`${base.replace('http', 'ws')}/appflowy/ws/v2/abc`);
  const [err] = await once(denied, 'error');
  assert.match(err.message, /401/);
  console.log('notes-proxy: prefix mapping, login separation, header overrides, large bodies and websocket sync passed');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  process.exit(process.exitCode ?? 0); // open sockets and the dash's timers would keep the process alive
}
