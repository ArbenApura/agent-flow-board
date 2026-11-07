ALTER TABLE "mockup_pin" ADD COLUMN "device" text;--> statement-breakpoint
ALTER TABLE "mockup_pin" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mockup_pin" ADD COLUMN "resolved_by" text;