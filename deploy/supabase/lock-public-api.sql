-- SUPABASE ONLY: CLOSE THE PROJECT'S OWN REST API TO THE BOARD'S TABLES. RUN AS THE postgres ROLE AFTER `yarn db migrate`.
-- Supabase grants anon, authenticated and service_role full access to every new table in public, and its REST API (PostgREST)
-- serves them with the public anon key. The board reaches the database only as app_runtime (through Hyperdrive), never through that API,
-- and some tables (users, sessions, accounts) have no row level security, so those grants have to go. Safe to run again.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated, service_role;
REVOKE USAGE ON SCHEMA public FROM anon, authenticated;
-- Tables, sequences and functions the owner makes later (the next migrations) must not get the grants back
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated, service_role;
