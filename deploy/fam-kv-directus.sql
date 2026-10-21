-- Register the imported document table using its database owner. This avoids
-- disabling administrator MFA or issuing an administrator static API token.
-- Preserves the site's existing anonymous access to exactly seven document colls.
BEGIN;
DO $$ BEGIN
  IF (SELECT count(*) FROM directus_policies WHERE name='$t:public_label') <> 1
  THEN RAISE EXCEPTION 'Expected exactly one Public policy'; END IF;
  IF EXISTS (SELECT 1 FROM kv WHERE coll NOT IN ('plans','bedrooms','flights','members','progress','meals','groceries'))
  THEN RAISE EXCEPTION 'Unexpected collection in migration'; END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='kv'::regclass AND conname='kv_family_collections') THEN
    ALTER TABLE kv ADD CONSTRAINT kv_family_collections CHECK (coll IN ('plans','bedrooms','flights','members','progress','meals','groceries'));
  END IF;
END $$;
CREATE OR REPLACE FUNCTION kv_immutable_document_path() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.key IS DISTINCT FROM OLD.key OR NEW.coll IS DISTINCT FROM OLD.coll OR NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Document paths are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS kv_immutable_document_path ON kv;
CREATE TRIGGER kv_immutable_document_path BEFORE UPDATE ON kv FOR EACH ROW EXECUTE FUNCTION kv_immutable_document_path();
INSERT INTO directus_collections(collection,icon,note,display_template)
VALUES ('kv','inventory_2','Family site documents; key = coll/id','{{key}}')
ON CONFLICT(collection) DO UPDATE SET icon=EXCLUDED.icon,note=EXCLUDED.note,display_template=EXCLUDED.display_template;
INSERT INTO directus_fields(collection,field,interface,options,sort,width,note)
SELECT 'kv',field,interface,options::json,sort,width,note FROM (VALUES
 ('key','input',NULL,1,'full','Document path: coll/id'),
 ('coll','select-dropdown','{"choices":[{"text":"plans","value":"plans"},{"text":"bedrooms","value":"bedrooms"},{"text":"flights","value":"flights"},{"text":"members","value":"members"},{"text":"progress","value":"progress"},{"text":"meals","value":"meals"},{"text":"groceries","value":"groceries"}]}',2,'half',NULL),
 ('id','input',NULL,3,'half',NULL),
 ('data','input-code','{"language":"json"}',4,'full',NULL)
) AS f(field,interface,options,sort,width,note)
WHERE NOT EXISTS(SELECT 1 FROM directus_fields d WHERE d.collection='kv' AND d.field=f.field);
-- This Directus build supports collection-wide permissions. The constraints and
-- trigger above enforce the seven colls and immutable paths in PostgreSQL.
DELETE FROM directus_permissions WHERE collection='kv' AND policy=(SELECT id FROM directus_policies WHERE name='$t:public_label');
INSERT INTO directus_permissions(policy,collection,action,fields,permissions,validation)
SELECT p.id,'kv',a.action,'*',NULL,NULL
FROM directus_policies p CROSS JOIN (VALUES ('read'),('create'),('update'),('delete')) a(action)
WHERE p.name='$t:public_label';
COMMIT;
