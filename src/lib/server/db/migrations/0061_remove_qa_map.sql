-- The QA map is removed (AFB-20261127-0438) and its data is dropped (the owner's call). Each QA run was an ordinary plan item
-- (tab name QA_RUN), so those items go to the trash first, while qa_run still says which they are; the trash keeps them restorable.
-- The owner is bound by forced row level security (the policies name only the runtime role), so the forcing is lifted for this update and put back at once; secure() applies it again after the migration.
-- qa_run is forced too on a database that had the QA map, and the subselect reads it as the owner, so its forcing is lifted as well (it is dropped below).
ALTER TABLE "item" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "qa_run" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "item" SET "deleted_at" = now(), "deleted_by" = 'migration 0061_remove_qa_map' WHERE "deleted_at" IS NULL AND "id" IN (SELECT "item_id" FROM "qa_run");--> statement-breakpoint
ALTER TABLE "item" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "qa_bug" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "qa_feature" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "qa_plan_feature" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "qa_result" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "qa_run" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "qa_settings" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "qa_bug" CASCADE;--> statement-breakpoint
DROP TABLE "qa_feature" CASCADE;--> statement-breakpoint
DROP TABLE "qa_plan_feature" CASCADE;--> statement-breakpoint
DROP TABLE "qa_result" CASCADE;--> statement-breakpoint
DROP TABLE "qa_run" CASCADE;--> statement-breakpoint
DROP TABLE "qa_settings" CASCADE;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "testing_since" timestamp with time zone DEFAULT now() NOT NULL;