# Installation and Real-Server Integration Improvements

These notes come from installing the dashboard on a live server that already had
Jellyfin, Minecraft, qBittorrent, Directus/PostgreSQL, systemd user services, and
existing Minecraft maintenance scripts.

## Problems Found During Install

1. Demo or placeholder state can leak into a real install.
   - `data/jobs.json` can preserve seeded jobs such as `Nightly world backup` and
     `Daily restart`.
   - The UI can look connected while still showing old placeholder jobs.
   - A real install should make demo data impossible to mistake for production
     data.

2. Backup discovery assumed the dashboard's built-in archive format.
   - The live server stores backups as dated directories:
     `mcworld_YYYY_MM_DD/world.tar.gz`.
   - The dashboard originally only listed `mc-YYYYMMDD-HHMMSS.tar.gz` files from
     `BACKUP_DIR`.
   - This made the World backups panel show one incorrect dashboard-created file
     instead of the existing backup history.

3. Existing maintenance scripts were not auto-discovered.
   - `SCRIPTS_DIR` defaulted to `/opt/homelab-scripts`.
   - The actual scripts lived at `/home/gold/Minecraft Server/scripts`.
   - The scripts page silently looked empty until the env was corrected.

4. Existing systemd timers were not mirrored automatically.
   - The live server had:
     - `minecraft-fetch.timer`: Monday/Thursday 01:00
     - `minecraft-maintenance.timer`: Monday/Thursday 04:00
   - The dashboard still showed placeholder schedule data until `jobs.json` was
     replaced manually.

5. `hl-run` integration is too manual.
   - External jobs only become truly useful when their systemd services are
     wrapped with `scripts/hl-run.sh`.
   - The installer should either perform that wiring or clearly report that
     external job output is not yet connected.

## Requested Improvements

1. Add a production install audit command.
   - Example: `npm run audit:install` or `node scripts/audit-install.js`.
   - It should print each configured service, path, timer, and data source.
   - It should clearly flag placeholders, missing paths, missing scripts, and
     demo data still present in `DATA_DIR`.

2. Add a first-run production wizard or importer.
   - Discover common systemd user services and timers for Minecraft.
   - Discover existing Minecraft script folders.
   - Discover backup roots and supported backup formats.
   - Offer to create external mirrored jobs from real timers instead of seeding
     generic backup/restart jobs.

3. Make demo state opt-in only.
   - Never seed enabled demo jobs in a non-demo install.
   - Label placeholder jobs loudly in the UI if they exist.
   - Provide a `clear-demo-data` command that removes seeded jobs and demo runs
     without touching real user data.

4. Support multiple backup formats.
   - Single-file format: `mc-YYYYMMDD-HHMMSS.tar.gz`.
   - Folder format: `mcworld_YYYY_MM_DD/*.tar.gz`.
   - Show the backup source path in the UI.
   - If a backup entry has no matching real files, show it as invalid or stale.

5. Improve `Back up now`.
   - If the configured server uses folder-style backups, create the same folder
     shape instead of creating a separate dashboard-only archive format.
   - Or allow the button to run the existing configured backup script.

6. Make external job wiring safer.
   - Provide a helper that wraps existing systemd `ExecStart` commands with
     `hl-run.sh`.
   - Verify `HOMELAB_URL` and `HOMELAB_KEY` by sending a test event.
   - Confirm that the dashboard can receive script output before marking the job
     as fully connected.

7. Handle paths with spaces consistently.
   - Env examples and generated systemd snippets should quote paths like
     `/home/gold/Minecraft Server`.
   - Shell examples should use a dedicated small env file for `hl-run` secrets
     instead of sourcing the full dashboard env.

## Acceptance Criteria

- A live install cannot show demo jobs without an explicit `DEMO=1`.
- The dashboard can list existing backup history before any new dashboard backup
  is created.
- The scripts page shows the real script folder or displays a loud configuration
  error with the path it tried.
- Mirrored external jobs show the real timer name, real schedule, and whether
  output reporting is connected.
- The installer reports "fully connected" only after status, jobs, scripts,
  backups, and alerts ingestion all pass verification.
