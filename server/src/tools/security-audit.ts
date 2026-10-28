import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { cfg } from "../config.js";

const exec = promisify(execFile);
export interface SecurityCheck { area: string; name: string; status: "pass" | "warn" | "fail"; detail: string; gate?: boolean }

/** Read-only checks: never log container environments, password hashes or MFA secrets. */
export async function securityChecks(envFile: string): Promise<SecurityCheck[]> {
  const checks: SecurityCheck[] = [];
  const check = (name: string, ok: boolean, detail: string, area = "database-security") => checks.push({ area, name, status: ok ? "pass" : "fail", detail, gate: true });
  try {
    const mode = (await fs.stat(envFile)).mode & 0o777;
    check("dashboard environment permissions", mode === 0o600, `mode ${mode.toString(8)}`, "remote");
  } catch { check("dashboard environment permissions", false, "environment file missing or unreadable", "remote"); }
  if (cfg.postgres.url) {
    const core = new pg.Client({ connectionString: cfg.postgres.url, connectionTimeoutMillis: 5000, query_timeout: 8000 });
    try {
      await core.connect();
      const settings = (await core.query("SELECT name, setting FROM pg_settings WHERE name IN ('password_encryption','log_connections')")).rows;
      for (const [name, expected] of [["password_encryption", "scram-sha-256"], ["log_connections", "on"]]) {
        const value = settings.find((r) => r.name === name)?.setting;
        check(name, value === expected, value ?? "unknown");
      }
      const hba = (await core.query("SELECT type,address,auth_method,error FROM pg_hba_file_rules")).rows;
      check("PostgreSQL TCP authentication", hba.length > 0 && hba.every((r) => !r.error && (r.type === "local" || ["scram-sha-256", "reject"].includes(r.auth_method))) && hba.every((r) => r.address !== "all" || r.auth_method === "reject"), "TCP requires SCRAM or is rejected; no unrestricted all-address password rule");
      for (const app of cfg.apps) {
        const roles = (await core.query("SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconfig FROM pg_roles WHERE rolname=$1", [app.db])).rows;
        const role = roles[0];
        check(`${app.name}: restricted database role`, !!role && !role.rolsuper && !role.rolcreatedb && !role.rolcreaterole && !role.rolreplication && !role.rolbypassrls, role ? "superuser, role/database creation, replication and RLS bypass disabled" : "role missing");
        for (const name of ["statement_timeout", "idle_in_transaction_session_timeout"]) {
          const value = (role?.rolconfig as string[] | undefined)?.find((v) => v.startsWith(name + "="))?.slice(name.length + 1);
          check(`${app.name}: ${name}`, !!value && /^(?!0(?:\D|$))\d+(?:ms|s|min|h)?$/.test(value), value ?? "unset");
        }
        const others = (await core.query("SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> $1 AND has_database_privilege($1,oid,'CONNECT')", [app.db])).rows;
        check(`${app.name}: database isolation`, !others.length, others.length ? `can connect to: ${others.map((r) => r.datname).join(", ")}` : "cannot connect to other non-template databases");
        if (app.kind === "twenty") {
          const response = await fetch(`${app.url}${app.healthPath}`, { signal: AbortSignal.timeout(5000) });
          check(`${app.name}: CRM health`, response.ok, `HTTP ${response.status}`);
          checks.push({ area: "database-security", name: `${app.name}: CRM account security`, status: "warn", detail: "Verify invite-only workspace and owner MFA in Twenty; Directus checks do not apply" });
          continue;
        }
        const url = new URL(cfg.postgres.url); url.pathname = `/${app.db}`;
        const db = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000, query_timeout: 8000 });
        try {
          await db.connect();
          const policies = (await db.query("SELECT enforce_tfa FROM directus_policies WHERE admin_access")).rows;
          check(`${app.name}: administrator MFA policy`, policies.length > 0 && policies.every((r) => r.enforce_tfa), "all administrator policies must require MFA");
          // Join both direct-user and role-policy assignments without reading TOTP values.
          const admins = (await db.query(`SELECT DISTINCT u.id, (u.tfa_secret IS NOT NULL) AS enrolled, (u.token IS NOT NULL) AS static_token
            FROM directus_users u JOIN directus_access a ON a.user=u.id OR a.role=u.role
            JOIN directus_policies p ON p.id=a.policy WHERE p.admin_access AND u.status='active'`)).rows;
          check(`${app.name}: administrator enrollment`, admins.length > 0 && admins.every((r) => r.enrolled && !r.static_token), `${admins.length} active administrator(s); all must be enrolled and have no static token`);
          const s = (await db.query("SELECT public_registration,auth_password_policy,auth_login_attempts FROM directus_settings LIMIT 1")).rows[0];
          check(`${app.name}: registration and password policy`, !!s && s.public_registration === false && !!s.auth_password_policy && s.auth_login_attempts > 0 && s.auth_login_attempts <= 10, "registration off; password policy and finite login attempts required");
          const perms = (await db.query("SELECT count(*)::int AS n FROM directus_permissions")).rows[0].n;
          checks.push({ area: "database-security", name: `${app.name}: collection permissions review`, status: perms === 0 ? "pass" : "warn", detail: perms === 0 ? "no collection grants; review owner filters before adding app permissions" : `${perms} permission rules need collection-specific review` });
        } finally { await db.end(); }
        // Inspect env privately in memory; output only the result of comparisons.
        const inspected = JSON.parse((await exec("docker", ["inspect", app.container], { timeout: 5000 })).stdout)[0];
        const env = Object.fromEntries((inspected.Config.Env as string[]).map((v) => { const i = v.indexOf("="); return [v.slice(0, i), v.slice(i + 1)]; }));
        check(`${app.name}: token and cookie settings`, env.ACCESS_TOKEN_TTL === "15m" && env.REFRESH_TOKEN_TTL === "7d" && env.SESSION_COOKIE_TTL === "1d" && env.SESSION_COOKIE_SECURE === "true" && env.REFRESH_TOKEN_COOKIE_SECURE === "true", "15m access, 7d refresh, 1d sessions; secure session/refresh cookies");
        check(`${app.name}: API rate limiter`, env.RATE_LIMITER_ENABLED === "true", "Directus global request limiter enabled");
        const anon = await fetch(`${app.publicUrl}/admin`, { redirect: "manual", signal: AbortSignal.timeout(8000) });
        const loginWall = [302, 303, 307].includes(anon.status) && /\.cloudflareaccess\.com\//.test(anon.headers.get("location") ?? "");
        check(`${app.name}: administrator Access wall`, loginWall || anon.status === 403, `anonymous admin request: HTTP ${anon.status}`, "remote");
      }
    } catch (e) {
      check("security inspection completed", false, (e as Error).message);
    } finally { await core.end(); }
  } else check("PostgreSQL security inspection", false, "PG_URL is required");
  if (cfg.cfAccess) {
    try {
      const response = await fetch(`http://127.0.0.1:${cfg.port}/api/security/status`, { headers: { Authorization: `Bearer ${cfg.dashboardKey}` }, signal: AbortSignal.timeout(5000) });
      check("browser security headers", response.headers.get("x-content-type-options") === "nosniff" && !!response.headers.get("strict-transport-security") && (response.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none'"), "HSTS, CSP frame restrictions and nosniff required", "remote");
      check("private API cache policy", response.headers.get("cache-control") === "no-store", "API responses must not be cached", "remote");
    } catch (e) { check("browser security headers", false, (e as Error).message, "remote"); }
  }
  if (process.env.OFFSITE_BACKUP_RECEIPT) {
    try {
      const receipt = JSON.parse(await fs.readFile(process.env.OFFSITE_BACKUP_RECEIPT, "utf8"));
      const age = (Date.now() - Date.parse(receipt.verifiedAt)) / 3600000;
      const databases = [...cfg.apps.map((a) => a.db), ...(cfg.postgres.url ? [decodeURIComponent(new URL(cfg.postgres.url).pathname.slice(1))] : [])];
      check("encrypted offsite restore verification", age >= 0 && age < 30 && receipt.downloadVerified === true && Array.isArray(receipt.databases) && databases.every((db) => receipt.databases.includes(db)) && Array.isArray(receipt.files) && receipt.files.length >= databases.length && receipt.files.every((f: unknown) => typeof f === "string" && f.endsWith(".gpg")), `latest downloaded-copy restore verification ${age.toFixed(1)}h ago`);
    } catch { check("encrypted offsite restore verification", false, "verification receipt missing or unreadable"); }
  } else check("encrypted offsite restore verification", false, "OFFSITE_BACKUP_RECEIPT unset; configure the backup job's success receipt");
  return checks;
}
