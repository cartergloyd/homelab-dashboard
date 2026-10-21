# fam.xgold.tech migration — installed server workflow

Downloaded upstream migration tooling from main commit 73da390. The fam stack is
already live: PostgreSQL `gold-platform-postgres`, Directus `homelab-directus-fam`
on localhost8056, and `https://fam-api.xgold.tech` through the existing tunnel.

Take an encrypted backup first. Export/import runs entirely on this Linux server:

```sh
POSTGRES_CONTAINER=gold-platform-postgres \
MIGRATION_DIR=/home/gold/server-platform/backup-private/fam-migration \
scripts/migrate-supabase-kv.sh fam --url "$SUPABASE_URL" --key "$SUPABASE_PUBLIC_KEY" --skip-directus

docker exec -i gold-platform-postgres psql -v ON_ERROR_STOP=1 -U fam -d fam < deploy/fam-kv-directus.sql
```

The metadata SQL keeps administrator MFA enforced; no administrator static token
or OTP is needed. The installed Directus 12.5 build does not enable custom
filtered public permissions. The SQL therefore adds a seven-coll CHECK
constraint and immutable document-path trigger in PostgreSQL, then grants
collection-wide public CRUD on `kv` only. Unknown colls and document-path moves
are rejected by the database. This preserves the site's existing anonymous
sharing model. Do not reuse this public-access setup for private applications.

The SQL is specific to this existing family document store. Its seven colls are
plans, bedrooms, flights, members, progress, meals and groceries, including any
empty collections. Do not derive permissions only from the rows present in an
export. Additional app collections retain their own private permissions.

In the live public-apps compose configuration, only fam needs:

```yaml
CORS_ORIGIN: "https://fam.xgold.tech,https://fam-api.xgold.tech"
WEBSOCKETS_REST_AUTH: "public"
```

Recreate fam after environment changes or restart it after direct SQL schema and
metadata changes. Verify authenticated health before continuing.

Verify the full exported content against both PostgreSQL and Directus responses,
not only counts. Test public read/create/update/delete, same ids across colls,
encoded paths, unknown-coll rejection, private admin APIs, CORS and realtime
propagation between browsers. Delete all synthetic test records. Take another
encrypted offsite backup and rerun the source export immediately before cutover.

The family-site change removes supabase-js, loads `directus-db.js`, retains
`destin-uid`, and uses public REST/WebSockets with a 15-second polling fallback.
Deploy through the family repo's main branch. Keep Supabase for several days;
reconcile any post-cutover edits before a rollback. Do not delete the source
project or commit exports containing member data.

The migration script now handles formatted JSON pages, securely cleans temporary
files, preserves HTTP status outside command-substitution subshells, and fails
verification when Directus's count is unavailable. Its generic API-registration
mode still requires a supported permissions configuration and administrator
authentication; use the SQL workflow above on this installed MFA-protected stack.

Offline regression checks: `node scripts/test-migrate-supabase-kv.mjs`.
