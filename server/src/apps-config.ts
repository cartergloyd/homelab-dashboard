// Directus-per-app configuration (fam, ai, …). Pure so it can be unit-tested; config.ts
// calls it with process.env.
//
// Hostname convention (decided 2026-10-20 from the owner's existing DNS): an app's SITE — its
// front-end, a GitHub Pages site today — is https://<name>.<domain>; the app's Directus (API +
// /admin), published by the Cloudflare Tunnel, is https://api.<name>.<domain>.
//
//   APPS=fam,ai                                    the app names (also the Postgres database + role names)
//   PUBLIC_DOMAIN=xgold.tech                       the owner's domain, on Cloudflare DNS
//   APP_FAM_URL=http://127.0.0.1:8056              where the dashboard reaches fam's Directus (default: 8056, 8057, … in APPS order)
//   APP_FAM_PUBLIC_URL=https://api.fam.xgold.tech  fam's Directus through the tunnel (default from PUBLIC_DOMAIN)
//   APP_FAM_SITE_URL=https://fam.xgold.tech        fam's front-end (default from PUBLIC_DOMAIN; shown, never probed)
//   APP_FAM_CONTAINER=homelab-directus-fam         its container (default)
//   APP_FAM_DB=fam                                 its database (default: the name)

export interface AppConfig {
  name: string;
  /** dashboard → Directus, loopback */
  url: string;
  /** users/apps → Directus through the tunnel (api.<name>.<domain>); null when neither APP_<NAME>_PUBLIC_URL nor PUBLIC_DOMAIN is set */
  publicUrl: string | null;
  /** the app's front-end site (<name>.<domain>); informational — the dashboard never probes it */
  siteUrl: string | null;
  container: string;
  db: string;
}

export const APP_NAME_RE = /^[a-z][a-z0-9_-]{0,30}$/;

export function envKey(name: string): string {
  return name.toUpperCase().replace(/-/g, "_");
}

const clean = (u: string | null): string | null => (u ? u.replace(/\/$/, "") : null);

export function appsFromEnv(names: string[], env: Record<string, string | undefined>, domain: string | null): AppConfig[] {
  const out: AppConfig[] = [];
  let i = 0;
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    if (!APP_NAME_RE.test(name)) throw new Error(`APPS: "${name}" is not a valid app name (lowercase letters, digits, - _)`);
    const k = envKey(name);
    out.push({
      name,
      url: (env[`APP_${k}_URL`]?.trim() || `http://127.0.0.1:${8056 + i}`).replace(/\/$/, ""),
      publicUrl: clean(env[`APP_${k}_PUBLIC_URL`]?.trim() || (domain ? `https://api.${name}.${domain}` : null)),
      siteUrl: clean(env[`APP_${k}_SITE_URL`]?.trim() || (domain ? `https://${name}.${domain}` : null)),
      container: env[`APP_${k}_CONTAINER`]?.trim() || `homelab-directus-${name}`,
      db: env[`APP_${k}_DB`]?.trim() || name,
    });
    i++;
  }
  return out;
}
