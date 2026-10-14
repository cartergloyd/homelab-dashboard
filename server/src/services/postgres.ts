import pg from "pg";
import { cfg } from "../config.js";
import * as demo from "../demo.js";
import type { DatabasePayload } from "../types.js";

let pool: pg.Pool | null = null;

export async function pgStats(): Promise<DatabasePayload["postgres"]> {
  // [DEMO] demo-mode branch — fake data for `npm run demo`; never taken on a real install (see DEMO_INDEX.md)
  if (cfg.demo) return demo.pgStats();
  const empty: DatabasePayload["postgres"] = { connected: false, version: null, sizeBytes: null, tables: null, topTables: [] };
  if (!cfg.postgres.url) return { ...empty, error: "PG_URL not set" };
  pool ??= new pg.Pool({ connectionString: cfg.postgres.url, max: 2, connectionTimeoutMillis: 4000, idleTimeoutMillis: 30_000 });
  try {
    const [version, size, tables, top] = await Promise.all([
      pool.query<{ version: string }>("select version()"),
      pool.query<{ size: string }>("select pg_database_size(current_database())::bigint as size"),
      pool.query<{ n: number }>(
        "select count(*)::int as n from information_schema.tables where table_schema not in ('pg_catalog','information_schema')",
      ),
      pool.query<{ name: string; rows: string; bytes: string }>(
        "select relname as name, n_live_tup::bigint as rows, pg_total_relation_size(relid)::bigint as bytes from pg_stat_user_tables order by 3 desc limit 8",
      ),
    ]);
    return {
      connected: true,
      version: version.rows[0]?.version.split(",")[0] ?? null,
      sizeBytes: Number(size.rows[0]?.size ?? 0),
      tables: tables.rows[0]?.n ?? 0,
      topTables: top.rows.map((r) => ({ name: r.name, rows: Number(r.rows), bytes: Number(r.bytes) })),
    };
  } catch (e) {
    return { ...empty, error: (e as Error).message };
  }
}
