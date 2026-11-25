ALTER TABLE "screen_annotation" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "screen_annotation" CASCADE;--> statement-breakpoint
ALTER TABLE "qa_result" DROP CONSTRAINT IF EXISTS "qa_result_annotation_id_screen_annotation_id_fk";
--> statement-breakpoint
ALTER TABLE "qa_result" DROP COLUMN "annotation_id";