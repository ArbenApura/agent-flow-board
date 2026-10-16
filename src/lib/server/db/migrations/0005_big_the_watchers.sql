CREATE TABLE "org_deletion_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"org_name" text NOT NULL,
	"org_slug" text NOT NULL,
	"event" text NOT NULL,
	"actor_user_id" text,
	"actor_label" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_deletion_log_event_chk" CHECK ("org_deletion_log"."event" in ('deleted', 'restored', 'purged'))
);
--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "org" ADD COLUMN "purge_started_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "org_deletion_log_org_idx" ON "org_deletion_log" USING btree ("org_id");