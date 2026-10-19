// Directus-per-app configuration (fam, ai, …). Pure so it can be unit-tested; config.ts
// calls it with process.env.
//
//   APPS=fam,ai                                  the app names (also the Postgres database + role names)
//   PUBLIC_DOMAIN=xgold.tech                     apps are https://<name>.<domain> unless APP_<NAME>_PUBLIC_URL says otherwise
//   APP_FAM_URL=http://127.0.0.1:8056            where the dashboard reaches fam's Directus (default: 8056, 8057, … in APPS order)
//   APP_FAM_PUBLIC_URL=https://fam.xgold.tech    what users open (default from PUBLIC_DOMAIN)
//   APP_FAM_CONTAINER=homelab-directus-fam       its container (default)
//   APP_FAM_DB=fam                               its database (default: the name)

export interface AppConfig {
  name: string;
  /** dashboard → Directus, loopback */
  url: string;
  /** users → Directus, through the tunnel; null when neither APP_<NAME>_PUBLIC_URL nor PUBLIC_DOMAIN is set */
  publicUrl: string | null;
  container: string;
  db: string;
}

export const APP_NAME_RE = /^[a-z][a-z0-9_-]{0,30}$/;

export function envKey(name: string): string {
  return name.toUpperCase().replace(/-/g, "_");
}

export function appsFromEnv(names: string[], env: Record<string, string | undefined>, domain: string | null): AppConfig[] {
  const out: AppConfig[] = [];
  let i = 0;
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    if (!APP_NAME_RE.test(name)) throw new Error(`APPS: "${name}" is not a valid app name (lowercase letters, digits, - _)`);
    const k = envKey(name);
    const pub = env[`APP_${k}_PUBLIC_URL`]?.trim() || (domain ? `https://${name}.${domain}` : null);
    out.push({
      name,
      url: (env[`APP_${k}_URL`]?.trim() || `http://127.0.0.1:${8056 + i}`).replace(/\/$/, ""),
      publicUrl: pub ? pub.replace(/\/$/, "") : null,
      container: env[`APP_${k}_CONTAINER`]?.trim() || `homelab-directus-${name}`,
      db: env[`APP_${k}_DB`]?.trim() || name,
    });
    i++;
  }
  return out;
}
