#!/usr/bin/env bash
# Move a Supabase-hosted "kv" document table into an app's database on the homelab PostgreSQL
# and register it in that app's Directus. Written for fam.xgold.tech, whose whole backend is
# one table (fam.xgold.tech/supabase-schema.sql):
#     public.kv (coll text, id text, data jsonb, primary key (coll, id))
# with row-level security that lets the site's publishable key read and write seven colls.
#
# RUNS ON THE SERVER, next to the compose stack (SERVER_SETUP § 5.9). Needs curl, node and
# docker — psql runs inside the postgres container, as scripts/pg-backup.sh does. Nothing is
# installed on, or copied to, the machine you type this on.
#
#   scripts/migrate-supabase-kv.sh fam --url https://<ref>.supabase.co --key <api key>
#   scripts/migrate-supabase-kv.sh fam --from-file data/migrations/fam-kv-<stamp>.json
#
#   --table <name>      the table (default kv)
#   --from-file <json>  load a saved export instead of calling Supabase
#   --print-sql         print the load SQL and stop (no export, no connection; needs --from-file)
#   --skip-directus     load into PostgreSQL only
#   --directus-only     register + verify only (the data is already loaded)
#   --public-access     also give Directus's Public policy what Supabase's anon policy had
#                       (read/create/update/delete on the exported colls). Only when the
#                       front-end moves over: it lets anyone with the URL write, exactly like today.
#
# Steps: 1 export (REST, paged, saved under data/migrations/, mode 600) → 2 load (one transaction,
# idempotent upsert by key) → 3 register the collection and its fields in Directus → 4 verify
# that Supabase, PostgreSQL and Directus agree on the row count. Safe to re-run.
#
# The table at home gets ONE extra column: key text primary key = '<coll>/<id>' (the document
# path). Directus cannot manage a table whose primary key spans two columns; (coll, id) stays
# unique and a check constraint keeps key consistent. Everything else is identical.
#
# Env (from COMPOSE_ENV or ./.env, like the other scripts): POSTGRES_CONTAINER,
# APP_<NAME>_CONTAINER, APP_<NAME>_URL, APP_<NAME>_ADMIN_EMAIL / _ADMIN_PASSWORD; or DIRECTUS_TOKEN
# (a static token of an admin user) when the admin password was changed after install.
set -euo pipefail
umask 077

app="${1:-}"; shift || true
table="kv"; url=""; key=""; from_file=""; print_sql=0; skip_directus=0; directus_only=0; public_access=0
while [ $# -gt 0 ]; do
  case "$1" in
    --table) table="${2:-}"; shift 2 ;;
    --url) url="${2:-}"; url="${url%/}"; shift 2 ;;
    --key) key="${2:-}"; shift 2 ;;
    --from-file) from_file="${2:-}"; shift 2 ;;
    --print-sql) print_sql=1; shift ;;
    --skip-directus) skip_directus=1; shift ;;
    --directus-only) directus_only=1; shift ;;
    --public-access) public_access=1; shift ;;
    -h|--help) sed -n '2,34p' "$0"; exit 0 ;;
    *) echo "migrate-supabase-kv: unknown option $1" >&2; exit 64 ;;
  esac
done
if ! [[ "$app" =~ ^[a-z][a-z0-9_-]{0,30}$ ]] || ! [[ "$table" =~ ^[a-z_][a-z0-9_]{0,62}$ ]]; then
  echo "usage: scripts/migrate-supabase-kv.sh <app> --url https://<ref>.supabase.co --key <key> [--table kv] [--from-file f] [--print-sql] [--skip-directus] [--directus-only] [--public-access]" >&2
  exit 64
fi
if [ "$print_sql" = 1 ] && [ -z "$from_file" ]; then echo "migrate-supabase-kv: --print-sql needs --from-file" >&2; exit 64; fi
if [ "$directus_only" = 0 ] && [ -z "$from_file" ] && { [ -z "$url" ] || [ -z "$key" ]; }; then
  echo "migrate-supabase-kv: --url and --key (or --from-file) are required" >&2; exit 64
fi
for bin in curl node; do command -v "$bin" >/dev/null 2>&1 || { echo "migrate-supabase-kv: $bin is required" >&2; exit 1; }; done

log() { echo "migrate-supabase-kv: $*"; }
die() { echo "migrate-supabase-kv: $*" >&2; exit 1; }

