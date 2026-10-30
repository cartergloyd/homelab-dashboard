import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { appsFromEnv } from "./apps-config.js";
import type { AlertSource, LogSource, MediaRoot } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ALL_LOG_SOURCES: LogSource[] = ["minecraft", "jellyfin", "directus", "postgres", "dashboard", "system"];

// [INSTALLER] Every `.default(...)` below is a PLACEHOLDER guess for a typical
// install (container names, unit name, paths, ports). None of them is known to
// match the real server. Set the true values in /etc/homelab-dashboard.env
// (template: deploy/homelab-dashboard.env.example); the env always wins.
// Find every placeholder in the repo with:  grep -rn "\[INSTALLER\]" .

const flag = z
  .string()
  .optional()
  .transform((v) => v === "1" || v === "true");

const csv = z
  .string()
  .optional()
  .transform((v) =>
    v
      ? v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
  );

const Env = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("127.0.0.1"),
  // [DEMO] demo-mode branch — fake data for `npm run demo`; never taken on a real install (see DEMO_INDEX.md)
  DEMO: flag,
  AUTH_DISABLED: flag,
  ALLOWED_LOGINS: csv,
  // Dashboard published through the Cloudflare Tunnel behind Cloudflare Access (SERVER_SETUP § 7b).
  // Requests that arrive through Cloudflare must carry an Access token the dashboard verifies itself.
  CF_ACCESS_TEAM_DOMAIN: z.string().optional(), // xgold-tech.cloudflareaccess.com
  CF_ACCESS_AUD: z.string().optional(), // the Access application's Audience (AUD) tag
  PUBLIC_DASHBOARD_URL: z.string().optional(), // https://dash.xgold.tech
  DATA_DIR: z.string().default(path.resolve(process.cwd(), "data")),
  DOCKER_SOCKET: z.string().default("/var/run/docker.sock"),
  SYSTEMD_USER: flag,
  DISCORD_SUPPORT_ENABLED: flag,
  DISCORD_SUPPORT_TOKEN_FILE: z.string().optional(),
  DISCORD_SUPPORT_GUILD_ID: z.string().optional(),
  DISCORD_SUPPORT_BOT_ID: z.string().optional(),
  CODEX_MODEL: z.string().trim().min(1).optional(),

  JELLYFIN_URL: z.string().default("http://127.0.0.1:8096"),
  JELLYFIN_PUBLIC_URL: z.string().optional(),
  JELLYFIN_API_KEY: z.string().optional(),
  JELLYFIN_CONTAINER: z.string().default("jellyfin"),
  QBITTORRENT_PUBLIC_URL: z.string().optional(),
  QBITTORRENT_URL: z.string().url().optional(),
  QBITTORRENT_USERNAME: z.string().optional(),
  QBITTORRENT_PASSWORD: z.string().optional(),
  ROUTER_URL: z.preprocess(
    (value) => typeof value === "string" && !value.trim() ? undefined : value,
    z.string().trim().url().refine((value) => {
      try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
      } catch { return false; }
    }, "ROUTER_URL must use HTTP or HTTPS without embedded credentials").optional(),
  ),
  // "Movies=/srv/media/movies,Shows=/srv/media/shows"
  MEDIA_ROOTS: csv,

  MC_SERVICE: z.string().default("minecraft"),
  MC_DIR: z.string().default("/opt/minecraft"),
  MC_HOST: z.string().default("127.0.0.1"),
  MC_PORT: z.coerce.number().default(25565),
  // What players type into the multiplayer screen, e.g. "homeserver.tail1234.ts.net"
  MC_PUBLIC_ADDRESS: z.string().optional(),
  RCON_HOST: z.string().default("127.0.0.1"),
  RCON_PORT: z.coerce.number().default(25575),
  RCON_PASSWORD: z.string().optional(),
  // One or more backup roots (comma-separated). The first is where built-in backups are written.
  BACKUP_DIR: z.string().default("/var/backups/minecraft"),
  BACKUP_KEEP: z.coerce.number().default(7),
  // builtin | script:<name>  — what "Back up now" and backup jobs run
  BACKUP_METHOD: z.string().default("builtin"),
  // archive = mc-YYYYMMDD-HHMMSS.tar.gz · dated-folder = mcworld_YYYY_MM_DD/<world>.tar.gz
  BACKUP_FORMAT: z.enum(["archive", "dated-folder"]).default("archive"),

  DIRECTUS_URL: z.string().default("http://127.0.0.1:8055"),
  DIRECTUS_PUBLIC_URL: z.string().optional(),
  DIRECTUS_CONTAINER: z.string().default("homelab-directus"),
  POSTGRES_CONTAINER: z.string().default("homelab-postgres"),
  // postgres://user:pass@127.0.0.1:5432/personal
  PG_URL: z.string().optional(),
  // Directus-per-app platform (SERVER_SETUP § 5): app names; each has its own Postgres database,
  // role and Directus, published as https://<name>-api.<PUBLIC_DOMAIN> by the Cloudflare Tunnel
  // (https://<name>.<PUBLIC_DOMAIN> is the app's front-end).
  // Per app: APP_<NAME>_URL (loopback Directus, default 8056, 8057 …), APP_<NAME>_PUBLIC_URL,
  // APP_<NAME>_CONTAINER (homelab-directus-<name>), APP_<NAME>_DB (<name>). See server/src/apps-config.ts.
  APPS: csv,
  PUBLIC_DOMAIN: z.string().optional(),
  // Domain & hostnames card (Dashboard). Preferred source: a READ-ONLY Cloudflare API token
  // (Zone.Zone:Read + Zone.DNS:Read, this zone only) so new records show up by themselves;
  // fallback: the zone file (default deploy/dns/<PUBLIC_DOMAIN>.zone). HOSTNAMES_EXTRA lists
  // planned names ("crm,shop") so they appear as "no record yet".
  CLOUDFLARE_API_TOKEN: z.string().optional(),
  DNS_ZONE_FILE: z.string().optional(),
  HOSTNAMES_EXTRA: csv,
  PG_BACKUP_DIR: z.string().default("/var/backups/postgres"),
  CLOUDFLARED_CONTAINER: z.string().default("homelab-cloudflared"),
  CLOUDFLARED_METRICS_URL: z.string().default("http://127.0.0.1:2000"),

  DASHBOARD_SERVICE: z.string().default("homelab-dashboard"),
  TZ: z.string().optional(),

  // Locally generated password for scripts and the MCP connector (NOT an AI API key)
  DASHBOARD_KEY: z.string().optional(),
  // Folder(s) of maintenance scripts (*.py, *.sh), comma-separated, shown as ▶ buttons and runnable as jobs
  SCRIPTS_DIR: z.string().default("/opt/homelab-scripts"),
  // The instructions file agents read; edited from the Assistant widget
  CONTEXT_FILE: z.string().optional(),
  // Which log sources the alerts hub tails continuously (default: all)
  ALERT_SOURCES: csv,

  // --- VPN tab -----------------------------------------------------------
  // [INSTALLER] The VPN software on the server is UNKNOWN. These are hooks for
  // whatever is actually installed; leave VPN_PROVIDER=auto to let the dashboard
  // probe for mullvad / nordvpn / protonvpn CLIs and WireGuard/tun interfaces.
  VPN_PROVIDER: z.enum(["auto", "mullvad", "nordvpn", "protonvpn", "wireguard", "openvpn", "none"]).default("auto"),
  VPN_INTERFACE: z.string().optional(), // e.g. wg0-mullvad, nordlynx, tun0
  VPN_LAN_INTERFACE: z.string().optional(), // e.g. eth0 — lets the dashboard show the home ISP IP for comparison
  VPN_GEO_URL: z.string().default("https://ipinfo.io"), // geolocation API; {url}/json and {url}/<ip>/json
  VPN_GEO_TOKEN: z.string().optional(),
  // Declared split-tunnel exceptions when detection can't see them: "Minecraft=25565/tcp,Jellyfin=8096/tcp"
  VPN_EXCEPTIONS: csv,

  // Storage explorer (issue #4): the TreeSize view is fed by ncdu (preferred) or gdu —
  // proven scanners with an ncdu-format JSON export — falling back to `du -a`.
  DISK_SCANNER: z.enum(["auto", "ncdu", "gdu", "du"]).default("auto"),
  // folders to scan (default: every mounted filesystem from df); each scan stays on one filesystem
  DISK_SCAN_ROOTS: csv,
  // re-scan automatically every N hours (0 = only when asked from the UI / MCP)
  DISK_SCAN_INTERVAL_HOURS: z.coerce.number().min(0).max(720).default(24),
  // extra exclude patterns handed to the scanner (ncdu --exclude / gdu --ignore-dirs-pattern / du --exclude)
  DISK_SCAN_EXCLUDE: csv,

  // Staged updates widget (Minecraft tab). [INSTALLER] PLACEHOLDER: where the update-fetch
  // job puts new Paper/plugin jars before the restart applies them. Unset = look in the
  // usual places (plugins/update, updates, staged, staging under MC_DIR).
  UPDATE_STAGING_DIR: z.string().optional(),
  // Where to look upstream for each plugin: "EssentialsX=modrinth:essentialsx,Chunky=hangar:pop4959/Chunky,Vault=github:MilkBowl/Vault,Foo=none"
  PLUGIN_SOURCES: csv,
  // query PaperMC / Modrinth / Hangar / GitHub for latest versions (default on; 0 to disable)
  UPDATE_CHECK: z
    .string()
    .optional()
    .transform((v) => v === undefined || v === "1" || v === "true"),
});

