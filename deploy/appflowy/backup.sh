#!/usr/bin/env bash
# Nightly dump of AppFlowy's data: documents in Postgres (pg_dumpall, includes sign-in users) and
# uploads in MinIO. Keeps 7 days in ./backups. Cron: 50 3 * * *  <this folder>/backup.sh >> <this folder>/backups/backup.log 2>&1
# shortcut: local disk only and failures only reach backup.log; wire into the off-site receipt / hl-run when notes matter more.
set -euo pipefail
cd "$(dirname "$0")"
out=backups/$(date +%F); mkdir -p "$out"
./dc exec -T postgres sh -c 'pg_dumpall -U "$POSTGRES_USER"' | gzip > "$out/postgres.sql.gz.part"
docker run --rm -v homelab-notes_minio_data:/data:ro alpine tar czf - -C /data . > "$out/minio.tar.gz.part"
for f in postgres.sql.gz minio.tar.gz; do mv "$out/$f.part" "$out/$f"; done   # only complete files keep their real name
find backups -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} +
echo "$(date -Is) ok $(du -sh "$out" | cut -f1)"