here="$(cd "$(dirname "$0")/.." && pwd)"
envfile="${COMPOSE_ENV:-$here/.env}"
if [ -f "$envfile" ]; then
  # shellcheck disable=SC1090
  set -a; . "$envfile"; set +a
fi
upper="$(echo "$app" | tr '[:lower:]-' '[:upper:]_')"
pg_container="${POSTGRES_CONTAINER:-homelab-postgres}"
v="APP_${upper}_CONTAINER";      dx_container="${!v:-homelab-directus-$app}"
v="APP_${upper}_URL";            dx_url="${!v:-}"
v="APP_${upper}_ADMIN_EMAIL";    dx_email="${!v:-}"
v="APP_${upper}_ADMIN_PASSWORD"; dx_pass="${!v:-}"
dx_token="${DIRECTUS_TOKEN:-}"
outdir="${MIGRATION_DIR:-$here/data/migrations}"
stamp="$(date +%Y%m%d-%H%M%S)"
supabase_total="*"; supabase_note="not queried"
workdir="$(mktemp -d)"
cleanup() { rm -rf -- "$workdir"; }
trap cleanup EXIT
mktmp() { mktemp "$workdir/part.XXXXXX"; }

# json <js-expression over `d` (parsed stdin)> — prints the expression's value (string) or nothing
json() { node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{let d;try{d=JSON.parse(s)}catch{return}const v=(function(d){return eval(process.argv[1])})(d);if(v!==undefined&&v!==null)console.log(typeof v==="string"?v:JSON.stringify(v))})' "$1"; }

