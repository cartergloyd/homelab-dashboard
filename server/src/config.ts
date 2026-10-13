import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AlertSource, LogSource, MediaRoot } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ALL_LOG_SOURCES: LogSource[] = ["minecraft", "jellyfin", "directus", "postgres", "dashboard", "system"];

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
  DEMO: flag,
  AUTH_DISABLED: flag,
  ALLOWED_LOGINS: csv,
  DATA_DIR: z.string().default(path.resolve(process.cwd(), "data")),
  DOCKER_SOCKET: z.string().default("/var/run/docker.sock"),

  JELLYFIN_URL: z.string().default("http://127.0.0.1:8096"),
  JELLYFIN_PUBLIC_URL: z.string().optional(),
  JELLYFIN_API_KEY: z.string().optional(),
  JELLYFIN_CONTAINER: z.string().default("jellyfin"),
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
  BACKUP_DIR: z.string().default("/var/backups/minecraft"),
  BACKUP_KEEP: z.coerce.number().default(7),

  DIRECTUS_URL: z.string().default("http://127.0.0.1:8055"),
  DIRECTUS_PUBLIC_URL: z.string().optional(),
  DIRECTUS_CONTAINER: z.string().default("homelab-directus"),
  POSTGRES_CONTAINER: z.string().default("homelab-postgres"),
  // postgres://user:pass@127.0.0.1:5432/personal
  PG_URL: z.string().optional(),

  DASHBOARD_SERVICE: z.string().default("homelab-dashboard"),
  TZ: z.string().optional(),

  // Locally generated password for scripts and the MCP connector (NOT an AI API key)
  DASHBOARD_KEY: z.string().optional(),
  // Folder of maintenance scripts (*.py, *.sh) shown as ▶ buttons and runnable as jobs
  SCRIPTS_DIR: z.string().default("/opt/homelab-scripts"),
  // The instructions file agents read; edited from the Assistant widget
  CONTEXT_FILE: z.string().optional(),
  // Which log sources the alerts hub tails continuously (default: all)
  ALERT_SOURCES: csv,
});

const env = Env.parse(process.env);

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
  dataDir: env.DATA_DIR,
  dockerSocket: env.DOCKER_SOCKET,
  timezone: env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  jellyfin: {
    url: env.JELLYFIN_URL.replace(/\/$/, ""),
    publicUrl: (env.JELLYFIN_PUBLIC_URL ?? env.JELLYFIN_URL).replace(/\/$/, ""),
    apiKey: env.JELLYFIN_API_KEY,
    container: env.JELLYFIN_CONTAINER,
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
  backups: { dir: env.BACKUP_DIR, keep: env.BACKUP_KEEP },
  directus: {
    url: env.DIRECTUS_URL.replace(/\/$/, ""),
    publicUrl: (env.DIRECTUS_PUBLIC_URL ?? env.DIRECTUS_URL).replace(/\/$/, ""),
    container: env.DIRECTUS_CONTAINER,
  },
  postgres: { url: env.PG_URL, container: env.POSTGRES_CONTAINER },
  dashboardService: env.DASHBOARD_SERVICE,
  dashboardKey: (env.DASHBOARD_KEY ?? null) as string | null,
  scriptsDir: env.SCRIPTS_DIR,
  // dist/config.js → server/dist → server → repo root
  contextFile: env.CONTEXT_FILE ?? path.resolve(here, "../../CLAUDE.md"),
  alertSources: (env.ALERT_SOURCES.length
    ? env.ALERT_SOURCES.filter((s): s is LogSource => (ALL_LOG_SOURCES as string[]).includes(s))
    : ALL_LOG_SOURCES) as LogSource[],
  // which env vars were set explicitly, so demo mode only fills the gaps
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
