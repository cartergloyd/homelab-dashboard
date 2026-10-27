# Personal Outlook connector for Claude web and mobile

Recovered from the October 19 installation. This directory versions the existing
OAuth and private-key gateway; it does not deploy changes to the running installation.
See [the investigation and connection report](../../docs/MICROSOFT_365_CONNECTOR.md)
for the verified public route and remaining Claude setup steps.

The installed path on Gold is `/home/gold/server-platform/connectors/ms365`.
The two user services run the Microsoft server on loopback port 3002 and the
key-checking gateway on loopback port 3001. Publish only the gateway. The
Microsoft server uses `--trust-proxy-auth` and a shared cached mailbox identity.
All key holders can read that mailbox. This is a single-owner connector.

## Verify the recovered source

With Node.js 20 or later:

```bash
cd deploy/ms365
npm ci
node --test gateway.test.mjs oauth-gateway.test.mjs
```

The tests use ephemeral local ports and a fake upstream. They do not read mail.
The OAuth tests cover owner approval, callback/client/resource binding, PKCE,
one-use codes, token expiry, refresh rotation/reuse detection, revocation, and
private persistent state.
The live checker reads the adjacent private `connector-key` file, initializes
MCP, checks tool restrictions, and fetches one message ID without printing it:

```bash
node /home/gold/server-platform/connectors/ms365/check-gateway.mjs
```

Use only a trusted endpoint when supplying a URL argument: the checker sends the
mailbox-access key to that URL. The Cloudflare route has been verified; repeat the check with:

```bash
node /home/gold/server-platform/connectors/ms365/check-gateway.mjs https://ms365.xgold.tech/mcp
```

## Recover an installation on Gold

The current installation is healthy locally; do not replace its key, environment
or Microsoft cache to fix a Claude configuration or routing problem.

For recovery, copy `package.json`, `package-lock.json`, `gateway.mjs`,
`gateway.test.mjs`, `check-gateway.mjs`, `oauth-provider.mjs`,
`oauth-gateway.mjs`, `oauth-gateway.test.mjs`, `check-oauth.mjs`, and `ms365` to the installed path and run
`npm ci` there. Make `ms365` executable. Copy `remote.env.example` to `remote.env`
and replace the account placeholder. Keep both `remote.env` and `connector-key`
owner-readable only (mode 0600). Restore the existing key where possible. For a
new installation, generate at least 48 random characters and configure the same
key in Claude's `X-Connector-Key` request header.

The service units and launcher use Gold's existing paths and Node binary. For a
different host, update those paths before installing the units. They are user
units, installed under `~/.config/systemd/user/`.

When a new Microsoft login is actually needed, run in the installation folder:

```bash
set -a
. ./remote.env
set +a
./ms365 --login
```

Complete the displayed Microsoft device sign-in and consent before starting the
services. The `consumers` tenant supports the personal account; disabling keytar
selects the headless cache. `MS365_MCP_EXPECTED_USERNAME` pins the local sign-in.
The HTTP server shares the cached account behind the authenticated gateway.

After installing the units:

```bash
systemctl --user daemon-reload
systemctl --user enable --now ms365-mcp.service ms365-gateway.service
```

Never commit `connector-key`, `remote.env`, or Microsoft token caches. This
directory ignores those files and `oauth-state.json`; the upstream stores its
Microsoft caches outside it.

## Claude accounts without request headers

Use **Sign in now** and **Register automatically** with the same public MCP URL.
The gateway presents its own approval form, where the owner enters the existing
connector key and approves Microsoft account management. The upstream runs the
all preset in personal mode with write operations enabled. Changes from the
earlier read-only policy invalidate old gateway sessions and registrations. This does not require a Microsoft app registration. See the report
for the complete owner flow and gateway-token revocation instructions.

`oauth-state.json` contains registered client credentials and hashed gateway
tokens; keep it mode 0600 and outside version control. It is written atomically.
Pending approvals and authorization codes are memory-only; a gateway restart
requires beginning any unfinished approval again. Issued tokens survive restart.

After deployment, run `node check-oauth.mjs` from the installation directory to
exercise the fixed public URL and revoke the test grant afterward. This makes an
authenticated mailbox read without printing mailbox content. Never share the
private key, codes, tokens, or state file.

The current configuration exposes 190 management tools. `check-gateway.mjs` and
`check-oauth.mjs` require rule/calendar write tools and graph-batch to be present,
then perform a mailbox read. They do not create account data. The live rule and
calendar CRUD verification described in the report was run separately, with all
temporary items removed. All 13 tool-derived Graph scopes were consented by the
owner. API/account support still determines which individual actions succeed.

## Browser form regression

The protocol tests manually construct HTTP headers. A separate Chromium test
checks the actual native form submission and a redirect to a second local origin,
including browser-generated Origin/Referer and CSP enforcement. It uses only
synthetic credentials and local servers.

```bash
npx playwright install chromium
node --test gateway.test.mjs oauth-gateway.test.mjs oauth-browser.test.mjs
```

The approval page uses `strict-origin` to preserve a same-origin form's Origin
header without leaking authorization query parameters. Its CSP allows form
submission to self and the exact registered Claude callback. The server continues
to reject missing, null, or foreign approval origins.
