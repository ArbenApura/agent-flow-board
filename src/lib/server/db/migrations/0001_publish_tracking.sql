CREATE TABLE "github_installation" (
	"installation_id" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"account" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commit_link" ADD COLUMN "author_email" text;--> statement-breakpoint
ALTER TABLE "commit_link" ADD COLUMN "branch" text;--> statement-breakpoint
ALTER TABLE "commit_link" ADD COLUMN "committed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "code_touched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "last_record_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "notices" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "github_link" ADD COLUMN "path" text DEFAULT 'board' NOT NULL;--> statement-breakpoint
ALTER TABLE "github_link" ADD COLUMN "failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "publish_run" ADD COLUMN "trigger" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "publish_run" ADD COLUMN "requested_by" text;--> statement-breakpoint
ALTER TABLE "publish_run" ADD COLUMN "repo" text;--> statement-breakpoint
ALTER TABLE "publish_run" ADD COLUMN "attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "publish_run" ADD COLUMN "hashes" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "publish_run" ADD COLUMN "file_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "publish_run" ADD COLUMN "last_event_id" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "publish_run" ADD COLUMN "message" text;--> statement-breakpoint
ALTER TABLE "github_installation" ADD CONSTRAINT "github_installation_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_external_uq" ON "session" USING btree ("org_id","user_id","tool","external_id") WHERE "session"."external_id" is not null;