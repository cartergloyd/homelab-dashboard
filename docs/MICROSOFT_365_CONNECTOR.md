# Issue #6: personal Outlook in Claude on iOS

Installation report, October 19, 2026. [Issue #6](https://github.com/cartergloyd/homelab-dashboard/issues/6).

## Current configuration

The connector is installed and an authenticated mailbox read has passed. The
remaining step is entering its private header key into the owner's Claude
connector settings and verifying a query in the iOS app.

The working route uses **Microsoft device sign-in on Gold**, then a **private
connector key sent by Claude**. The owner does not need access to the Microsoft
Entra app-registration portal for this route. Softeria's default application
rejected Claude's OAuth callback; the owner's personal account also could not
access the Entra portal's Microsoft Services tenant. Those OAuth setup
instructions are superseded by the header-key configuration below.

## Configure Claude

In Claude's custom connector settings, use:

| Setting | Value |
| --- | --- |
| Name | Personal Outlook |
| URL | `https://api.fam.xgold.tech/ms365/mcp` |
| Authentication | **No sign in** |
| Request header name | `X-Connector-Key` |
| Request header value | Contents of the private key file on Gold |

Display the key locally on Gold, then paste its output into Claude's header
value:

```bash
cat /home/gold/server-platform/connectors/ms365/connector-key
```

The key is a credential; it is not included in this report or Git. Claude's
**No sign in** setting skips OAuth: the request header authenticates every MCP
request to the server. No OAuth client ID or client secret is needed in Claude.
See [Claude's request-header configuration](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

Save the connector, enable it in a new chat in the Claude iOS app, and ask:

> Use Personal Outlook to list my three newest emails with sender, subject and date.

## Server installation

`@softeria/ms-365-mcp-server` is pinned to **0.170.2** in the independent
`/home/gold/server-platform/connectors/ms365` installation, with a lockfile.

```text
Claude cloud → HTTPS nginx /ms365/mcp
             → 127.0.0.1:3001 private-key gateway
             → 127.0.0.1:3002 Microsoft MCP server
             → Microsoft Graph using the owner's cached sign-in
```

- `ms365-mcp.service` runs the upstream with `--preset mail --read-only`, an
  explicit `User.Read Mail.Read MailboxSettings.Read` scope allowlist, and the
  documented `--trust-proxy-auth` mode. Its HTTP auth tools and local file tools
  are disabled. Dynamic OAuth client registration is disabled.
- `ms365-gateway.service` authenticates `X-Connector-Key` using constant-time
  comparison, forwards only `/mcp`, and strips credentials before forwarding.
  OAuth endpoints return 404. It limits request bodies to 1 MiB and upstream
  requests to 30 seconds. Neither service listens on a public interface.
- nginx provides the existing HTTPS endpoint and forwards to the gateway. The
  gateway checks the private key before allowing access to the shared cached
  Microsoft identity. Key holders have read-only access to that mailbox.
- The key file has mode 0600. Microsoft authentication uses the `consumers`
  authority and the headless encrypted file cache (`MS365_MCP_USE_KEYTAR=0`),
  with an expected Microsoft username configured. The earlier default
  credential-store login did not complete; a fresh headless login succeeded.
- Claude Code on Gold also has a user-scoped `ms365` stdio registration. That is
  separate from the remote connector used by iOS.

The upstream documents [trust-proxy authentication](https://github.com/Softeria/ms-365-mcp-server#cli-options)
for an authenticated reverse proxy. The gateway provides that authentication;
this mode must not be exposed directly without it.

## Verification

Passed:

- Gateway tests: missing/wrong credentials rejected, OAuth routes closed,
  request content preserved, credentials stripped, oversized requests blocked.
- Remote MCP handshake and tool listing: **18 read-only tools**; email mutation,
  local file writing and account-management tools absent.
- Authenticated Graph query selecting one message ID: successful, without
  printing its ID or email content.
- Active HTTPS virtual host: missing/wrong keys return 401; correct key permits
  MCP initialization; OAuth routes return 404.
- The owner confirmed public reachability from Safari on cellular data before
  the authentication change. nginx routing and the public URL remain the same.

Re-run local checks:

```bash
node /home/gold/server-platform/connectors/ms365/gateway.test.mjs
node /home/gold/server-platform/connectors/ms365/check-gateway.mjs
```

To check the full public route (server-to-own-public-IP connections can be slow):

```bash
node /home/gold/server-platform/connectors/ms365/check-gateway.mjs https://api.fam.xgold.tech/ms365/mcp
```

The older `check-http.py` checks the superseded OAuth mode and is not the correct
validator for the current header-key mode.

## Operations

```bash
systemctl --user status ms365-mcp.service ms365-gateway.service
systemctl --user restart ms365-mcp.service ms365-gateway.service
/home/gold/server-platform/connectors/ms365/ms365 --verify-login
```

If Microsoft consent expires or is revoked, obtain a fresh device code:

```bash
/home/gold/server-platform/connectors/ms365/ms365 --login
systemctl --user restart ms365-mcp.service ms365-gateway.service
```

To rotate the connector key, replace `connector-key` with a new random secret,
retain mode 0600, restart `ms365-gateway.service`, and update Claude's request
header. To disconnect remote access, stop and disable `ms365-gateway.service`.
Use the local `ms365 --logout` command to revoke the server's cached session.

Microsoft's cache is under `~/.config/ms-365-mcp-server`; logs are under
`~/.ms-365-mcp-server/logs`. Keep caches, keys and credentials out of Git.

## Network repair

The existing dashboard was already installed and healthy at port 8088, in
real-server mode. Existing dashboard code changes were preserved.

HTTPS originally failed from cellular data and the server's public-IP probe.
The router returned ICMP host-unreachable, while Minecraft TCP 25565 connected.
Both Linux firewall implementations had ACCEPT policies. Router screenshots
confirmed the correct TCP 443 service, host port 443, server IP and MAC, with the
visible packet-filter rules disabled. Removing and re-adding only the HTTPS
Hosted Applications assignment restored public access. Minecraft settings were
preserved. nginx's activation backup is:
`/var/backups/ms365-nginx-20261019-150424-779866`.

## Efficient parsing and other connections

Filter or search the mailbox first, select only needed fields, use modest page
sizes, and fetch bodies or attachments only for relevant results. Follow returned
pagination links. No performance or cost benchmark was run. See [Microsoft's
messages API](https://learn.microsoft.com/graph/api/user-list-messages).

| Connection | Useful task | Additional setup |
| --- | --- | --- |
| Outlook Calendar | Relate messages to appointments | Softeria calendar preset and new consent |
| OneDrive / Excel | Find files and analyze spreadsheets | Files/excel presets and additional scopes |
| Contacts | Resolve people mentioned in email | Contacts preset and additional consent |
| Microsoft To Do | Track follow-up work | Tasks preset; writes need explicit configuration |
| GitHub | Bring issues and pull requests into technical work | Separate Claude connector |
| Google Drive | Find related documents outside Microsoft | Separate Claude connector |

These are suggestions, not enabled integrations. Personal-account support varies
by service; Teams and SharePoint require organization capabilities. Inspect
`--list-presets` and `--list-permissions` before broadening access. Use [Claude's
connector guidance](https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors)
to choose a local or remote route.

Keep issue #6 open until the owner verifies the header-key connector in Claude iOS.
