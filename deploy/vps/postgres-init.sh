#!/bin/sh
# Runs once, when the database folder is first made. Creates the roles the app needs (SPEC 6, ADR-021).
#   afb_owner   owns the database and runs migrations. It is not a superuser, so forced row level security binds it too.
#   afb_backup  reads and restores every organisation's rows. It bypasses row level security, so only backups use it.
# The app itself connects as app_runtime, which the migration step makes and gives a login.
# The passwords are put into SQL text, so use letters and digits only.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE afb_owner LOGIN CREATEROLE PASSWORD '${AFB_OWNER_PASSWORD}';
CREATE DATABASE afb OWNER afb_owner;
SQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname afb <<SQL
ALTER SCHEMA public OWNER TO afb_owner;
CREATE ROLE afb_backup LOGIN BYPASSRLS PASSWORD '${AFB_BACKUP_DB_PASSWORD}' IN ROLE afb_owner;
SQL
