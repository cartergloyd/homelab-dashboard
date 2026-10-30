-- Apply as the cluster administrator. Existing sessions pick up role defaults
-- when their pools reconnect. Backup/maintenance administrator is unaffected.
ALTER ROLE fam NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE ai NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE fam SET statement_timeout = '60s';
ALTER ROLE ai SET statement_timeout = '60s';
ALTER ROLE fam SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE ai SET idle_in_transaction_session_timeout = '60s';
REVOKE ALL ON DATABASE fam FROM PUBLIC;
REVOKE ALL ON DATABASE ai FROM PUBLIC;
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE gold_platform FROM PUBLIC;
ALTER SYSTEM SET password_encryption = 'scram-sha-256';
ALTER SYSTEM SET log_connections = 'on';
SELECT pg_reload_conf();