# ---- 1. export ---------------------------------------------------------------------------------
if [ "$directus_only" = 0 ] && [ "$print_sql" = 0 ] && [ -z "$from_file" ]; then
  case "$key" in
    sb_secret_*) supabase_note="secret key, unfiltered"; log "secret key: the copy includes every row (row-level security bypassed)" ;;
    sb_publishable_*) supabase_note="publishable key, limited to what the site may read"; log "publishable key: the copy is limited to the rows the site itself may read (its RLS policies); a secret key (Supabase → Settings → API keys) gives an unfiltered copy" ;;
    eyJ*) role="$(KEY="$key" node -e 'const p=(process.env.KEY.split(".")[1]||"");try{console.log(JSON.parse(Buffer.from(p,"base64url").toString()).role||"")}catch{console.log("")}')"
          supabase_note="legacy JWT, role ${role:-?}"; log "legacy JWT key with role '${role:-?}' ($([ "$role" = service_role ] && echo 'unfiltered copy' || echo 'limited by row-level security'))" ;;
    *) supabase_note="unknown key type" ;;
  esac
  mkdir -p "$outdir"; chmod 700 "$outdir"
  from_file="$outdir/$app-$table-$stamp.json"
  pages="$(mktmp)"; hdrs="$(mktmp)"; body="$(mktmp)"
  from=0; page=1000
  while :; do
    code="$(curl -sS -o "$body" -D "$hdrs" -w '%{http_code}' "$url/rest/v1/$table?select=*&order=coll,id" \
      -H "apikey: $key" -H "Authorization: Bearer $key" -H "Prefer: count=exact" -H "Range-Unit: items" -H "Range: $from-$((from + page - 1))")"
    case "$code" in
      200|206) ;;
      416) break ;;
      *) die "export: HTTP $code from $url/rest/v1/$table — $(head -c 300 "$body")" ;;
    esac
    range="$(tr -d '\r' < "$hdrs" | awk 'tolower($1)=="content-range:"{print $2}')"   # "0-999/2345" or "*/0"
    supabase_total="${range#*/}"; [ -n "$supabase_total" ] || supabase_total="*"
    n="$(json 'Array.isArray(d)?d.length:undefined' < "$body" || true)"
    [ -n "$n" ] || die "export: unexpected body from Supabase: $(head -c 300 "$body")"
    node -e 'const fs=require("fs");let rows;try{rows=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{throw Error("Invalid Supabase export page")};process.stdout.write(JSON.stringify(rows)+"\n")' "$body" >> "$pages"
    from=$((from + n))
    [ "$n" -eq 0 ] && break
    if [ "$supabase_total" != "*" ] && [ "$from" -ge "$supabase_total" ]; then break; fi
  done
  (umask 077; node -e '
    const fs = require("fs"); const rows = [];
    for (const line of fs.readFileSync(process.argv[1], "utf8").split("\n")) if (line.trim()) rows.push(...JSON.parse(line));
    fs.writeFileSync(process.argv[2], JSON.stringify(rows, null, 1) + "\n");
  ' "$pages" "$from_file")
  log "exported $from row(s) (Supabase reports $supabase_total) → $from_file"
  if [ "$supabase_total" != "*" ] && [ "$from" -ne "$supabase_total" ]; then die "export is incomplete ($from of $supabase_total rows)"; fi
fi

# ---- 2. load -----------------------------------------------------------------------------------
# One SQL script: Directus-compatible table (created only if missing), upsert by key, counts.
gen_sql() {  # $1 = export file
  node - "$1" "$table" <<'JS'
const fs = require("fs"), crypto = require("crypto");
const table = process.argv.at(-1), file = process.argv.at(-2);
const rows = JSON.parse(fs.readFileSync(file, "utf8"));
if (!Array.isArray(rows)) throw new Error("export is not a JSON array");
const seen = new Set(), extra = new Set(), colls = new Set(), out = [];
for (const r of rows) {
  if (!r || typeof r.coll !== "string" || typeof r.id !== "string") throw new Error("row without string coll/id: " + JSON.stringify(r).slice(0, 200));
  if (r.coll.includes("/")) throw new Error(`coll "${r.coll}" contains '/', which the key column uses as its separator`);
  const key = r.coll + "/" + r.id;
  if (seen.has(key)) throw new Error("duplicate document " + key);
  seen.add(key); colls.add(r.coll);
  for (const k of Object.keys(r)) if (!["coll", "id", "data"].includes(k)) extra.add(k);
  out.push({ key, coll: r.coll, id: r.id, data: r.data ?? {} });
}
if (extra.size) console.error(`migrate-supabase-kv: NOTE column(s) ${[...extra].join(", ")} exist upstream but are not part of the kv shape; they stay in the export file only`);
const tag = "kv" + crypto.randomBytes(8).toString("hex");
const payload = JSON.stringify(out);
if (payload.includes("$" + tag + "$")) throw new Error("quote tag collision, run again");
const t = `public.${table}`;
process.stdout.write(`-- generated by scripts/migrate-supabase-kv.sh: ${out.length} document(s) in ${colls.size} coll(s): ${[...colls].sort().join(", ")}
begin;
create table if not exists ${t} (
  key  text primary key,                        -- '<coll>/<id>': Directus needs a single-column primary key
  coll text not null,
  id   text not null,
  data jsonb not null default '{}'::jsonb,
  constraint ${table}_coll_id_unique unique (coll, id),
  constraint ${table}_key_is_path check (key = coll || '/' || id)
);
create index if not exists ${table}_coll_idx on ${t} (coll);
do $chk$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = '${table}' and column_name = 'key') then
    raise exception 'public.${table} already exists without the key column (a plain copy of the Supabase table?) - drop or rename it, then run again';
  end if;
end $chk$;
insert into ${t} (key, coll, id, data)
select x.key, x.coll, x.id, x.data
from jsonb_to_recordset($${tag}$${payload}$${tag}$::jsonb) as x(key text, coll text, id text, data jsonb)
on conflict (key) do update set coll = excluded.coll, id = excluded.id, data = excluded.data;
commit;
select coll, count(*)::int as documents from ${t} group by 1 order by 1;
`);
JS
}

if [ "$print_sql" = 1 ]; then gen_sql "$from_file"; exit 0; fi

pg_total=""
if [ "$directus_only" = 0 ]; then
  [ -f "$from_file" ] || die "export file not found: $from_file"
  docker inspect -f '{{.State.Running}}' "$pg_container" 2>/dev/null | grep -q true || die "container $pg_container is not running — start the stack first (SERVER_SETUP § 5.3)"
  log "loading into database '$app' (container $pg_container, table public.$table) …"
  gen_sql "$from_file" | docker exec -i "$pg_container" psql -v ON_ERROR_STOP=1 -q -U "$app" -d "$app" -f -
  pg_total="$(docker exec "$pg_container" psql -At -U "$app" -d "$app" -c "select count(*) from public.$table")"
  log "PostgreSQL now holds $pg_total document(s) in public.$table"
  if [ -f "$from_file" ]; then
    n_file="$(json 'd.length' < "$from_file")"
    [ "$n_file" = "$pg_total" ] || log "NOTE the export had $n_file row(s), the table holds $pg_total (earlier runs or the app may have added rows)"
  fi
fi

# ---- 3. Directus ---------------------------------------------------------------------------------
dx_status=""; dx_tmp=""
dx() {  # method path [json-body] → body on stdout, HTTP status in $dx_status
  local m="$1" p="$2" d="${3:-}"
  [ -n "$dx_tmp" ] || dx_tmp="$(mktmp)"
  if [ -n "$d" ]; then
    dx_status="$(curl -sS -o "$dx_tmp" -w '%{http_code}' -X "$m" "$dx_url$p" -H "Authorization: Bearer $dx_token" -H "Content-Type: application/json" --data "$d" || echo 000)"
  else
    dx_status="$(curl -sS -o "$dx_tmp" -w '%{http_code}' -X "$m" "$dx_url$p" -H "Authorization: Bearer $dx_token" || echo 000)"
  fi
  dx_out="$(cat "$dx_tmp")"
  printf '%s' "$dx_out"
}

dx_count=""
if [ "$skip_directus" = 0 ]; then
  if [ -z "$dx_url" ]; then
    port="$(docker port "$dx_container" 8055 2>/dev/null | head -1 || true)"
    [ -n "$port" ] || die "cannot find $dx_container's port (is the stack up?) — set APP_${upper}_URL=http://127.0.0.1:<port>"
    dx_url="http://${port/0.0.0.0/127.0.0.1}"
  fi
  dx_url="${dx_url%/}"
  curl -sSf -o /dev/null "$dx_url/server/ping" || die "Directus at $dx_url does not answer /server/ping"
  if [ -z "$dx_token" ]; then
    [ -n "$dx_email" ] && [ -n "$dx_pass" ] || die "no Directus credentials: set APP_${upper}_ADMIN_EMAIL/_ADMIN_PASSWORD in $envfile or DIRECTUS_TOKEN"
    login_body="$(DX_EMAIL="$dx_email" DX_PASS="$dx_pass" node -e 'console.log(JSON.stringify({email:process.env.DX_EMAIL,password:process.env.DX_PASS}))')"
    dx_token="$(curl -sS -X POST "$dx_url/auth/login" -H "Content-Type: application/json" --data "$login_body" | json 'd.data&&d.data.access_token' || true)"
    [ -n "$dx_token" ] || die "Directus login as $dx_email failed — if the admin password was changed after install, set DIRECTUS_TOKEN=<static token of an admin user>"
  fi

  # Directus caches the schema; the table was created behind its back.
  dx POST "/utils/cache/clear?system=true" >/dev/null || true

  if [ -n "$from_file" ] && [ -f "$from_file" ]; then
    colls_json="$(json 'JSON.stringify([...new Set(d.map(r=>r.coll))].sort())' < "$from_file" || true)"
  else
    colls_json="$(docker exec "$pg_container" psql -At -U "$app" -d "$app" -c "select coalesce(json_agg(c order by c), '[]') from (select distinct coll as c from public.$table) s" 2>/dev/null || true)"
  fi
  [ -n "$colls_json" ] || colls_json='[]'
  if [ "$app" = fam ]; then colls_json='["plans","bedrooms","flights","members","progress","meals","groceries"]'; fi
  meta="$(TABLE="$table" APP="$app" node -e 'console.log(JSON.stringify({meta:{icon:"inventory_2",note:`Documents of the ${process.env.APP} site, moved from Supabase: one row per document, key = coll/id`,display_template:"{{key}}",collapse:"open"}}))')"
  dx PATCH "/collections/$table" "$meta" >/dev/null; out="$dx_out"
  if [ "$dx_status" = 200 ] || [ "$dx_status" = 204 ]; then
    log "Directus: collection '$table' registered"
  else
    log "WARN Directus did not accept the collection (HTTP $dx_status): $(printf '%s' "$out" | head -c 300)"
    log "     restart $dx_container (its schema cache predates the table) and run again with --directus-only"
  fi
  fld() { local f="$1" m="$2" o; dx PATCH "/fields/$table/$f" "$m" >/dev/null; o="$dx_out"; if [ "$dx_status" = 200 ] || [ "$dx_status" = 204 ]; then log "Directus: field '$f' configured"; else log "WARN field '$f' (HTTP $dx_status): $(printf '%s' "$o" | head -c 200)"; fi; }
  fld key  '{"meta":{"interface":"input","width":"full","note":"coll/id — the document path; must match the two fields below"}}'
  fld coll "$(COLLS="$colls_json" node -e 'const c=JSON.parse(process.env.COLLS);console.log(JSON.stringify({meta:{interface:"select-dropdown",options:{choices:c.map(x=>({text:x,value:x})),allowOther:true},width:"half"}}))')"
  fld id   '{"meta":{"interface":"input","width":"half"}}'
  fld data '{"meta":{"interface":"input-code","options":{"language":"json"},"width":"full"}}'

  if [ "$public_access" = 1 ]; then
    log "public access: giving the Public policy read/create/update/delete on $table where coll in $colls_json (what Supabase's anon policy allowed)"
    pol="$(dx GET "/policies?filter%5Bname%5D%5B_eq%5D=%24t%3Apublic_label&fields=id&limit=1" | json 'd.data&&d.data[0]&&d.data[0].id' || true)"
    if [ -z "$pol" ]; then
      log "WARN could not find the Public policy (Directus ≥ 11 names it \$t:public_label) — grant the permissions in Settings → Access Policies → Public"
    else
      have="$(dx GET "/permissions?filter%5Bpolicy%5D%5B_eq%5D=$pol&filter%5Bcollection%5D%5B_eq%5D=$table&fields=action&limit=-1" | json 'd.data&&d.data.map(p=>p.action).join(",")' || true)"
      for action in read create update delete; do
        case ",$have," in *",$action,"*) log "public access: $action already granted"; continue ;; esac
        perm="$(POL="$pol" TABLE="$table" ACTION="$action" COLLS="$colls_json" node -e '
          const f = { coll: { _in: JSON.parse(process.env.COLLS) } }, a = process.env.ACTION;
          const p = { policy: process.env.POL, collection: process.env.TABLE, action: a, fields: a === "update" ? ["data"] : ["key","coll","id","data"], permissions: a === "create" ? null : f, validation: a === "create" ? f : null };
          console.log(JSON.stringify(p));')"
        dx POST "/permissions" "$perm" >/dev/null; o="$dx_out"
        if [ "$dx_status" = 200 ]; then log "public access: $action granted"; else log "WARN public $action (HTTP $dx_status): $(printf '%s' "$o" | head -c 200)"; fi
      done
    fi
  fi

  dx_count="$(dx GET "/items/$table?aggregate%5Bcount%5D=%2A" | json 'd.data&&d.data[0]&&String(d.data[0].count)' || true)"
