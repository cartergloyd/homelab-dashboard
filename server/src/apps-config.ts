// Per-app configuration (fam, ai, crm, …). Pure so it can be unit-tested; config.ts calls it
// with process.env.
//
// Two kinds of app share the one PostgreSQL (one database + one login role each):
//   directus  (default) a Directus instance = the app's API + /admin, published as
//             https://<name>-api.<domain>; the app's SITE (its front-end, GitHub Pages today) is
//             https://<name>.<domain>. Single-level names on purpose: the free Universal SSL
//             covers *.<domain> only, so api.<name>.<domain> would need the paid certificate manager.
//   twenty    the self-hosted Twenty CRM: one web app at https://<name>.<domain> (no separate site),
//             health at /healthz, container homelab-twenty, loopback port 3020.
//
//   APPS=fam,ai,crm                                 the app names (also the Postgres database + role names)
//   PUBLIC_DOMAIN=xgold.tech                        the owner's domain, on Cloudflare DNS
//   APP_CRM_KIND=twenty                             directus (default) | twenty | umami
//   APP_FAM_URL=http://127.0.0.1:8056               where the dashboard reaches the app (default: 8056, 8057, … for
//                                                   directus apps in APPS order; 3020 for twenty)
//   APP_FAM_PUBLIC_URL=https://fam-api.xgold.tech   what users/apps open through the tunnel (default by kind)
//   APP_FAM_SITE_URL=https://fam.xgold.tech         directus only: the front-end (shown, never probed)
//   APP_FAM_CONTAINER=homelab-directus-fam          its container (default by kind)
//   APP_FAM_DB=fam                                  its database (default: the name)

export type AppKind = "directus" | "twenty" | "umami";

export interface AppConfig {
  name: string;
  kind: AppKind;
  /** dashboard → the app, loopback */
  url: string;
  /** users/apps → the app through the tunnel; null when neither APP_<NAME>_PUBLIC_URL nor PUBLIC_DOMAIN is set */
  publicUrl: string | null;
  /** directus: the app's front-end site (<name>.<domain>); null for kinds that are the site themselves */
  siteUrl: string | null;
  container: string;
  db: string;
  /** Private token for authenticated health checks (Directus 12+). Never returned by the API. */
  healthToken?: string;
  /** GET path that answers 200 when the app is healthy */
  healthPath: string;
}

export const APP_NAME_RE = /^[a-z][a-z0-9_-]{0,30}$/;
export const APP_KINDS: AppKind[] = ["directus", "twenty", "umami"];

export function envKey(name: string): string {
  return name.toUpperCase().replace(/-/g, "_");
}

const clean = (u: string | null): string | null => (u ? u.replace(/\/$/, "") : null);

export function appsFromEnv(names: string[], env: Record<string, string | undefined>, domain: string | null): AppConfig[] {
  const out: AppConfig[] = [];
  let directusIndex = 0;
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    if (!APP_NAME_RE.test(name)) throw new Error(`APPS: "${name}" is not a valid app name (lowercase letters, digits, - _)`);
    const k = envKey(name);
    const kindRaw = (env[`APP_${k}_KIND`]?.trim().toLowerCase() || "directus") as AppKind;
    if (!APP_KINDS.includes(kindRaw)) throw new Error(`APP_${k}_KIND: "${kindRaw}" is not one of ${APP_KINDS.join(", ")}`);
    const kind = kindRaw;
    const defaults =
      kind === "umami"
        ? { url: "http://127.0.0.1:3021", publicHost: domain ? `crm.${domain}/stats` : null, siteHost: null, container: "homelab-umami", healthPath: "/stats/api/heartbeat" }
        : kind === "twenty"
        ? { url: "http://127.0.0.1:3020", publicHost: domain ? `${name}.${domain}` : null, siteHost: null, container: "homelab-twenty", healthPath: "/healthz" }
        : { url: `http://127.0.0.1:${8056 + directusIndex++}`, publicHost: domain ? `${name}-api.${domain}` : null, siteHost: domain ? `${name}.${domain}` : null, container: `homelab-directus-${name}`, healthPath: "/server/health" };
    out.push({
      name,
      kind,
      url: (env[`APP_${k}_URL`]?.trim() || defaults.url).replace(/\/$/, ""),
      publicUrl: clean(env[`APP_${k}_PUBLIC_URL`]?.trim() || (defaults.publicHost ? `https://${defaults.publicHost}` : null)),
      siteUrl: clean(env[`APP_${k}_SITE_URL`]?.trim() || (defaults.siteHost ? `https://${defaults.siteHost}` : null)),
      container: env[`APP_${k}_CONTAINER`]?.trim() || defaults.container,
      db: env[`APP_${k}_DB`]?.trim() || name,
      ...(env[`APP_${k}_HEALTH_TOKEN`]?.trim() ? { healthToken: env[`APP_${k}_HEALTH_TOKEN`]!.trim() } : {}),
      healthPath: defaults.healthPath,
    });
  }
  return out;
}
