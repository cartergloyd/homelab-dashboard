import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const json = (res, status, error) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error }));
};

// The upstream uses a single cached Microsoft identity. Every public request
// must pass this boundary before it can reach that upstream.
export function createGateway({ key, upstreamPort = 3002 }) {
  const expected = Buffer.from(key);
  if (expected.length < 48) throw new Error('Connector key must contain at least 48 characters');
  const server = http.createServer((req, res) => {
    if (req.url !== '/mcp') return json(res, 404, 'not_found');
    const supplied = Buffer.from(typeof req.headers['x-connector-key'] === 'string' ? req.headers['x-connector-key'] : '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      console.warn(JSON.stringify({ event: 'connector_auth_denied', reason: supplied.length ? 'key_mismatch' : 'key_missing', authorizationHeaderPresent: Boolean(req.headers.authorization) }));
      return json(res, 401, 'connector_key_required');
    }
    if (!['POST', 'GET', 'DELETE'].includes(req.method)) return json(res, 405, 'method_not_allowed');
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        if (!rejected) json(res, 413, 'request_too_large');
        rejected = true;
        chunks.length = 0;
      } else if (!rejected) chunks.push(chunk);
    });
    req.on('error', () => { if (!res.headersSent) json(res, 400, 'invalid_request'); });
    req.on('end', () => {
      if (rejected || res.destroyed) return;
      const body = Buffer.concat(chunks);
      const headers = { 'content-length': String(body.length) };
      for (const name of ['accept', 'content-type', 'mcp-protocol-version', 'mcp-session-id']) {
        if (req.headers[name]) headers[name] = req.headers[name];
      }
      // Neither the connector key nor any client Authorization header is
      // forwarded to Microsoft, the MCP upstream, redirects, or logs.
      const upstream = http.request({
        host: '127.0.0.1', port: upstreamPort, path: '/mcp', method: req.method,
        headers, timeout: 30000,
      }, response => {
        const responseHeaders = { 'Cache-Control': 'no-store' };
        for (const name of ['content-type', 'mcp-session-id', 'mcp-protocol-version']) {
          if (response.headers[name]) responseHeaders[name] = response.headers[name];
        }
        res.writeHead(response.statusCode, responseHeaders);
        response.on('error', () => res.destroy());
        response.pipe(res);
      });
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => {
        if (!res.headersSent) json(res, 502, 'upstream_unavailable');
        else res.destroy();
      });
      res.on('close', () => upstream.destroy());
      upstream.end(body);
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = new URL('./connector-key', import.meta.url);
  if (statSync(path).mode & 0o077) throw new Error('Connector key must have owner-only permissions');
  const key = readFileSync(path, 'utf8').trim();
  const server = createGateway({ key });
  server.listen(3001, '127.0.0.1', () => console.log('Connector gateway listening on loopback port 3001'));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
