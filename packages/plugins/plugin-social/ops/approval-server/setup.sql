-- Database role for the client approval service (run once, as the postgres superuser, AFTER plugin-social 0.8.0 is deployed:
-- its migration 015 creates the table). install.sh runs this for you:
--   { printf "\set approval_password '%s'\n" "$PASSWORD"; cat setup.sql; } | sudo -u postgres psql -d paperclip -X -v ON_ERROR_STOP=1 -f -
-- The role can read what the page shows and write only the answer columns of client_approvals. It cannot read posts,
-- accounts, tokens, secrets or anything else, and cannot create, delete or alter anything.

SELECT 'CREATE ROLE pib_approval LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pib_approval') \gexec
ALTER ROLE pib_approval WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'approval_password';

GRANT CONNECT ON DATABASE paperclip TO pib_approval;
GRANT USAGE ON SCHEMA plugin_social_e70c4e79f2 TO pib_approval;
REVOKE ALL ON ALL TABLES IN SCHEMA plugin_social_e70c4e79f2 FROM pib_approval;
GRANT SELECT (token_hash, status, snapshot, answered_by_name, answered_at, expires_at) ON plugin_social_e70c4e79f2.client_approvals TO pib_approval;
GRANT UPDATE (status, answered_by_name, answer_note, answered_at, notified_at) ON plugin_social_e70c4e79f2.client_approvals TO pib_approval;
