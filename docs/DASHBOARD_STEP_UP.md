# Dashboard authenticator confirmation

Open **Security** in the dashboard, select **Set up authenticator**, scan the QR code, and confirm a six-digit code. Save the eight recovery codes in a password manager. They are shown once; each code works once. The dashboard never asks for these secrets or codes in chat.

Enrollment activates protection immediately. Until the first owner enrolls, this feature is installed but not enforced. When any owner is enrolled, other authorized owners must enroll before taking protected actions. Each confirmation authorizes only the exact requested method, URL and JSON body, once, for one minute, in that signed-in browser session. A consumed authenticator code cannot be reused; wait for the next 30-second code for another confirmation. Prompts expire after two minutes.

Protected operations include Minecraft stop/restart and non-read-only console commands, deleting backups or files, moving/renaming files, restarting Jellyfin, changing/running maintenance jobs, running scripts, launching assistant tasks, editing shared instructions, approving instruction changes or risky agent requests, and changing assistant/security settings. Read-only browsing, adding torrent links, denying approvals and stopping the assistant remain available without an extra code. Configured scheduled jobs continue unattended; creating/changing their schedule requires confirmation.

The shared dashboard key cannot enroll an authenticator, change security settings, or decide an approval. Once protection is active, protected agent API requests require owner approval even if the older assistant approval toggle was off. The approval is bound to the exact request, and the owner must confirm that approval with their own authenticator/recovery code. A granted approval is consumed once. Agent action replay with changed parameters requires a new approval.

Tailscale sessions require confirmation by default. An enrolled owner may enable the Tailscale exemption on Security after a fresh confirmation. This never exempts Cloudflare sessions, security changes, or unenrolled owners. Replacing recovery codes, disabling/replacing the authenticator, and changing the exemption require a code. If the authenticator is lost, a recovery code can confirm disabling it, after which the owner can enroll a replacement.

## Persistence and recovery

`DATA_DIR/step-up.json` contains encrypted TOTP secrets, SHA-256 hashes of high-entropy recovery codes, counters that prevent OTP replay, and policy settings. `DATA_DIR/step-up.key` is the random AES-256-GCM encryption key. Both files are 0600. Browser session identifiers use a Secure, HttpOnly, SameSite=Strict host-only cookie; confirmation permits stay in memory and expire. Codes, QR secrets, JWTs and permits are never written into the alert feed. Enrollment, failed/successful verification and security-setting changes are recorded.

Back up **both files together** in encrypted backups. On this server, the encrypted OneDrive backup job includes `dashboard-security.tar.gpg` once enrollment creates `step-up.json`; it is encrypted using the separate database recovery key already saved off-server. Restore the pair to `DATA_DIR` with 0600 permissions before starting the dashboard. An existing state file with a missing/wrong key, corrupt state, or a failed security-state save does not silently disable protection.

The Security page is the normal recovery path. Do not ask the owner to share QR codes, setup keys, current OTPs or recovery codes with an agent. If all factors and recovery codes are lost, recovery requires trusted local server access and a deliberate security reset; do not reset it automatically from a chat request or weaken Access authentication.

## Verification

`npm run build && npm test` includes isolated tests for encryption, recovery-code hashing/consumption, OTP replay/rate limits, challenge and permit expiration, session/action binding, CSRF rejection, route coverage, agent bypass attempts and browser retry behavior. No real destructive operation is executed by these tests. `audit:install` checks enrollment and that the dashboard key cannot enroll a factor. A remote installation remains incomplete until the owner enrolls.
