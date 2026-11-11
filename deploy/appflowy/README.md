# AppFlowy (the Notes tab)

Self-hosted [AppFlowy Cloud](https://github.com/AppFlowy-IO/AppFlowy-Cloud) as its own compose project
(`homelab-notes`), shown inside the dash as **Notes** (an iframe of `https://notes.xgold.tech`).
Live on gold-server in `~/server-platform/appflowy/`; nothing runs on the dev Mac.

```
dash.xgold.tech  ──iframe──▶  notes.xgold.tech ─ Cloudflare Access (GitHub, owner only)
                                     │  tunnel public hostname
                                     ▼
                   127.0.0.1:8070  nginx ─┬─ appflowy_web  (the app)
                                          ├─ appflowy_cloud / worker / search
                                          ├─ gotrue  (sign-in)       ├─ postgres (pgvector, its own)
                                          └─ minio  (uploads)        └─ redis
```

| File | What |
| --- | --- |
| `install.sh` | clones upstream at a pinned commit, writes `.env` with fresh secrets, starts the stack |
| `compose.override.yml` | loopback-only port, memory caps, no AI / admin console, MinIO fork |
| `dc` | `docker compose` for this project: `./dc ps`, `./dc logs -f appflowy_cloud`, `./dc restart` |
| `backup.sh` | nightly `pg_dumpall` + MinIO volume into `backups/`, keeps 7 days |

## Install (on gold-server)

```bash
mkdir -p ~/server-platform/appflowy && cd ~/server-platform/appflowy
# copy this folder's files here, then:
./install.sh            # safe to re-run; keeps .env
cat ADMIN-CREDENTIALS.txt   # the one AppFlowy login (sign-ups are closed)
( crontab -l 2>/dev/null; echo '50 3 * * * /home/gold/server-platform/appflowy/backup.sh >> /home/gold/server-platform/appflowy/backups/backup.log 2>&1' ) | crontab -
```

## Publish it (Cloudflare, owner only — **in this order**)

1. Zero Trust → Access → Applications → add **AppFlowy notes**: destination `notes.xgold.tech`, policy *Owner* =
   allow the owner's login, identity provider GitHub only, session **1 month** (the iframe cannot show a login
   page, so a long session means you rarely have to open Notes in a tab to sign in).
2. Networks → Tunnels → `homelab` → Public hostnames → add `notes.xgold.tech` → `http://127.0.0.1:8070`.
   Never before step 1: AppFlowy has its own login but should not face the internet alone.
3. Dash env (`~/server-platform/homelab-dashboard.env`): `NOTES_URL=https://notes.xgold.tech`, and add `notes` to
   `HOSTNAMES_EXTRA`. Restart `gold-dashboard` (`systemctl --user restart gold-dashboard`).

## Decisions and limits

- **Pinned, not `latest`.** Upstream's git tags stop at 0.9.64 (Jul 2025) while its Docker images are at 0.20.x, so the
  wiring is pinned by commit (`install.sh`) and the images by version (`.env`). Upgrade: change the versions in `.env`,
  `./dc up -d --no-build`, check `./dc ps`.
- **MinIO.** Upstream's `minio/minio` image no longer exists on Docker Hub or Quay; `pgsty/minio` is the community fork
  of the same server. It only listens inside the compose network (plus nginx's `/minio` paths behind Access).
- **Sign-ups closed** (`GOTRUE_DISABLE_SIGNUP=true`), no e-mail is sent, AI and the admin console are off. To add a
  person: remove `profiles: [off]` from `admin_frontend`, `./dc up -d admin_frontend`, use `/console`, and set
  `GOTRUE_DISABLE_SIGNUP=false` only while inviting.
- **Native AppFlowy apps cannot sign in through Cloudflare Access.** Browser only, by choice (2026-11-10).
- **Memory.** About 650 MB in use at install; each container is capped (about 2.5 GB in total, no swap per container).
  gold-server is tight, so a runaway container is killed alone instead of squeezing Minecraft.
- **Backups are local only** (7 days). `backup.sh` marks the gap; the off-site receipt flow is not wired.

## Restore

```bash
cd ~/server-platform/appflowy && ./dc down
./dc up -d postgres && gunzip < backups/<date>/postgres.sql.gz | ./dc exec -T postgres psql -U postgres
docker run --rm -i -v homelab-notes_minio_data:/data alpine tar xzf - -C /data < backups/<date>/minio.tar.gz
./dc up -d --no-build
```
