-- Browser checks are removed (AFB-20261123-0936). Rows that would break the narrowed key constraint go first.
-- The attachment rows of old check runs (kind check-evidence) are left on purpose: the stored files behind them cannot be deleted from SQL,
-- so the owner runs `yarn server attachments purge-check-evidence` once, which deletes the files first and the rows second.
-- The owner is bound by forced row level security (the policies name only the runtime role), so the forcing is lifted for this delete and put back at once; secure() applies it again after the migration.
ALTER TABLE "connect_setup_mark" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DELETE FROM "connect_setup_mark" WHERE "key" = 'checks';--> statement-breakpoint
ALTER TABLE "connect_setup_mark" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bridge_approval" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bridge_signin_envelope" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "check" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "check_run" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "design_scale" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dev_registration" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "environment" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_data_key" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "runner" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "secret" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ui_change" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ui_shot_run" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "bridge_approval" CASCADE;--> statement-breakpoint
DROP TABLE "bridge_signin_envelope" CASCADE;--> statement-breakpoint
DROP TABLE "check" CASCADE;--> statement-breakpoint
DROP TABLE "check_run" CASCADE;--> statement-breakpoint
DROP TABLE "design_scale" CASCADE;--> statement-breakpoint
DROP TABLE "dev_registration" CASCADE;--> statement-breakpoint
DROP TABLE "environment" CASCADE;--> statement-breakpoint
DROP TABLE "org_data_key" CASCADE;--> statement-breakpoint
DROP TABLE "runner" CASCADE;--> statement-breakpoint
DROP TABLE "secret" CASCADE;--> statement-breakpoint
DROP TABLE "ui_change" CASCADE;--> statement-breakpoint
DROP TABLE "ui_shot_run" CASCADE;--> statement-breakpoint
ALTER TABLE "connect_setup_mark" DROP CONSTRAINT "connect_setup_mark_key_chk";--> statement-breakpoint
ALTER TABLE "project" DROP COLUMN "web_app";--> statement-breakpoint
ALTER TABLE "project" DROP COLUMN "reference_pages";--> statement-breakpoint
ALTER TABLE "user_pref" DROP COLUMN "check_target";--> statement-breakpoint
ALTER TABLE "step" DROP COLUMN "required_target";--> statement-breakpoint
ALTER TABLE "connect_setup_mark" ADD CONSTRAINT "connect_setup_mark_key_chk" CHECK ("connect_setup_mark"."key" in ('tools', 'skills', 'bridge', 'editor', 'token', 'panel'));