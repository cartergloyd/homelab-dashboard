# Issue #6: personal Outlook in Claude web and iOS

Installation recovered from October 19, 2026; updated October 27, 2026
(America/Chicago). [Issue #6](https://github.com/cartergloyd/homelab-dashboard/issues/6).

## Current status

The public connector at **https://ms365.xgold.tech/mcp** now supports OAuth
sign-in to the gateway. The owner approves access using the existing connector
key on the gateway's own page. Microsoft remains signed in on Gold; there is no
Microsoft OAuth callback or Entra app-registration step in this flow.

The owner's screenshots revealed that **Request headers is unavailable in their
Claude account**. Anthropic documents this as a limited beta. The previous
No sign-in / X-Connector-Key instructions could not work with that interface.
Those instructions are superseded by the OAuth setup below. See [Anthropic's
request-header availability documentation](https://claude.com/docs/connectors/custom/add-unlisted#authenticate-with-request-headers).

Passed on October 27:

- Seven tests covering the existing proxy boundary and new OAuth flow.
- Public discovery, registration, owner approval, S256 PKCE code exchange,
  bearer-authenticated MCP handshake, 18 read-only tools, and a fresh mailbox
  read (one message ID selected without printing the ID or mailbox content).
- Smoke-check grant revocation; its token is rejected afterward.
- Existing private-header authentication and local mailbox checks still pass.

**An actual Claude web/iOS query remains pending owner verification.** Protocol
checks do not prove that Claude has completed its own configuration.

## Configure Claude

Remove the old Outlook connector before adding the new configuration:

| Setting | Value |
| --- | --- |
| Name | Personal Outlook |
| URL | `https://ms365.xgold.tech/mcp` |
| Authentication | **Sign in now** |
| OAuth client, if offered | **Register automatically** |
| Transport | **Streamable HTTP** |

No OAuth client ID, client secret, or custom header is required. The gateway
supports dynamic client registration; it does not advertise Claude published
identity support.

During sign-in, the approval page must be on **https://ms365.xgold.tech**. It
explains that Claude will have read-only access to the mailbox signed in on Gold.
Get the existing connector key locally:

```bash
cat /home/gold/server-platform/connectors/ms365/connector-key
```

Paste the key into that approval page and click **Allow read-only access**.
The key is not a Microsoft password. It is submitted in the approval form body,
never in the URL, report, repository, or application logs. The page returns to
Claude, which exchanges a short-lived code plus PKCE proof for gateway tokens.

Enable Personal Outlook in a fresh Claude web/iOS chat and ask:

> Use Personal Outlook to list my three newest emails with sender, subject and date.

If Claude offers only its published identity, switch to Register automatically.
If sign-in fails, record the exact error and check gateway logs without sharing
the key, authorization codes, or tokens.

## Server implementation

Source and locked dependencies: [`deploy/ms365`](../deploy/ms365/README.md).
Installed at `/home/gold/server-platform/connectors/ms365`.

```text
Claude → HTTPS ms365.xgold.tech → Cloudflare Tunnel (host network)
       → 127.0.0.1:3001 OAuth/key gateway
       → 127.0.0.1:3002 Softeria Microsoft MCP server
       → Microsoft Graph using the owner's cached sign-in
```

- `ms365-mcp.service`: Softeria 0.170.2 with mail preset, read-only mode, explicit
  `User.Read Mail.Read MailboxSettings.Read` scopes, consumers tenant, headless
  cache, and trust-proxy authentication. Microsoft auth and local file tools are
  absent from the remote tool list. This upstream must stay private.
- `ms365-gateway.service`: MCP SDK OAuth router, Claude callback allowlist,
  owner approval, exact-origin check, rate limits, S256 PKCE, one-use codes,
  resource/client-bound opaque tokens, refresh rotation and reuse detection,
  expiry, and grant revocation. Credentials are stripped before upstream calls.
- Access tokens last one hour; refresh tokens last 30 days and rotate on use.
  Codes last two minutes and approval transactions last ten minutes.
- `oauth-state.json` persists registrations and hashed gateway tokens at mode
  0600. Authorization codes and pending approvals stay in memory and expire on
  restart. Rotating the owner key invalidates existing gateway tokens on restart.
- This is a single-owner connector. Anyone approved with the owner key receives
  read access to the cached mailbox. It is not a multi-user Microsoft sign-in.
- The original X-Connector-Key route remains available for local checks and
  clients that can supply headers; Claude does not need that feature now.

The existing tunnel route is `ms365.xgold.tech`, blank path, HTTP service
`127.0.0.1:3001`. The owner created its DNS record. No browser-interactive Access
policy fronts the route; gateway authentication protects every mailbox request.

Gold retained a negative DNS answer after the route was created. Google and
Cloudflare DNS-over-HTTPS resolved the hostname. Public checks used a
process-local DNS override to that published Cloudflare address with hostname,
TLS SNI, and certificate verification preserved; no persistent DNS changes were
made. The old direct-IP endpoint timed out from Gold.

## Verify and operate

```bash
cd /home/gold/server-platform/connectors/ms365
node gateway.test.mjs
node check-gateway.mjs
node check-oauth.mjs
systemctl --user status ms365-mcp.service ms365-gateway.service
journalctl --user -u ms365-gateway.service -n 30 --no-pager
```

Run all seven source tests from `deploy/ms365` with
`node --test gateway.test.mjs oauth-gateway.test.mjs`. `check-oauth.mjs` uses only
the fixed trusted public hostname, performs an automated owner approval and
mailbox check, then revokes its own grant. It is a protocol validator, not proof
of a successful Claude UI query. The older `check-http.py` validates the
superseded Microsoft OAuth proxy and must not be used for this gateway.

For an actually expired Microsoft login, run `./ms365 --login`, complete device
consent, and restart both services. This is separate from Claude gateway sign-in.
Microsoft caches live under `~/.config/ms-365-mcp-server`; keep them out of Git.

To revoke gateway sessions, stop the gateway, remove its private
`oauth-state.json`, and restart it. To rotate the owner key, replace the private
key file (retain mode 0600) and restart the gateway; the changed key fingerprint
invalidates saved gateway tokens. Disconnecting Claude alone does not revoke
Microsoft's cached session. Use `./ms365 --logout` to end that session.

Only the gateway service was changed and restarted for the OAuth deployment.
Its previous unit and dependency manifests were backed up under
`/home/gold/server-platform/backup-private/ms365-oauth-20261027-171723`.

## Why previous attempts failed

| Attempt | Evidence from October 19 conversations | Consequence |
| --- | --- | --- |
| Local Claude Code registration | Owner wanted Claude website and iOS | Local stdio registration did not configure the cloud connector |
| First Microsoft device sign-in | Browser consent completed but server had no token | Fresh headless login later succeeded |
| Direct HTTPS | Cellular Safari timed out; router returned host-unreachable | Re-adding the HTTPS port assignment temporarily restored access |
| OAuth with default Microsoft app | Microsoft rejected the redirect URL | Softeria's default app did not accept Claude's callback |
| Custom Entra app | Account was rejected by the Microsoft Services tenant | Owner could not create the proposed app in that portal |
| Private-key gateway | Gateway logged `key_missing`; Claude could not start sign-in | Required header was absent; local success did not establish Claude success |
| Tunnel follow-up | Conversation stopped awaiting `ms365.xgold.tech` route | Owner created the route on October 27; public MCP and mailbox checks now pass |

Mailbox authentication, the tunnel route, and the new OAuth flow work. Verify an
actual Claude web/iOS query before closing issue #6.


## Efficient parsing and related connectors

Filter/search first, select needed fields, use modest page sizes, and retrieve
bodies or attachments only for relevant messages. Follow pagination links. No
performance or cost benchmark was run. See [Microsoft's messages API](https://learn.microsoft.com/graph/api/user-list-messages).

| Connection | Useful task | Additional setup |
| --- | --- | --- |
| Outlook Calendar | Relate messages to appointments | Calendar preset and consent |
| OneDrive / Excel | Find files and analyze sheets | Files/excel presets and consent |
| Contacts | Resolve senders and people | Contacts preset and consent |
| Microsoft To Do | Track follow-up work | Tasks preset; writes require configuration |
| GitHub | Bring issues and PRs into technical work | Separate Claude connector |
| Google Drive | Find related documents | Separate Claude connector |

These are suggestions, not enabled integrations. Personal-account capabilities
vary; organization services such as Teams and SharePoint need separate review.
Keep issue #6 open until an actual Claude web/iOS query succeeds.
