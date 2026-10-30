# Jellyfin social and Letterboxd integration — issue #16

Installed components:

- Jellyfin 10.11.9, pinned by image digest in plugins.lock.json. This is the minimum
  patch release required by current Jellyscribe. The previous server was 10.11.8.
- Jellyscribe 2.13.2.0: opted-in users' film watches/ratings to Letterboxd and TV
  watches to Serializd. Includes historical catch-up and future playback logging.
- StarTrack 1.8.1.0 (10.11/.NET 9 build): family star ratings, reviews, favorites,
  watchlists, diaries, member profiles and collaborative lists inside Jellyfin Web.

Upstream sources:
https://github.com/builtbyproxy/Jellyscribe
https://github.com/ZL154/jellyfin-plugin-startrack

## Family opt-in

Each person signs in to their own family Jellyfin account in a browser at
https://streaming.xgold.tech/web/#/jellyscribe and opens My accounts → Link a diary.
Use the Letterboxd username (not email) and password there. For TV, add a separate
Serializd diary. No credentials need to be shared with Carter or put in chat.

Enable the diary. Leave Only sync recently played OFF to include saved historical
watches. Leave Skip already-synced ON to avoid repeating successful exports. Save,
then use Sync now once for catch-up; subsequent watches sync in real time, with
scheduled catch-up as a safety net. Each user opts in independently; no Letterboxd
or Serializd account is created or linked by this installation.

Past-watch catch-up can only use history Jellyfin retained (typically a title's
last-played date); it cannot reconstruct every historical rewatch date. Titles
must match the external service through their TMDb metadata. External login/sync
cannot be verified until a member supplies their own account. Letterboxd may
challenge server logins; use the plugin's Verify login result and documented
cookie fallback if needed.

StarTrack's My Ratings entry is in Jellyfin Web. Its social controls do not appear
in native Roku/Android TV/iOS clients. Server-side watch logging still works for
playback on those clients. Account linking can always be done in the browser.

## Integration choices

Jellyscribe is the external-sync owner. StarTrack's separate Letterboxd and
External Sync buttons are hidden, and no StarTrack external accounts are linked,
to avoid two plugins posting the same watches. StarTrack's native rating mirror is
ON: a four-star StarTrack score becomes a native Jellyfin rating of 8, which
Jellyscribe can send to an opted-in Letterboxd account. StarTrack reviews stay in
the family social layer; Jellyscribe's own review form can post a review externally.

The existing File Transformation, Jellyfin Enhanced and Media Bar remain installed.
Enhanced user reviews were already off, so StarTrack supplies the review UI.
StarTrack poster badges use top-left to avoid Jellyfin's watched checkmark.
Jellyscribe telemetry is off. Seerr is unconfigured and automatic request approval
is off. No download automation or historical watch import is started server-wide.

The GitHub plugin manifests are registered for catalog visibility. Installed
versions have autoUpdate=false and release checksums in plugins.lock.json; update
explicitly after checking compatibility. Downloads come directly from the release
assets, with SHA-256 plus the upstream catalog checksum verified.

## Install / repeat / rollback

The live config is /home/gold/Jellyfin Server/config. Treat it as private: it
contains users, API tokens and any later encrypted external-account credentials.

1. Pull the pinned image from plugins.lock.json. Test it using a disposable copy
   of the config, separate loopback port, and a read-only media mount. Use SQLite
   backup APIs for consistent database snapshots while the live server is running.
2. Save the running image ID and compose file. Stop Jellyfin for the final private
   configuration snapshot. Copy the whole config (including databases and plugin
   encryption keys). Do not copy a staging database back to production.
3. Run `python3 install.py --config '/home/gold/Jellyfin Server/config' --artifacts
   /home/gold/server-platform/backup-private/jellyfin-social-artifacts` while stopped.
   It only installs the locked binaries and creates missing plugin configurations;
   it preserves existing account settings. Restart the existing compose service
   with the pinned image. Keep all media mounts/ports/user settings unchanged.
4. Run `python3 verify.py` (or --url http://127.0.0.1:8097 for the staged server).
   The verifier uses the private existing family-sync API credential and prints no
   users or secrets. Verify the non-admin account-link page in a browser as well.

Rollback: stop Jellyfin, restore the private pre-install configuration snapshot and
compose file, and recreate with the saved original image ID. Restore database and
plugin config together. Never point the old server at a database that has been
migrated by a newer major version. Media is not changed by this installation.

The initial rollout used a disposable non-admin account only in the cloned staging
server to check account linking, My Ratings, and a four-star → native 8/10 rating.
That account and test rating were not copied to the live server. No external
Letterboxd/Serializd credentials or API writes were used in verification.

## Known upstream limitation found during verification

StarTrack 1.8.1.0 declares an API model named RecommendationDto, colliding with
Jellyfin's own model of the same name. GET /api-docs/openapi.json returns HTTP 500
when Swagger generates the combined schema. The log identifies
InteractionsController+RecommendationDto versus MediaBrowser.Model.Dto.RecommendationDto.
This affects the generated API-documentation page; normal Jellyfin/plugin routes,
playback health, self-service accounts, and rating writes passed verification.
The installed binaries remain the checksum-verified upstream releases. Track a
compatible upstream fix rather than silently modifying DLLs. Do not close #16 as
fully end-to-end verified until a member has linked an external account and tested
a historical catch-up plus a new watch. No external credentials were supplied.

Live rollback snapshot: server-platform/backup-private/jellyfin-social-20261025T231158Z/.
It includes the stopped-state config, original compose file and original image ID
in before.json. Release archives and disposable staging files also remain private.
