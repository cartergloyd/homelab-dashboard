# Umami monitoring

Append `umami` to APPS and set APP_UMAMI_KIND=umami. Defaults are loopback port
3021, container homelab-umami, database umami, public URL https://crm.<domain>/stats,
and health path /stats/api/heartbeat. PUBLIC_DOMAIN or an explicit public URL is
required for public probing. Umami does not consume a Directus port.

The app card shows website and user counts, local health, Cloudflare Access status
and the existing verified encrypted backup receipt. Open analytics links directly
to /stats. A public login wall plus a successful local heartbeat is expected;
monitoring does not require an Access bypass for the heartbeat. The two public
tracker paths remain a separate Cloudflare configuration concern.

Validated with builds/tests for both the isolated review branch and installed tree,
plus live fam/ai/crm/umami checks. All four app cards report healthy and backed up.