fi

# ---- 4. verify -----------------------------------------------------------------------------------
[ -n "$pg_total" ] || pg_total="$(docker exec "$pg_container" psql -At -U "$app" -d "$app" -c "select count(*) from public.$table" 2>/dev/null || echo '?')"
echo
echo "  Supabase rows    : $supabase_total  ($supabase_note)"
echo "  PostgreSQL rows  : $pg_total  (database $app, table public.$table, container $pg_container)"
if [ "$skip_directus" = 0 ]; then echo "  Directus count   : ${dx_count:-?}  ($dx_url/items/$table)"; fi
[ -z "$from_file" ] || echo "  Export kept at   : $from_file"
echo
status=0
if [ "$supabase_total" != "*" ] && [ "$pg_total" != "$supabase_total" ]; then log "MISMATCH: PostgreSQL has $pg_total rows, Supabase reported $supabase_total"; status=1; fi
if [ "$skip_directus" = 0 ] && [ -n "$dx_count" ] && [ "$dx_count" != "$pg_total" ]; then log "MISMATCH: Directus counts $dx_count, PostgreSQL $pg_total (is the collection registered?)"; status=1; fi
if [ "$skip_directus" = 0 ] && [ -z "$dx_count" ]; then log "ERROR Directus count unavailable — verification incomplete; open $dx_url/admin → Content → $table"; status=1; fi
agree="PostgreSQL"; [ "$skip_directus" = 0 ] && agree="PostgreSQL and Directus"
if [ "$status" = 0 ]; then log "done — $agree agree. Next: SERVER_SETUP § 5.9 (switch the front-end, then pause the Supabase project)."; fi
exit "$status"
