ALTER TABLE "check" ADD COLUMN "title" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "check" SET "title" = left("manual_check"."text", 300) FROM "manual_check" WHERE "manual_check"."item_id" = "check"."item_id" AND "manual_check"."key" = "check"."manual_key";--> statement-breakpoint
ALTER TABLE "check" RENAME COLUMN "manual_key" TO "check_key";--> statement-breakpoint
DROP TABLE "manual_check" CASCADE;--> statement-breakpoint
ALTER TABLE "item" DROP COLUMN "open_manual";--> statement-breakpoint
UPDATE "item" SET "health" = jsonb_set("health", '{drift}', COALESCE("health"->'drift', '[]'::jsonb) || '["ready-for-sign-off"]'::jsonb) WHERE "status" = 'IN REVIEW' AND "legacy_percent" IS NULL AND "total_steps" > 0 AND "done_steps" = "total_steps" AND NOT (COALESCE("health"->'drift', '[]'::jsonb) ? 'ready-for-sign-off');
