// The Directus-per-app platform: for every app in APPS, how its Directus (local + through
// the tunnel), its own Postgres database, its users and its newest dump are doing; plus
// the Cloudflare Tunnel and the Postgres core (every database, and proof that 5432 is
// bound to loopback only). Read-only.
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { cfg } from "../config.js";
import * as demo from "../demo.js";
import { containerInfo, dockerAvailable } from "./docker.js";
import type { AppContainer, AppDbStats, AppKind, AppStatus, AppsPayload, PgDatabaseRow, ServiceState, TunnelStatus } from "../types.js";

const execFileP = promisify(execFile);
const TTL_MS = 15_000;
const pools = new Map<string, pg.Pool>();
let cache: { at: number; value: AppsPayload } | null = null;

function poolFor(db: string): pg.Pool | null {
  if (!cfg.postgres.url) return null;
  let p = pools.get(db);
  if (!p) {
    const u = new URL(cfg.postgres.url);
    u.pathname = `/${db}`;
    p = new pg.Pool({ connectionString: u.toString(), max: 1, connectionTimeoutMillis: 4000, idleTimeoutMillis: 30_000 });
    pools.set(db, p);
  }
  return p;
}

async function container(name: string): Promise<AppContainer | null> {
  const c = await containerInfo(name);
  return c ? { state: c.state, startedAt: c.startedAt, image: c.image } : null;
}

async function health(url: string, timeoutMs: number, healthPath = "/server/health", token?: string): Promise<{ ok: boolean | null; status: string | null; httpStatus: number | null; latencyMs: number | null; note?: string }> {
  const t = Date.now();
  try {
    const res = await fetch(`${url}${healthPath}`, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual", headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    const latencyMs = Date.now() - t;
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location") ?? "";
      return { ok: true, status: "login-wall", httpStatus: res.status, latencyMs, note: /cloudflareaccess/i.test(loc) ? "behind Cloudflare Access (login required)" : `redirects to ${loc}` };
    }
    const body = (await res.json().catch(() => ({}))) as { status?: string; ok?: boolean };
    // Directus answers {"status":"ok"}; Twenty's /healthz is a plain 200
    return { ok: res.ok && body.ok !== false && (body.status ?? "ok") === "ok", status: body.status ?? (res.ok ? "ok" : "error"), httpStatus: res.status, latencyMs };
  } catch (e) {
    return { ok: false, status: null, httpStatus: null, latencyMs: null, note: (e as Error).message };
  }
}

async function dbStats(db: string, kind: AppKind = "directus"): Promise<AppDbStats> {
  const empty: AppDbStats = { exists: false, sizeBytes: null, tables: null, collections: null, users: null, lastLogin: null };
  const core = poolFor(new URL(cfg.postgres.url ?? "postgres://x/postgres").pathname.slice(1) || "postgres");
  if (!core) return { ...empty, error: "PG_URL not set" };
  try {
    const ex = await core.query<{ n: number }>("select count(*)::int as n from pg_database where datname = $1", [db]);
    if (!ex.rows[0]?.n) return { ...empty, error: `database "${db}" does not exist` };
  } catch (e) {
    return { ...empty, error: (e as Error).message };
  }
  const p = poolFor(db)!;
  try {
    // directus: everything lives in public (its own tables are directus_*); twenty: core + metadata
    // schemas plus one workspace_<id> schema per workspace holding the CRM objects
    const [size, tables, coll] = await Promise.all([
      p.query<{ size: string }>("select pg_database_size(current_database())::bigint as size"),
      p.query<{ n: number }>("select count(*)::int as n from information_schema.tables where table_schema not in ('pg_catalog', 'information_schema') and table_type = 'BASE TABLE'"),
      kind === "umami"
        ? p.query<{ n: number }>('select count(*)::int as n from public.website')
        : kind === "twenty"
        ? p.query<{ n: number }>("select count(*)::int as n from information_schema.tables where table_schema like 'workspace\\_%' and table_type = 'BASE TABLE'")
        : p.query<{ n: number }>("select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name not like 'directus\\_%'"),
    ]);
    let users: number | null = null;
    let lastLogin: string | null = null;
    try {
      const u =
        kind === "umami"
          ? await p.query<{ n: number; last: Date | null }>('select count(*)::int as n, null::timestamptz as last from public."user"')
          : kind === "twenty"
          ? await p.query<{ n: number; last: Date | null }>('select count(*)::int as n, max("updatedAt") as last from core."user"')
          : await p.query<{ n: number; last: Date | null }>("select count(*)::int as n, max(last_access) as last from directus_users");
      users = u.rows[0]?.n ?? 0;
      lastLogin = u.rows[0]?.last ? new Date(u.rows[0].last).toISOString() : null;
    } catch {
      // the app has not bootstrapped this database yet
    }
    return { exists: true, sizeBytes: Number(size.rows[0]?.size ?? 0), tables: tables.rows[0]?.n ?? 0, collections: coll.rows[0]?.n ?? 0, users, lastLogin };
  } catch (e) {
    return { ...empty, exists: true, error: (e as Error).message };
  }
}

