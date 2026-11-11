# AppFlowy (the Notes tab)

Self-hosted [AppFlowy Cloud](https://github.com/AppFlowy-IO/AppFlowy-Cloud) as its own compose project
(`homelab-notes`), served by the dash itself at **`https://dash.xgold.tech/appflowy`** and shown inside it as the
**Notes** tab. No hostname, tunnel route or Access app of its own: the dash's existing Cloudflare Access login
protects it, and AppFlowy keeps its own login on top. Live on gold-server in `~/server-platform/appflowy/`;
nothing runs on the dev Mac.

```
browser ─ Cloudflare Access (GitHub) ─ tunnel ─ dash 127.0.0.1:8088 ── notesProxy.ts ──▶ 127.0.0.1:8070 nginx
          /appflowy/*  (api, gotrue, ws, minio-api: prefix stripped)                      ├─ appflowy_web (the app)
          /app /login /static /covers /af_icons /pdfjs /appflowy.svg|ico /og-image.png    ├─ appflowy_cloud/worker/search
          (the root paths the web app asks for by absolute path: forwarded as they are)   ├─ gotrue  ├─ minio  ├─ redis
                                                                                          └─ postgres (pgvector, its own)
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

## Turn it on in the dash

`~/server-platform/homelab-dashboard.env`: `NOTES_UPSTREAM=http://127.0.0.1:8070`, then
`systemctl --user restart gold-dashboard`. Without it the Notes tab says "Not connected" and `/appflowy` is not served.
The stack's `.env` must say `FQDN=dash.xgold.tech/appflowy`, `SCHEME=https`, `WS_SCHEME=wss` (`install.sh` does);
after changing them run `./dc up -d`.

## Decisions and limits

- **Pinned, not `latest`.** Upstream's git tags stop at 0.9.64 (Jul 2025) while its Docker images are at 0.20.x, so the
  wiring is pinned by commit (`install.sh`) and the images by version (`.env`). Upgrade: change the versions in `.env`,
  `./dc up -d --no-build`, check `./dc ps`.
- **MinIO.** Upstream's `minio/minio` image no longer exists on Docker Hub or Quay; `pgsty/minio` is the community fork
  of the same server. It only listens inside the compose network (plus nginx's `/minio` paths, which are behind the dash login).
- **Sign-ups closed** (`GOTRUE_DISABLE_SIGNUP=true`), no e-mail is sent, AI and the admin console are off. To add a
  person: remove `profiles: [off]` from `admin_frontend`, `./dc up -d admin_frontend`, use `/console`, and set
  `GOTRUE_DISABLE_SIGNUP=false` only while inviting.
- **Same origin as the dash.** AppFlowy's pages run on `dash.xgold.tech`, so a script injected through a note could
  call the dash's API with the owner's session. Terminal and Directus writes still need the step-up code; the rest
  would not. Accepted by the owner (2026-11-10) to avoid a second hostname.
- **Root paths.** AppFlowy's web app cannot live under a sub-path, so `/app`, `/login`, `/static`, `/covers`,
  `/af_icons`, `/pdfjs` and three icon/image files belong to it on the dash's origin (`ROOT` in `notesProxy.ts`).
  A new AppFlowy release that asks for another absolute path shows as a 404 or a dash page inside the frame.
- **Native AppFlowy apps** cannot sign in through Cloudflare Access. Browser only.
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
