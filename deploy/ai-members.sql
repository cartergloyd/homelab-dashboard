-- Customer accounts for the public site (xgold.tech), stored in the ai Directus database.
-- Sign-in is Google (docs/SSO.md): a first-time Google sign-in becomes a "Pending" user with no access;
-- the owner approves it in the dashboard (Access → People), which moves it to "Customer" or "Network admin".
-- Run once, as the Postgres superuser against database "ai", then restart homelab-directus-ai
-- (permissions are cached in-process). Safe to re-run:
--   docker exec -i gold-platform-postgres sh -c 'psql -U "$POSTGRES_USER" -d ai -v ON_ERROR_STOP=1' < deploy/ai-members.sql
--   docker restart homelab-directus-ai
-- The role names are what the dashboard looks for (server/src/services/directusRecords.ts, PEOPLE_ROLES).
BEGIN;

INSERT INTO directus_roles (id, name, icon, description) VALUES
  ('c0a1f1e0-0000-4000-8000-000000000001', 'Pending',       'hourglass_empty', 'Signed in on the website, waiting for approval. Sees nothing.'),
  ('c0a1f1e0-0000-4000-8000-000000000002', 'Customer',      'person',          'Approved customer: the private area of the website only.'),
  ('c0a1f1e0-0000-4000-8000-000000000003', 'Network admin', 'shield_person',   'Admin of the network: the private area of the website, plus the dash, AppFlowy and the CRM (those are gated by Cloudflare Access, see docs/SSO.md).')
ON CONFLICT (id) DO NOTHING;

-- No app access, no admin access: these accounts never see the Directus admin.
INSERT INTO directus_policies (id, name, icon, description, admin_access, app_access, enforce_tfa) VALUES
  ('c0a1f1e0-0000-4000-8000-000000000011', 'Signed-in self',  'badge', 'Read your own user and role name (the website asks who you are and whether you are approved).', false, false, false),
  ('c0a1f1e0-0000-4000-8000-000000000012', 'Members area',    'lock',  'Read the private items of the website.',                                                          false, false, false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO directus_access (id, role, policy)
SELECT gen_random_uuid(), v.r::uuid, v.p::uuid FROM (VALUES
  ('c0a1f1e0-0000-4000-8000-000000000001', 'c0a1f1e0-0000-4000-8000-000000000011'),
  ('c0a1f1e0-0000-4000-8000-000000000002', 'c0a1f1e0-0000-4000-8000-000000000011'),
  ('c0a1f1e0-0000-4000-8000-000000000003', 'c0a1f1e0-0000-4000-8000-000000000011'),
  ('c0a1f1e0-0000-4000-8000-000000000002', 'c0a1f1e0-0000-4000-8000-000000000012'),
  ('c0a1f1e0-0000-4000-8000-000000000003', 'c0a1f1e0-0000-4000-8000-000000000012')
) AS v(r, p)
WHERE NOT EXISTS (SELECT 1 FROM directus_access a WHERE a.role = v.r::uuid AND a.policy = v.p::uuid);

-- Private items for approved customers and network admins. Same shape idea as feed_items, never public.
CREATE TABLE IF NOT EXISTS members_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        varchar(100) NOT NULL UNIQUE,
  title       text         NOT NULL,
  summary     text         NOT NULL DEFAULT '',
  date        date         NOT NULL DEFAULT current_date,
  doc         jsonb        NOT NULL DEFAULT '{}',
  updated_at  timestamptz  NOT NULL DEFAULT now()
);
ALTER TABLE members_items OWNER TO ai;  -- Directus connects as role ai and only sees tables it can access
INSERT INTO directus_collections (collection, icon, note) VALUES ('members_items', 'lock', 'Private items for approved customers and network admins')
  ON CONFLICT DO NOTHING;

INSERT INTO directus_permissions (collection, action, permissions, fields, policy)
SELECT v.c, 'read', v.perm::json, v.f, 'c0a1f1e0-0000-4000-8000-000000000011'::uuid FROM (VALUES
  ('directus_users', '{"id":{"_eq":"$CURRENT_USER"}}', 'id,email,first_name,last_name,role'),
  ('directus_roles', '{"id":{"_eq":"$CURRENT_ROLE"}}', 'id,name')
) AS v(c, perm, f)
WHERE NOT EXISTS (SELECT 1 FROM directus_permissions p WHERE p.policy = 'c0a1f1e0-0000-4000-8000-000000000011' AND p.collection = v.c AND p.action = 'read');

INSERT INTO directus_permissions (collection, action, permissions, fields, policy)
SELECT 'members_items', 'read', '{}', '*', 'c0a1f1e0-0000-4000-8000-000000000012'
WHERE NOT EXISTS (SELECT 1 FROM directus_permissions p WHERE p.policy = 'c0a1f1e0-0000-4000-8000-000000000012' AND p.collection = 'members_items');

COMMIT;
