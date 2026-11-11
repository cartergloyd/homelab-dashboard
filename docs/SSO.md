# One login for the network (decided 2026-11-10)

**The rule:** a *network admin* gets into everything (dash, AppFlowy, CRM, the private part of xgold.tech). A *customer*
gets the private part of xgold.tech only. Everyone signs in with **Google**.

Why Google: it is the only sign-in that the CRM (Twenty: Google or Microsoft), AppFlowy (Google, GitHub or Discord),
Cloudflare Access and Directus all accept without a paid plan. One Google OAuth client serves all four.

## Who checks what

| Place | Door (who gets in) | Sign-in inside | State |
| --- | --- | --- | --- |
| `dash.xgold.tech` | Cloudflare Access app "Homelab dashboard": group **Admins**, Google | none (Access is the login) | door to change by hand (§ B) |
| `dash.xgold.tech/appflowy` | same door as the dash | AppFlowy's own login → Google (GoTrue) | to wire (§ C) |
| `crm.xgold.tech` | Cloudflare Access app "Twenty CRM": group **Admins**, Google | Twenty → Google (admins must be invited once) | to wire (§ C) |
| `xgold.tech` public pages | none, stays public | none | unchanged |
| `xgold.tech` private area | none at the edge | Directus (ai) → Google. First sign-in = **Pending** (sees nothing) | roles + approval built; Google to wire; the site's page is a separate repo (§ D) |

Roles live in the `ai` Directus: **Pending**, **Customer**, **Network admin** (`deploy/ai-members.sql`). The dash page
**Access → People** lists everyone who signed in and approves, promotes or suspends them. It never touches Directus
administrators or service accounts.

## Adding people

- **A customer:** they click Log in on xgold.tech and sign in with Google. They appear in Access → People as *Waiting
  for approval*. You press **Approve**. Nothing else to do; they never reach the dash, AppFlowy or the CRM.
- **An admin:** (1) add their e-mail to the Cloudflare Access group **Admins** (§ B), (2) press **Make admin** in
  People (for the website), (3) the first time they open the CRM, invite their e-mail in Twenty. AppFlowy creates
  their user on their first Google sign-in (sign-ups are open there because only admins pass the door).
- **Removing anyone:** **Suspend** in People; admins are also removed from the Access group.

## What only you can do

### A. Google (once, about 15 min)
1. https://console.cloud.google.com → new project "xgold login" → **APIs & Services → OAuth consent screen**: user type
   External, app name "xGold", support e-mail yours. Scopes: only `openid`, `email`, `profile`. Then **Publish app**
   (status "In production"), otherwise only listed test users can sign in. Basic scopes need no Google review.
2. **Credentials → Create credentials → OAuth client ID → Web application**. Authorized redirect URIs (exactly these):
   - `https://xgold-tech.cloudflareaccess.com/cdn-cgi/access/callback` (Cloudflare Access)
   - `https://ai-api.xgold.tech/auth/login/google/callback` (website, via Directus)
   - `https://crm.xgold.tech/auth/google/redirect` (CRM; confirmed when wired)
   - `https://dash.xgold.tech/appflowy/gotrue/callback` (AppFlowy)
3. Put the client ID and secret in a file **on the server**, never in chat or git:
   `~/server-platform/google-oauth.env` (mode 600) with two lines, `GOOGLE_CLIENT_ID=…` and `GOOGLE_CLIENT_SECRET=…`.

### B. Cloudflare (once, about 10 min)
Zero Trust → Settings → Authentication: **Add new → Google**, same client ID and secret.
Access → Access groups → **Admins**: Include → Emails → each admin. Then in the two applications "Homelab dashboard" and
"Twenty CRM": policy = Allow, Include → group **Admins**; login methods = Google only (remove GitHub and the one-time
PIN). Keep the old policy until the new one works. Test in a private window before removing it.

## What I wire after A (and B for testing)
Directus ai (`AUTH_GOOGLE_*`, default role Pending, redirect allow-list `https://xgold.tech`), Twenty (`AUTH_GOOGLE_*`),
AppFlowy (`GOTRUE_EXTERNAL_GOOGLE_*`, sign-ups open behind the admin door), `ALLOWED_LOGINS` in the dash env.

## Not covered (stay as they are)
`fam.xgold.tech` family directory and Jellyfin accounts, the Directus admin consoles (local login + MFA), the dash's
authenticator step-up code. They are separate on purpose.

## Known limits
- The admin list lives in Cloudflare (the group). The dash cannot edit it (no Cloudflare API token on purpose) and
  only warns in People when `ALLOWED_LOGINS` is set and an admin is missing from it.
- Customers need a Google account (any e-mail address can have one).
- The private page on xgold.tech itself (a Log in button, "waiting for approval", the items from `members_items`) is
  in the website repo `ai.xgold.tech`, not here.