async function latestBackup(db: string): Promise<AppStatus["backup"]> {
  // The verified encrypted offsite pipeline supersedes legacy plaintext dumps.
  if (process.env.OFFSITE_BACKUP_RECEIPT) {
    try {
      const receiptFile = process.env.OFFSITE_BACKUP_RECEIPT;
      const receipt = JSON.parse(await fsp.readFile(receiptFile, "utf8")) as { remote: string; databases: string[]; verifiedAt: string; downloadVerified: boolean; files: string[] };
      const name = `${db}.dump.gpg`;
      if (receipt.downloadVerified && receipt.databases.includes(db) && receipt.files.includes(name)) {
        const root = path.dirname(receiptFile);
        const folder = path.basename(receipt.remote);
        const file = path.join(root, folder, name);
        const st = await fsp.stat(file);
        return { latest: receipt.verifiedAt, file, bytes: st.size, count: 1 };
      }
    } catch { /* Fall back to the legacy dump location when a receipt is unavailable. */ }
  }
  try {
    const names = (await fsp.readdir(cfg.pgBackupDir)).filter((n) => new RegExp(`^${db.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{8}-\\d{6}\\.sql\\.gz$`).test(n)).sort();
    if (!names.length) return { latest: null, file: null, bytes: null, count: 0 };
    const file = path.join(cfg.pgBackupDir, names[names.length - 1]);
    const st = await fsp.stat(file);
    return { latest: st.mtime.toISOString(), file, bytes: st.size, count: names.length };
  } catch {
    return { latest: null, file: null, bytes: null, count: 0 };
  }
}

/** Which local addresses a TCP port is listening on (Linux `ss`); null when unavailable. */
export async function portBinds(port: number): Promise<string[] | null> {
  try {
    const { stdout } = await execFileP("ss", ["-ltnH"], { timeout: 5000 });
    const binds: string[] = [];
    for (const line of stdout.split("\n")) {
      const cols = line.trim().split(/\s+/);
      const local = cols[3] ?? "";
      const m = local.match(/^(.*):(\d+)$/);
      if (m && Number(m[2]) === port) binds.push(m[1].replace(/^\[|\]$/g, ""));
    }
    return binds;
  } catch {
    return null;
  }
}

const loopbackOnly = (binds: string[] | null): boolean | null => (binds === null ? null : binds.length > 0 && binds.every((b) => b === "127.0.0.1" || b === "::1" || b.startsWith("127.")));

async function tunnelStatus(): Promise<TunnelStatus> {
  const hostnames = [...new Set(cfg.apps.map((a) => a.publicUrl).filter((u): u is string => !!u).map((u) => new URL(u).host))];
  const c = await container(cfg.cloudflared.container);
  try {
    const res = await fetch(`${cfg.cloudflared.metricsUrl}/ready`, { signal: AbortSignal.timeout(3000) });
    const body = (await res.json().catch(() => ({}))) as { status?: number; readyConnections?: number };
    return { container: c, ready: res.ok && (body.readyConnections ?? 0) > 0, connections: body.readyConnections ?? null, hostnames };
  } catch (e) {
    return { container: c, ready: c ? false : null, connections: null, hostnames, error: c ? `metrics not reachable at ${cfg.cloudflared.metricsUrl}: ${(e as Error).message}` : dockerAvailable() ? `container ${cfg.cloudflared.container} not found` : "Docker not available" };
  }
}

