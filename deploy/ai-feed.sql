-- Research / Solutions feed for the public site (ai.xgold.tech), stored in the ai Directus database.
-- Run once, as the Postgres superuser against database "ai", then restart homelab-directus-ai
-- (permissions are cached in-process):
--   docker exec -i gold-platform-postgres sh -c 'psql -U "$POSTGRES_USER" -d ai -v ON_ERROR_STOP=1' < deploy/ai-feed.sql
--   docker restart homelab-directus-ai
-- The folder id below is also FEED_FOLDER in server/src/services/feed.ts and in the feed-media extension.

CREATE TABLE IF NOT EXISTS feed_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section     varchar(20)  NOT NULL CHECK (section IN ('research','solutions')),
  slug        varchar(100) NOT NULL,
  title       text         NOT NULL,
  summary     text         NOT NULL,
  date        date         NOT NULL,
  card        jsonb        NOT NULL DEFAULT '{}',  -- the few fields a feed card needs (type, area, status, cover, hero_stat)
  doc         jsonb        NOT NULL,   -- the whole article.json, media paths already rewritten to Directus asset ids
  updated_at  timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (section, slug)
);
ALTER TABLE feed_items OWNER TO ai;  -- Directus connects as role ai and only sees tables it can access
INSERT INTO directus_collections (collection, icon, note) VALUES ('feed_items', 'article', 'Research and Solutions feed, filled by the dashboard Publish card')
  ON CONFLICT DO NOTHING;
INSERT INTO directus_folders (id, name) VALUES ('bafa863f-798e-4f4c-a8f6-616768988dcf', 'Published feed media') ON CONFLICT DO NOTHING;

-- Public site: read the feed. Media is served by the feed-media Directus extension (public filtered
-- file permissions do not work in this Directus build), so no public file permission is added.
INSERT INTO directus_permissions (collection, action, permissions, fields, policy) VALUES
  ('feed_items', 'read', '{}', '*', 'abf8a154-5b1c-4a46-ac9c-7300570f4f17');

-- Dashboard "Dashboard file uploads" service user: write feed items.
INSERT INTO directus_permissions (collection, action, permissions, fields, policy) VALUES
  ('feed_items', 'create', '{}', '*', '114268bc-2127-4a05-85ac-b24629a355f2'),
  ('feed_items', 'read',   '{}', '*', '114268bc-2127-4a05-85ac-b24629a355f2'),
  ('feed_items', 'update', '{}', '*', '114268bc-2127-4a05-85ac-b24629a355f2'),
  ('feed_items', 'delete', '{}', '*', '114268bc-2127-4a05-85ac-b24629a355f2');
