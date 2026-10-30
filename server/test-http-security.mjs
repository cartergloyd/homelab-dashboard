import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'homelab-http-security-'));
process.env.DATA_DIR = tmp;
process.env.DASHBOARD_KEY = 'test-private-key';
process.env.CF_ACCESS_TEAM_DOMAIN = 'test.cloudflareaccess.com';
process.env.CF_ACCESS_AUD = 'test-audience';
process.env.PUBLIC_DASHBOARD_URL = 'https://dashboard.example';
process.env.ALLOWED_LOGINS = 'owner@example.com';
const { resolveIdentity, accessVerifier, identityMiddleware } = await import('./dist/auth.js');
const { verifyAccessJwt } = await import('./dist/cf-access.js');
const { httpSecurity, sensitiveRateLimit } = await import('./dist/httpSecurity.js');
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const keys = [{ ...publicKey.export({ format: 'jwk' }), kid: 'test' }];
const sign = (overrides = {}) => {
  const encode = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const input = encode({ alg: 'RS256', kid: 'test' }) + '.' + encode({ aud: ['test-audience'], iss: 'https://test.cloudflareaccess.com', exp: Math.floor(Date.now()/1000)+60, email: 'owner@example.com', ...overrides });
  return input + '.' + crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
};
accessVerifier.verify = async (token) => verifyAccessJwt(token, { keys, aud: 'test-audience', teamDomain: 'test.cloudflareaccess.com' });
const human = sign();
const service = sign({ email: undefined, common_name: 'test-service.access' });
const key = { authorization: 'Bearer test-private-key' };
const remote = (token, extra = {}) => ({ 'cf-ray': 'test', 'cf-access-jwt-assertion': token, ...extra });
let server;
try {
  assert.equal((await resolveIdentity(key, '127.0.0.1')).ok, true);
  assert.equal((await resolveIdentity(key, '203.0.113.4')).status, 403);
  assert.equal((await resolveIdentity(remote(human), '127.0.0.1')).ok, true);
  assert.equal((await resolveIdentity(remote(human, key), '127.0.0.1')).status, 403, 'human JWT cannot authorize a remote key');
  assert.equal((await resolveIdentity(remote(service, key), '127.0.0.1')).ok, true);
  assert.equal((await resolveIdentity(remote(service), '127.0.0.1')).status, 401, 'service token alone cannot authorize API');
  assert.equal((await resolveIdentity(remote(service, { authorization: 'Bearer wrong' }), '127.0.0.1')).status, 401);
  assert.equal((await resolveIdentity(remote('forged', key), '127.0.0.1')).status, 401);
  assert.equal((await resolveIdentity({ ...key, 'cf-ray':'test', 'tailscale-user-login':'owner@example.com' }, '127.0.0.1')).status, 401);
  assert.equal((await resolveIdentity(remote(sign({ email:'outsider@example.com' })), '127.0.0.1')).status, 403);
  assert.equal((await resolveIdentity(remote(sign({ email:'outsider@example.com', common_name:'ambiguous' }),key), '127.0.0.1')).status, 403);
  let now = Date.now();
  const app = express();
  app.use(httpSecurity, identityMiddleware, sensitiveRateLimit(() => now));
  app.all(/.*/, (_req,res) => res.json({ ok:true }));
  server = app.listen(0,'127.0.0.1'); await once(server,'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url,method='GET') => fetch(base+url,{ method,headers:key });
  const r = await request('/api/config');
  assert.equal(r.status,200);
  assert.equal(r.headers.get('cache-control'),'no-store');
  assert.equal(r.headers.get('x-content-type-options'),'nosniff');
  assert.match(r.headers.get('strict-transport-security'),/max-age=/);
  assert.match(r.headers.get('content-security-policy'),/script-src 'self';/);
  assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  const unauth = await fetch(base+'/api/config');
  assert.equal(unauth.status,401);
  assert.equal(unauth.headers.get('cache-control'),'no-store');
  for(let i=0;i<30;i++) assert.equal((await request('/api/SiDeCaR/Approvals/test/','POST')).status,200);
  const limited=await request('/api/security/verify','POST');
  assert.equal(limited.status,429); assert.equal(limited.headers.get('retry-after'),'60');
  assert.equal((await request('/api/sidecar/approvals')).status,200,'read-only requests remain available');
  now+=60001;
  assert.equal((await request('/api/security/verify','POST')).status,200);
  const mcpHttp = spawnSync(process.execPath, ['server/dist/mcp.js'], { encoding: 'utf8', env: { ...process.env, HOMELAB_URL: 'http://dashboard.example', CF_ACCESS_CLIENT_ID: 'fixture-id', CF_ACCESS_CLIENT_SECRET: 'fixture-secret' } });
  assert.notEqual(mcpHttp.status, 0); assert.match(mcpHttp.stderr, /require an HTTPS HOMELAB_URL/);
  const mcpHalf = spawnSync(process.execPath, ['server/dist/mcp.js'], { encoding: 'utf8', env: { ...process.env, HOMELAB_URL: 'https://dashboard.example', CF_ACCESS_CLIENT_ID: 'fixture-id', CF_ACCESS_CLIENT_SECRET: '' } });
  assert.notEqual(mcpHalf.status, 0); assert.match(mcpHalf.stderr, /Set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET/);
  console.log('http-security: signed human/service token separation, private keys, headers, cache and approval rate limits passed');
} finally {
  if(server) {server.closeAllConnections(); await new Promise(r=>server.close(r));}
  // Let the alert hub finish its queued login-event write before removing fixtures.
  await new Promise(r=>setTimeout(r,1100));
  await fs.rm(tmp,{recursive:true,force:true});
}