async function appStatus(a: (typeof cfg.apps)[number]): Promise<AppStatus> {
  const [c, local, pub, database, backup] = await Promise.all([container(a.container), health(a.url, 4000, a.healthPath, a.healthToken), a.publicUrl ? health(a.kind === "umami" ? new URL(a.publicUrl).origin : a.publicUrl, 8000, a.healthPath, a.healthToken) : Promise.resolve(null), dbStats(a.db, a.kind), latestBackup(a.db)]);
  let state: ServiceState = "ok";
  if (!local.ok || !database.exists) state = c?.state === "running" || database.exists ? "degraded" : c ? "down" : "unavailable";
  if (local.ok && pub && pub.ok === false) state = "degraded";
  if (local.ok && !c && dockerAvailable()) state = "degraded";
  // a database without a recent dump is not "ok" — the card says why
  if (state === "ok" && (!backup.latest || Date.now() - Date.parse(backup.latest) > 48 * 3_600_000)) state = "degraded";
  return {
    name: a.name,
    kind: a.kind,
    url: a.url,
    publicUrl: a.publicUrl,
    siteUrl: a.siteUrl,
    containerName: a.container,
    db: a.db,
    state,
    container: c,
    local: { ok: !!local.ok, status: local.status, latencyMs: local.latencyMs, error: local.ok ? undefined : local.note },
    public: pub ? { ok: pub.ok, httpStatus: pub.httpStatus, latencyMs: pub.latencyMs, note: pub.note } : { ok: null, httpStatus: null, latencyMs: null, note: "no public URL (set PUBLIC_DOMAIN or APP_<NAME>_PUBLIC_URL)" },
    database,
    backup,
  };
}

async function postgresCore(): Promise<AppsPayload["postgres"]> {
  const exposure = { binds: (await portBinds(5432)) ?? [], loopbackOnly: loopbackOnly(await portBinds(5432)) };
  if (!cfg.postgres.url) return { connected: false, version: null, databases: [], exposure, error: "PG_URL not set" };
  const core = poolFor(new URL(cfg.postgres.url).pathname.slice(1) || "postgres")!;
  try {
    const [v, dbs] = await Promise.all([
      core.query<{ version: string }>("select version()"),
      core.query<{ name: string; owner: string; size: string }>("select d.datname as name, r.rolname as owner, pg_database_size(d.datname)::bigint as size from pg_database d join pg_roles r on r.oid = d.datdba where not d.datistemplate order by 1"),
    ]);
    const byDb = new Map(cfg.apps.map((a) => [a.db, a.name]));
    const databases: PgDatabaseRow[] = dbs.rows.map((r) => ({ name: r.name, owner: r.owner, sizeBytes: Number(r.size), app: byDb.get(r.name) ?? null }));
    return { connected: true, version: v.rows[0]?.version.split(",")[0] ?? null, databases, exposure };
  } catch (e) {
    return { connected: false, version: null, databases: [], exposure, error: (e as Error).message };
  }
}

export async function appsStatus(force = false): Promise<AppsPayload> {
  // [DEMO] demo-mode branch — fixed fam/ai/tunnel data; never taken on a real install (see DEMO_INDEX.md)
  if (cfg.demo) return demo.apps();
  if (cache && !force && Date.now() - cache.at < TTL_MS) return cache.value;
  const [apps, tunnel, postgres] = await Promise.all([Promise.all(cfg.apps.map(appStatus)), tunnelStatus(), postgresCore()]);
  const value: AppsPayload = { apps, tunnel, domain: cfg.publicDomain, postgres, backupDir: cfg.pgBackupDir, checkedAt: new Date().toISOString() };
  cache = { at: Date.now(), value };
  return value;
}
