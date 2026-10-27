import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  InvalidClientMetadataError, InvalidGrantError, InvalidScopeError, InvalidTargetError,
  InvalidTokenError, InvalidRequestError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';

export const CALLBACKS = ['https://claude.ai/api/mcp/auth_callback'];
const random = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => Math.floor(Date.now() / 1000);
export const matchesKey = (actual, expected) => {
  const a = Buffer.from(typeof actual === 'string' ? actual : '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

// Single-owner authorization server. Microsoft tokens never leave the upstream.
// Only opaque, resource-bound gateway tokens are issued to Claude.
export class OutlookOAuthProvider {
  constructor({ key, stateFile, issuer = 'https://ms365.xgold.tech', callbacks = CALLBACKS }) {
    if (Buffer.byteLength(key) < 48) throw new Error('Connector key must contain at least 48 characters');
    this.key = key;
    this.stateFile = stateFile instanceof URL ? fileURLToPath(stateFile) : stateFile;
    this.issuer = new URL(issuer).origin;
    this.resource = `${this.issuer}/mcp`;
    this.callbacks = callbacks;
    this.pending = new Map();
    this.codes = new Map();
    this.state = { keyHash: hash(key), clients: {}, access: {}, refresh: {}, usedRefresh: {} };
    if (this.stateFile && existsSync(this.stateFile)) {
      if (statSync(this.stateFile).mode & 0o077) throw new Error('OAuth state must have owner-only permissions');
      const saved = JSON.parse(readFileSync(this.stateFile, 'utf8'));
      // Rotating the owner key invalidates every registration and token.
      if (saved.keyHash === hash(key)) this.state = { ...saved, usedRefresh: saved.usedRefresh ?? {} };
    }
    this.clientsStore = {
      getClient: id => Object.hasOwn(this.state.clients, id) ? this.state.clients[id] : undefined,
      registerClient: client => {
        if (!client.redirect_uris?.length || client.redirect_uris.some(uri => !this.callbacks.includes(uri))) {
          throw new InvalidClientMetadataError('Only the Claude callback is allowed');
        }
        if (!['none', 'client_secret_post', 'client_secret_basic', undefined].includes(client.token_endpoint_auth_method)) {
          throw new InvalidClientMetadataError('Unsupported authentication method');
        }
        if (Object.keys(this.state.clients).length >= 1000) throw new InvalidClientMetadataError('Registration limit reached');
        const registered = { ...client, client_id: random(), client_id_issued_at: now() };
        this.state.clients[registered.client_id] = registered;
        this.save();
        return registered;
      },
    };
  }

  save() {
    for (const kind of ['access', 'refresh', 'usedRefresh']) {
      for (const [id, record] of Object.entries(this.state[kind])) {
        if (record.expiresAt <= now()) delete this.state[kind][id];
      }
    }
    if (!this.stateFile) return;
    const temp = `${this.stateFile}.${random()}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600, flag: 'wx' });
    renameSync(temp, this.stateFile);
  }

  validateResource(resource) {
    if (resource !== undefined && String(resource) !== this.resource) throw new InvalidTargetError('Wrong resource');
  }

  validateScopes(scopes = []) {
    if (scopes.some(scope => scope !== 'mail.read')) throw new InvalidScopeError('Only mail.read is supported');
  }

  async authorize(client, params, res) {
    this.validateResource(params.resource);
    this.validateScopes(params.scopes);
    if (!this.callbacks.includes(params.redirectUri)) throw new InvalidRequestError('Callback is not allowed');
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) throw new InvalidRequestError('Invalid S256 challenge');
    for (const [id, record] of this.pending) if (record.expiresAt <= now()) this.pending.delete(id);
    if (this.pending.size >= 100) throw new InvalidRequestError('Too many pending authorizations');
    const transaction = random();
    this.pending.set(transaction, { clientId: client.client_id, ...params, expiresAt: now() + 600 });
    res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect Personal Outlook</title>
<body><main><h1>Connect Personal Outlook to Claude</h1>
<p>Allow Claude to read and search the personal Outlook mailbox connected to Gold.
This connector cannot send, change, or delete email.</p>
<p>Enter your connector key from Gold to approve this connection. This is not your Microsoft password.</p>
<form method="post" action="/approve">
<input type="hidden" name="transaction" value="${transaction}">
<label>Connector key <input type="password" name="key" required autocomplete="off" maxlength="256"></label>
<button type="submit">Allow read-only access</button></form>
<p>Close this page to cancel.</p></main></body></html>`);
  }

  approve(transaction, key) {
    const record = this.pending.get(transaction);
    if (!record || record.expiresAt <= now() || !matchesKey(key, this.key)) return undefined;
    this.pending.delete(transaction);
    for (const [id, code] of this.codes) if (code.expiresAt <= now()) this.codes.delete(id);
    const code = random();
    this.codes.set(hash(code), { ...record, expiresAt: now() + 120 });
    const callback = new URL(record.redirectUri);
    callback.searchParams.set('code', code);
    if (record.state !== undefined) callback.searchParams.set('state', record.state);
    return callback.href;
  }

  getCode(client, code) {
    const record = this.codes.get(hash(code));
    if (!record || record.clientId !== client.client_id || record.expiresAt <= now()) throw new InvalidGrantError('Invalid authorization code');
    return record;
  }

  async challengeForAuthorizationCode(client, code) {
    return this.getCode(client, code).codeChallenge;
  }

  async exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
    const record = this.getCode(client, code);
    this.validateResource(resource);
    if (redirectUri !== record.redirectUri) throw new InvalidGrantError('Callback does not match');
    this.codes.delete(hash(code));
    return this.issue(client.client_id);
  }

  issue(clientId, grantId = random()) {
    this.save();
    if (Object.keys(this.state.refresh).length >= 1000) throw new InvalidGrantError('Token limit reached');
    const access = random(), refresh = random();
    const common = { clientId, grantId, scopes: ['mail.read'], resource: this.resource };
    this.state.access[hash(access)] = { ...common, expiresAt: now() + 3600 };
    this.state.refresh[hash(refresh)] = { ...common, expiresAt: now() + 30 * 86400 };
    this.save();
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600, scope: 'mail.read' };
  }

  async exchangeRefreshToken(client, token, scopes, resource) {
    this.validateResource(resource);
    this.validateScopes(scopes);
    const id = hash(token);
    const reused = this.state.usedRefresh[id];
    if (reused?.clientId === client.client_id && reused.expiresAt > now()) {
      this.revokeGrant(reused.grantId);
      throw new InvalidGrantError('Refresh token reuse revoked the grant');
    }
    const record = this.state.refresh[id];
    if (!record || record.clientId !== client.client_id || record.expiresAt <= now()) throw new InvalidGrantError('Invalid refresh token');
    this.revokeGrant(record.grantId);
    this.state.usedRefresh[id] = record;
    return this.issue(client.client_id, record.grantId);
  }

  async verifyAccessToken(token) {
    const record = this.state.access[hash(token)];
    if (!record || record.expiresAt <= now()) throw new InvalidTokenError('Invalid or expired gateway token');
    return { token, ...record, resource: new URL(record.resource) };
  }

  revokeGrant(grantId) {
    for (const kind of ['access', 'refresh']) {
      for (const [id, record] of Object.entries(this.state[kind])) if (record.grantId === grantId) delete this.state[kind][id];
    }
    this.save();
  }

  async revokeToken(client, request) {
    const id = hash(request.token);
    const record = this.state.access[id] || this.state.refresh[id];
    if (record?.clientId === client.client_id) this.revokeGrant(record.grantId);
  }
}
