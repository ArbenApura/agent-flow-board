ALTER TABLE "item" DROP CONSTRAINT "item_status_chk";--> statement-breakpoint
UPDATE "item" SET "status" = 'IN REVIEW' WHERE "status" = 'TESTING';--> statement-breakpoint
ALTER TABLE "item" ADD CONSTRAINT "item_status_chk" CHECK ("item"."status" in ('PLANNED', 'IN PROGRESS', 'IN REVIEW', 'ON HOLD', 'COMPLETED', 'REMOVED'));
