ALTER TABLE "session" ADD COLUMN "code_edits_since_record" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "first_unrecorded_edit_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "nudged_level" integer DEFAULT 0 NOT NULL;