-- Apply only after the website uses /family endpoints and the sync reads family_users.
BEGIN;
UPDATE kv SET data=data-'email'-'pin' WHERE coll='members' AND id LIKE 'claim-%';
CREATE OR REPLACE FUNCTION family_claim_retired() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.coll='members' AND NEW.id LIKE 'claim-%' THEN
  RAISE EXCEPTION 'Family registrations now use the family directory. Refresh the website.';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS family_claim_retired ON kv;
CREATE TRIGGER family_claim_retired BEFORE INSERT OR UPDATE ON kv FOR EACH ROW EXECUTE FUNCTION family_claim_retired();
COMMIT;
