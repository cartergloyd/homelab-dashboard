# Shared family user directory

Source for fam.xgold.tech and Jellyfin: fam.family_users. Initial import:
22 people, 17 assigned photos, four ready email/PIN records and 18 invitations.
The private import script and source CSV live outside this repository at
/home/gold/server-platform/family-directory/import_users.py and
/home/gold/server-platform/users.csv. Never commit CSV contents or exports.

schema.sql is idempotent. It creates the private collection, metadata and a PIN
trigger. Admins enter a four-digit PIN via the masked pin field; PostgreSQL hashes
it with its original salt name and clears the plain-text input. A name edit keeps
that salt until a new PIN is supplied. Blank PINs retain the existing hash. Public
Directus collection permissions are deliberately absent.

Copy directus-extension-family-directory into fam's mounted extensions directory
and restart only that Directus container to load it. The extension supplies public
profile/photo endpoints plus exact-email lookup and rate-limited PIN login and
registration. Only public profile fields are serialized. Signup atomically
updates an invited, unclaimed row, preventing concurrent claims and duplicate
emails. It cannot edit an existing user's name, status, photo or group through
request field injection. Emails/PIN hashes/Jellyfin IDs stay in private records.

The website's family-directory.js loads the roster and sends credentials to these
endpoints over HTTPS; index.html no longer embeds a name/photo roster or checks
public PIN hashes. The fantasy page maps roster names/photos to Sleeper teams by
the directory's fantasy_team field, while retaining Sleeper scores and statistics.
Trip records remain in their existing collections and keep their existing shared
public access model. Local browser identity is not server trip-data authorization.

fam-jellyfin-sync.timer now reads family_users every minute and synchronizes
registered users' PINs, names/emails, disabled status and profile photos. It records
stable Jellyfin IDs to preserve watch history. Invited users wait for an email and
PIN. The separate Jellyfin administrator is excluded. Sync source/state and its
operations guide are in /home/gold/server-platform/fam-jellyfin-sync/.

After deploying and verifying the website, apply retire-legacy-claims.sql. It
removes email/PIN hashes from legacy public kv claims and rejects new writes to
those obsolete paths. Existing trip records are not renamed or deleted. Private
pre-migration rollback dump: backup-private/family-directory-before.dump.

Profiles missing an image show their initial. Original uploads remain in Personal;
17 matched images were copied to fam so fam files and users share a database.
Original group memberships were preserved for exact matching names. CSV names
Pat, Andrew, Rick, Dan, Cheryl, Sam and Tim are their own records; no speculative
identity matching or renaming of historical trip documents was performed.

Verification passed: 22 public profiles, 17 assigned image responses, CORS, private
collection denial, four existing PIN logins, registration race/duplicate-email
handling, server validation and disabled users. Live published-site browser QA showed 18 unregistered choices, loaded the
assigned photo and signed in Carter without JavaScript errors. Jellyfin verifies four retained IDs with profile images.
Temporary test profiles were removed; no accounts were created for blank emails.

Published fantasy-page browser verification also passed: all ten fantasy owners
resolve to directory names, with all seven available owner photos. Matching
normalizes leading articles and permits a unique one-letter spelling difference
to reconcile the supplied CSV with current Sleeper display names.