const env = Env.parse(process.env);

/** Comma-separated paths; each may contain spaces (quote the whole value in the env file). */
const splitPaths = (v: string): string[] =>
  v
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
    .map((p) => path.resolve(p));

function parseRoots(items: string[]): MediaRoot[] {
  return items.map((item) => {
    const i = item.indexOf("=");
    if (i === -1) return { name: path.basename(item), path: path.resolve(item) };
    return { name: item.slice(0, i).trim(), path: path.resolve(item.slice(i + 1).trim()) };
  });
}

export const cfg = {
  port: env.PORT,
  host: env.HOST,
  demo: env.DEMO,
  authDisabled: env.AUTH_DISABLED,
  allowedLogins: env.ALLOWED_LOGINS,
  cfAccess:
    env.CF_ACCESS_TEAM_DOMAIN?.trim() && env.CF_ACCESS_AUD?.trim()
      ? {
          teamDomain: env.CF_ACCESS_TEAM_DOMAIN.trim().replace(/^https?:\/\//, "").replace(/\/$/, ""),
          aud: env.CF_ACCESS_AUD.trim(),
          publicUrl: env.PUBLIC_DASHBOARD_URL?.trim().replace(/\/$/, "") || null,
        }
      : null,
  dataDir: env.DATA_DIR,
  dockerSocket: env.DOCKER_SOCKET,
  systemdUser: env.SYSTEMD_USER,
  discordSupport: {
    enabled: env.DISCORD_SUPPORT_ENABLED,
    tokenFile: env.DISCORD_SUPPORT_TOKEN_FILE ?? "",
    guildId: env.DISCORD_SUPPORT_GUILD_ID ?? "",
    botId: env.DISCORD_SUPPORT_BOT_ID ?? "",
  },
  codexModel: env.CODEX_MODEL ?? null,
  timezone: env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  routerUrl: env.ROUTER_URL ?? null,
  jellyfin: {
    url: env.JELLYFIN_URL.replace(/\/$/, ""),
    publicUrl: (env.JELLYFIN_PUBLIC_URL ?? env.JELLYFIN_URL).replace(/\/$/, ""),
    apiKey: env.JELLYFIN_API_KEY,
    container: env.JELLYFIN_CONTAINER,
  },
  qbittorrent: {
    publicUrl: env.QBITTORRENT_PUBLIC_URL?.replace(/\/$/, "") ?? null,
    url: env.QBITTORRENT_URL?.replace(/\/$/, "") ?? null,
    username: env.QBITTORRENT_USERNAME,
    password: env.QBITTORRENT_PASSWORD,
  },
  mediaRoots: parseRoots(env.MEDIA_ROOTS),
  minecraft: {
    service: env.MC_SERVICE,
    dir: env.MC_DIR,
    host: env.MC_HOST,
    port: env.MC_PORT,
    publicAddress: env.MC_PUBLIC_ADDRESS ?? null,
    rcon: { host: env.RCON_HOST, port: env.RCON_PORT, password: env.RCON_PASSWORD },
  },
  backups: {
    dirs: splitPaths(env.BACKUP_DIR),
    get dir(): string {
      return this.dirs[0];
    },
    keep: env.BACKUP_KEEP,
    method: env.BACKUP_METHOD,
    format: env.BACKUP_FORMAT,
  },
  directus: {
    url: env.DIRECTUS_URL.replace(/\/$/, ""),
    publicUrl: (env.DIRECTUS_PUBLIC_URL ?? env.DIRECTUS_URL).replace(/\/$/, ""),
    container: env.DIRECTUS_CONTAINER,
  },
  postgres: { url: env.PG_URL, container: env.POSTGRES_CONTAINER },
  apps: appsFromEnv(env.APPS, process.env, env.PUBLIC_DOMAIN?.trim() || null),
  publicDomain: env.PUBLIC_DOMAIN?.trim() || null,
  cloudflareApiToken: env.CLOUDFLARE_API_TOKEN?.trim() || null,
  dnsZoneFile: env.DNS_ZONE_FILE?.trim() || (env.PUBLIC_DOMAIN?.trim() ? path.resolve(here, "../../deploy/dns", `${env.PUBLIC_DOMAIN.trim()}.zone`) : null),
  hostnamesExtra: env.HOSTNAMES_EXTRA,
  pgBackupDir: path.resolve(env.PG_BACKUP_DIR),
  cloudflared: { container: env.CLOUDFLARED_CONTAINER, metricsUrl: env.CLOUDFLARED_METRICS_URL.replace(/\/$/, "") },
  dashboardService: env.DASHBOARD_SERVICE,
  dashboardKey: (env.DASHBOARD_KEY ?? null) as string | null,
  scriptsDirs: splitPaths(env.SCRIPTS_DIR),
  get scriptsDir(): string {
    return this.scriptsDirs[0];
  },
  // dist/config.js → server/dist → server → repo root (wherever the repo is installed)
  repoRoot: path.resolve(here, "../.."),
  contextFile: env.CONTEXT_FILE ?? path.resolve(here, "../../CLAUDE.md"),
  vpn: {
    provider: env.VPN_PROVIDER,
    iface: env.VPN_INTERFACE ?? null,
    lanIface: env.VPN_LAN_INTERFACE ?? null,
    geoUrl: env.VPN_GEO_URL.replace(/\/$/, ""),
    geoToken: env.VPN_GEO_TOKEN ?? null,
    declaredExceptions: env.VPN_EXCEPTIONS.map((item) => {
      const [name, port] = item.split("=");
      return { name: (name ?? "").trim(), port: (port ?? "").trim() };
    }).filter((e) => e.name && e.port),
  },
  alertSources: (env.ALERT_SOURCES.length
    ? env.ALERT_SOURCES.filter((s): s is LogSource => (ALL_LOG_SOURCES as string[]).includes(s))
    : ALL_LOG_SOURCES) as LogSource[],
  // which env vars were set explicitly, so demo mode only fills the gaps
  diskScan: {
    scanner: env.DISK_SCANNER,
    roots: splitPaths(env.DISK_SCAN_ROOTS.join(",")),
    intervalHours: env.DISK_SCAN_INTERVAL_HOURS,
    exclude: env.DISK_SCAN_EXCLUDE,
  },
  updates: {
    stagingDir: env.UPDATE_STAGING_DIR ? path.resolve(env.UPDATE_STAGING_DIR.replace(/^["']|["']$/g, "")) : null,
    sources: Object.fromEntries(
      env.PLUGIN_SOURCES.map((item) => {
        const i = item.indexOf("=");
        return i > 0 ? [item.slice(0, i).trim().toLowerCase(), item.slice(i + 1).trim()] : [item.trim().toLowerCase(), "none"];
      }),
    ) as Record<string, string>,
    check: env.UPDATE_CHECK,
  },
  explicit: {
    mediaRoots: env.MEDIA_ROOTS.length > 0,
    mcDir: process.env.MC_DIR !== undefined,
    backupDir: process.env.BACKUP_DIR !== undefined,
    scriptsDir: process.env.SCRIPTS_DIR !== undefined,
    contextFile: process.env.CONTEXT_FILE !== undefined,
  },
};

export const ALERT_SOURCE_IDS: AlertSource[] = [...ALL_LOG_SOURCES, "jobs", "scripts", "agent"];

export type Config = typeof cfg;
