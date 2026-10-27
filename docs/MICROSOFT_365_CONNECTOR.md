# Issue #6: personal Outlook in Claude on iOS

Installation report, October 19, 2026. Rechecked October 27, 2026 (America/Chicago). [Issue #6](https://github.com/cartergloyd/homelab-dashboard/issues/6).

## Current configuration

The connector is installed. On October 27, all three gateway tests, the local
MCP handshake, and a fresh authenticated mailbox read passed (18 read-only tools).
**Web/mobile access is still incomplete.** The old public endpoint timed out from
Gold, and the proposed replacement `ms365.xgold.tech` has no DNS record. A timeout
from Gold alone does not establish reachability from every outside network.

The October 19 conversation continued beyond the original installation report:
Claude reached the gateway but omitted `X-Connector-Key`, receiving 401. The owner
reported “Couldn't start sign in.” A later conversation proposed a Cloudflare
Tunnel route and stopped awaiting its creation. Neither a working tunnel endpoint
nor a successful Claude web/iOS query is verified.

The source, pinned dependency lockfile, service units, and checks are now in
[`deploy/ms365`](../deploy/ms365/README.md). Previously they lived only in the
installation directory outside the repository.

The working route uses **Microsoft device sign-in on Gold**, then a **private
connector key sent by Claude**. The owner does not need access to the Microsoft
Entra app-registration portal for this route. Softeria's default application
rejected Claude's OAuth callback; the owner's personal account also could not
access the Entra portal's Microsoft Services tenant. Those OAuth setup
instructions are superseded by the header-key configuration below.

## Restore public access first

In the existing Cloudflare Tunnel, add a published application route:

| Setting | Value |
| --- | --- |
| Hostname | `ms365.xgold.tech` |
| Path | Leave blank |
| Service type | `HTTP` |
| Service URL | `127.0.0.1:3001` |

The current `homelab-cloudflared` container uses host networking, so its loopback
can reach the gateway. Route to port **3001**, where the key is checked. Port 3002
trusts its proxy and must remain private. Do not add a browser-interactive Access
login to this endpoint; the private key protects every mailbox request. Existing
dashboard Access policies are separate. See [Cloudflare published application
routes](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/).

After creating the route, verify it:

```bash
node /home/gold/server-platform/connectors/ms365/check-gateway.mjs https://ms365.xgold.tech/mcp
```

Success must include rejected missing/wrong keys, an MCP handshake, 18 read-only
tools, and a mailbox read. Until then this hostname is a proposed replacement.

## Configure Claude

In Claude's custom connector settings, use:

| Setting | Value |
| --- | --- |
| Name | Personal Outlook |
| URL | `https://ms365.xgold.tech/mcp` **after the public check passes** |
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

Remove the old OAuth connector before adding this configuration. In Claude web,
open **Customize → Connectors → Add custom connector**, choose **No sign in**,
and configure **Request headers**. If that field is absent, inspect the actual
setup form before assuming the key has been configured.

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

October 19 installation checks (historical, not proof of current public access):

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

## Why previous attempts failed

| Attempt | Evidence from October 19 conversations | Consequence |
| --- | --- | --- |
| Local Claude Code registration | Owner wanted Claude website and iOS | Local stdio registration did not configure the cloud connector |
| First Microsoft device sign-in | Browser consent completed but server had no token | Fresh headless login later succeeded |
| Direct HTTPS | Cellular Safari timed out; router returned host-unreachable | Re-adding the HTTPS port assignment temporarily restored access |
| OAuth with default Microsoft app | Microsoft rejected the redirect URL | Softeria's default app did not accept Claude's callback |
| Custom Entra app | Account was rejected by the Microsoft Services tenant | Owner could not create the proposed app in that portal |
| Private-key gateway | Gateway logged `key_missing`; Claude could not start sign-in | Required header was absent; local success did not establish Claude success |
| Tunnel follow-up | Conversation stopped awaiting `ms365.xgold.tech` route | No DNS record exists on October 27; route remains unverified |

Current mailbox authentication works. Finish public routing and Claude's header
setup, then verify an actual query before closing issue #6.

## Historical network repair

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
