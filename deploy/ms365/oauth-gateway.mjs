import http from 'node:http';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { OutlookOAuthProvider, matchesKey } from './oauth-provider.mjs';
import { createGateway } from './gateway.mjs';

export function createOAuthGateway({ key, stateFile, issuer = 'https://ms365.xgold.tech', upstreamPort = 3002, provider }) {
  provider ??= new OutlookOAuthProvider({ key, stateFile, issuer });
  const app = express();
  app.disable('x-powered-by');
  app.enable('strict routing');
  app.use((_req, res, next) => {
    res.set({
      'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    });
    next();
  });
  // Cloudflared reaches this loopback listener. Keep a global limit for owner
  // approvals rather than trusting arbitrary forwarded client IP headers.
  app.post('/approve', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10 }),
    express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
      if (req.headers.origin !== provider.issuer) return res.status(403).send('Invalid approval origin');
      const callback = typeof req.body.transaction === 'string' && provider.approve(req.body.transaction, req.body.key);
      if (!callback) return res.status(403).send('Approval failed or expired. Return to Claude and try connecting again.');
      console.log(JSON.stringify({ event: 'connector_oauth_approved' }));
      res.redirect(303, callback);
    });
  app.use(mcpAuthRouter({
    provider, issuerUrl: new URL(provider.issuer), resourceServerUrl: new URL(provider.resource),
    scopesSupported: ['mail.read'], resourceName: 'Personal Outlook (read-only)',
    clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
  }));
  const bearer = requireBearerAuth({
    verifier: provider, requiredScopes: ['mail.read'], expectedResource: new URL(provider.resource),
    resourceMetadataUrl: `${provider.issuer}/.well-known/oauth-protected-resource/mcp`,
  });
  const gateway = createGateway({ key, upstreamPort });
  const forward = (req, res) => {
    req.headers['x-connector-key'] = key;
    gateway.emit('request', req, res);
  };
  app.all('/mcp', (req, res, next) => {
    if (matchesKey(req.headers['x-connector-key'], key)) return forward(req, res);
    bearer(req, res, next);
  }, forward);
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((_err, _req, res, _next) => res.status(400).json({ error: 'invalid_request' }));
  const server = http.createServer(app);
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return { server, provider };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = new URL('./connector-key', import.meta.url);
  if (statSync(path).mode & 0o077) throw new Error('Connector key must have owner-only permissions');
  const key = readFileSync(path, 'utf8').trim();
  const { server } = createOAuthGateway({ key, stateFile: new URL('./oauth-state.json', import.meta.url) });
  server.listen(3001, '127.0.0.1', () => console.log('Outlook OAuth gateway listening on loopback port 3001'));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
