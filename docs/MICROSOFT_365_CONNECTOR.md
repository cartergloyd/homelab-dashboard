# Issue #6: personal Outlook in Claude web and iOS

Installation recovered from October 19, 2026; updated October 27, 2026
(America/Chicago). [Issue #6](https://github.com/cartergloyd/homelab-dashboard/issues/6).

## Current status

The public connector at **https://ms365.xgold.tech/mcp** now exposes all **190
personal-mode management tools**, with OAuth sign-in to the gateway. The owner approves access using the existing connector
key on the gateway's own page. The owner explicitly requested maximum supported read/write access and completed
fresh Microsoft consent on October 27. Microsoft remains signed in on Gold; there is no
Microsoft OAuth callback or Entra app-registration step in this flow.

The owner's screenshots revealed that **Request headers is unavailable in their
Claude account**. Anthropic documents this as a limited beta. The previous
No sign-in / X-Connector-Key instructions could not work with that interface.
Those instructions are superseded by the OAuth setup below. See [Anthropic's
request-header availability documentation](https://claude.com/docs/connectors/custom/add-unlisted#authenticate-with-request-headers).

Passed on October 27:

- Seven tests covering the existing proxy boundary and new OAuth flow.
- Public discovery, registration, owner approval, S256 PKCE code exchange,
  bearer-authenticated MCP handshake, 190 management tools, and a fresh mailbox
  read (one message ID selected without printing the ID or mailbox content).
- Smoke-check grant revocation; its token is rejected afterward.
- Existing private-header authentication and local mailbox checks still pass.
- Live Graph writes: created, edited, read back, and deleted a temporary disabled
  Outlook rule and a calendar appointment with no attendees. Both creations
  returned 201; both deletions returned 204. The rule was never enabled.
- All 13 requested Graph permissions were granted, including Mail.ReadWrite,
  Mail.Send, MailboxSettings.ReadWrite, Calendars.ReadWrite, Contacts.ReadWrite,
  Files.ReadWrite, Notes.ReadWrite, Tasks.ReadWrite, and User.ReadWrite.

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
explains that Claude can read, send, create, edit, move, share, and delete
supported data in the Microsoft account signed in on Gold.
Get the existing connector key locally:

```bash
cat /home/gold/server-platform/connectors/ms365/connector-key
```

Paste the key into that approval page and click **Allow Microsoft account management**.
The key is not a Microsoft password. It is submitted in the approval form body,
never in the URL, report, repository, or application logs. The page returns to
Claude, which exchanges a short-lived code plus PKCE proof for gateway tokens.

Old read-only gateway tokens and registrations were invalidated when access
expanded. Remove and re-add the connector if Claude retains its old registration.
The URL, Sign in now, Register automatically, and Streamable HTTP settings stay
the same. You may name it Microsoft 365 to reflect the expanded scope.

Enable the connector in a fresh Claude web/iOS chat and ask:

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

- `ms365-mcp.service`: Softeria 0.170.2 with the all preset in personal mode,
  read/write access (no read-only flag or narrow scope allowlist), consumers tenant, headless
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
  management access to the signed-in account. It is not a multi-user Microsoft sign-in.
- The gateway OAuth scope is `microsoft.manage`. Its policy fingerprint prevents
  old read-only sessions from gaining write access. The original X-Connector-Key
  route remains available for local checks and
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

The initial OAuth deployment changed the gateway service, backed up under
`/home/gold/server-platform/backup-private/ms365-oauth-20261027-171723`. The
management-access upgrade changed the upstream unit, launcher, consent page,
gateway scope, policy fingerprint, and checks. Both services were restarted after
Microsoft consent. Its backup is
`/home/gold/server-platform/backup-private/ms365-management-20261027-173103`.

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


## Capabilities and persistence

Enabled tools include mail sending/replying/forwarding/drafts, folders and
message changes, Outlook rules and mailbox settings, appointment creation and
editing, meeting responses, contacts, OneDrive file changes and sharing, Excel,
OneNote, To Do, profile updates, and `graph-batch` for supported Graph operations
beyond named tools. All tool-derived personal-mode scopes were granted. No
organization-mode scopes were requested. The upstream's server-filesystem and
Microsoft account-management tools remain outside the remote interface; they
are separate from managing Microsoft data.

Microsoft API and account limitations still apply: exposing a tool is not proof
that every service or endpoint supports a personal subscription. In particular,
organization services such as Teams and SharePoint require organization accounts,
and some individual endpoints have narrower support. Outlook inbox-rule writes
and appointment writes were verified against this account. See [Microsoft's rule
API](https://learn.microsoft.com/en-us/graph/api/mailfolder-post-messagerules?view=graph-rest-1.0)
and [calendar API](https://learn.microsoft.com/en-us/graph/api/user-post-events?view=graph-rest-1.0).

For persistent execution, the owner can use these Claude project instructions:

> Use my Microsoft 365 connector to carry out requested work through completion.
> Inspect tools and schemas, resolve real item IDs, and prefer direct API actions.
> If a named tool cannot accomplish the task, use graph-batch with a supported
> Graph endpoint and the permissions already granted. Recover from transient
> failures, follow pagination, and try other supported approaches when needed.
> Verify the resulting state and report what changed. Ask for missing details
> when they affect the intended result; do not invent recipients or appointments,
> or claim that an unsupported action succeeded.

Connector permissions provide capability; Claude's own tool-approval settings and
instructions still govern its behavior. Filter/search first, select needed
fields, and fetch bodies/attachments only when needed. No performance or cost
benchmark was run. Keep issue #6 open until an actual Claude web/iOS query succeeds.
