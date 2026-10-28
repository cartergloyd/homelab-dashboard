BEGIN;
CREATE TABLE IF NOT EXISTS family_users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 80),
 email text UNIQUE CHECK (email IS NULL OR email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
 pin varchar(4),
 pin_hash text CHECK (pin_hash IS NULL OR pin_hash ~ '^[a-f0-9]{64}$'),
 pin_salt_name text,
 status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','ready','disabled')),
 photo uuid REFERENCES directus_files(id) ON DELETE SET NULL,
 fantasy_team text,
 group_id text,
 jellyfin_user_id text UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION family_user_prepare() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.name := trim(NEW.name);
 NEW.email := nullif(lower(trim(NEW.email)), '');
 IF NEW.pin IS NOT NULL AND NEW.pin <> '' THEN
  IF NEW.pin !~ '^[0-9]{4}$' THEN RAISE EXCEPTION 'PIN must contain exactly four digits'; END IF;
  NEW.pin_hash := encode(sha256(convert_to('destin|' || NEW.name || '|' || NEW.pin,'UTF8')),'hex');
  NEW.pin_salt_name := NEW.name;
 END IF;
 NEW.pin := NULL;
 NEW.updated_at := now();
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS family_user_prepare ON family_users;
CREATE TRIGGER family_user_prepare BEFORE INSERT OR UPDATE ON family_users FOR EACH ROW EXECUTE FUNCTION family_user_prepare();
ALTER TABLE family_users OWNER TO fam;
ALTER TABLE family_users ALTER COLUMN id SET DEFAULT gen_random_uuid();
INSERT INTO directus_collections(collection,icon,note,display_template) VALUES
 ('family_users','group','Shared family website and Jellyfin directory. Blank email/PIN means not registered yet.','{{name}}') ON CONFLICT(collection) DO NOTHING;
INSERT INTO directus_fields(collection,field,interface,hidden,readonly,note,sort)
SELECT v.* FROM (VALUES
 ('family_users','id','input',true,true,NULL,1),
 ('family_users','name','input',false,false,NULL,2),
 ('family_users','photo','file-image',false,false,'Profile photo used by the website and Jellyfin.',3),
 ('family_users','email','input',false,false,'Email is the website and Jellyfin username.',4),
 ('family_users','pin','input',false,false,'Enter four digits to change the PIN; blank keeps the existing PIN. Never stored in plain text.',5),
 ('family_users','pin_hash','input',true,true,NULL,6),
 ('family_users','pin_salt_name','input',true,true,NULL,7),
 ('family_users','status','select-dropdown',false,false,'invited: unregistered; ready: registered; disabled: no sign-in.',8),
 ('family_users','fantasy_team','input',false,false,NULL,9),
 ('family_users','group_id','input',false,false,'People with the same group can manage each other’s trip plans.',10),
 ('family_users','jellyfin_user_id','input',false,true,'Maintained by the Jellyfin sync; preserves watch history across email changes.',11),
 ('family_users','created_at','datetime',false,true,NULL,12),
 ('family_users','updated_at','datetime',false,true,NULL,13)
) AS v(collection,field,interface,hidden,readonly,note,sort)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields d WHERE d.collection=v.collection AND d.field=v.field);
UPDATE directus_fields SET options='{"masked":true}' WHERE collection='family_users' AND field='pin';
UPDATE directus_fields SET options='{"choices":[{"text":"Invited","value":"invited"},{"text":"Ready","value":"ready"},{"text":"Disabled","value":"disabled"}]}' WHERE collection='family_users' AND field='status';
UPDATE directus_fields SET special='file' WHERE collection='family_users' AND field='photo';
INSERT INTO directus_relations(many_collection,many_field,one_collection) SELECT 'family_users','photo','directus_files' WHERE NOT EXISTS (SELECT 1 FROM directus_relations WHERE many_collection='family_users' AND many_field='photo');
COMMIT;

UPDATE directus_fields SET special='uuid' WHERE collection='family_users' AND field='id';
UPDATE directus_fields SET required=true WHERE collection='family_users' AND field='name';
