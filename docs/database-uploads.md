# Database page file uploads

The Database page has a Files & images panel. Choose Personal, fam or ai, then
Upload files / images. Multiple selected files upload sequentially, with a 25 MB
limit per file. Partial successes remain visible if a later upload fails. The
panel lists the latest 30 files in the chosen Directus library and offers image
previews and downloads. File uploads do not assign a family/Jellyfin avatar.

Files go through Directus `/files`; metadata is in its `directus_files` table and
contents use its configured storage adapter. Directus Studio can manage the
uploaded files. Each target remains independent. Twenty CRM is not a Directus
file library and is not offered as an upload target.

The dashboard's existing owner authentication covers upload, list, preview and
download endpoints under `/api/database/files`. No public file permissions were
added. Non-raster formats (including SVG/HTML) download as attachments with
nosniff/sandbox headers. Raster formats can preview inline. Directus credentials
never reach the browser, URLs, response errors or action logs.

Server provisioning uses DATA_DIR/database-uploads.json (owner-only 0600), a JSON
object mapping target IDs (`personal`, `fam`, `ai`) to static service-user tokens.
Targets/URLs come only from dashboard configuration. No URL supplied by a browser
is fetched. A missing token disables that target's uploads in the UI. Keep this
secret file with private operational backups, never in the repository.

Each Directus project has a `dashboard-uploads@internal.invalid` service user and
`Dashboard file uploads` policy. This policy grants create/read on directus_files
only, with no administrator access or application login. The installed Directus
version does not support filtered read permissions, so read covers its file
library, which is visible only through the authenticated dashboard. Existing
anonymous data-collection policies are unchanged. Existing administrators can
manage the uploaded files in Studio. Changes made directly to permissions SQL
require refreshing Directus's in-process permission cache.

Tests: `npm run build`, `node server/test-database-files.mjs`, plus existing HTTP
security/client checks. The upload tests cover target allowlisting, authentication
boundaries, secret omission, multipart forwarding, oversized/empty input, SVG
attachment handling and upstream errors.

Personal uploads are persisted at /home/gold/server-platform/directus/uploads,
mounted at /directus/uploads in the personal Directus container. Existing files
were copied before mounting; verification confirmed they survive recreation.
Database dumps contain metadata only; include upload storage in file backups.

Live verification passed for document/image uploads, listing, exact download
bytes and image previews in all three targets. Anonymous requests were rejected.
All six temporary verification files were removed after testing.

## Redesigned AI workspace upload action

In xGold AI → Files, the Directus panel's Upload files action opens the private
library and the system file chooser in one click. It uses the selected Directus
instance (AI by default in the business workspace). Files opens the same library
without opening the chooser. The chooser waits until that target's private upload
service is ready and opens only once per drawer visit. The underlying owner-only
upload service and 25 MB limit are unchanged.

The browser regression checks that the action opens a chooser, posts multipart
file content to the AI target, and that browsing the library does not trigger a
chooser. Live document/image uploads, exact downloads and inline image previews
are verified during deployment; synthetic verification files are removed afterward.
