# Website feed uploads (Research and Solutions)

xGold AI → Storage → Directus (ai) → **Publish to website**. Choose a zip or a folder of items (`article.json` plus images and
videos). Each valid item is written to the `feed_items` table in the `ai` Directus and appears on xgold.tech's Research or
Solutions page immediately. The format guide is `content/README.md` in the website repo (ai.xgold.tech).

How it works:

- `POST /api/feed/publish` (owner auth, same as every `/api` route) unzips or takes the picked folder, validates each
  `article.json`, uploads referenced media to the ai Directus through the `Dashboard file uploads` service token into the
  "Published feed media" folder, rewrites those paths to `media:<file id>`, then creates or updates the item by section + slug.
  An item with a problem fails on its own with the reason; the others still publish. `GET /api/feed` lists items,
  `DELETE /api/feed/:id` removes one (its files stay in the library).
- The public site reads `feed_items` through Directus's public read permission and loads media from
  `https://ai-api.xgold.tech/feed-media/<id>`, served by the `directus-extension-feed-media` extension (website repo,
  `directus/extensions/`). This Directus build ignores filtered public file permissions, so the extension is what keeps
  everything outside the feed folder private.
- One-time setup: `deploy/ai-feed.sql` (table, public read, dashboard write), then restart `homelab-directus-ai`.
  Copy the extension into `/home/gold/server-platform/public-apps/ai/extensions/`.

Known limits: re-publishing a slug uploads its media again and leaves the old copies in the library. Drafts are not stored
(`"draft": true` skips the item). No file size cap.

Tests: `node server/test-feed.mjs` (zip and folder, rewriting, missing files, drafts, bad input).
