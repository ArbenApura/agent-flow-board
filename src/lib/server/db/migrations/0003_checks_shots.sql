ALTER TABLE "ui_shot_run" ALTER COLUMN "item_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "default_target" text DEFAULT 'preview' NOT NULL;--> statement-breakpoint
ALTER TABLE "check" ADD COLUMN "pinned_target" text;--> statement-breakpoint
ALTER TABLE "check_run" ADD COLUMN "requested_by" text;--> statement-breakpoint
ALTER TABLE "check_run" ADD COLUMN "requested_target" text;--> statement-breakpoint
ALTER TABLE "check_run" ADD COLUMN "step_key" text;--> statement-breakpoint
ALTER TABLE "check_run" ADD COLUMN "runner_id" uuid;--> statement-breakpoint
ALTER TABLE "check_run" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "check_run" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "check_run" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "check_run" ADD COLUMN "log" text;--> statement-breakpoint
ALTER TABLE "environment" ADD COLUMN "version_path" text;--> statement-breakpoint
ALTER TABLE "ui_shot_run" ADD COLUMN "kind" text DEFAULT 'shots' NOT NULL;--> statement-breakpoint
ALTER TABLE "ui_shot_run" ADD COLUMN "state" text DEFAULT 'queued' NOT NULL;--> statement-breakpoint
ALTER TABLE "ui_shot_run" ADD COLUMN "requested_by" text;--> statement-breakpoint
ALTER TABLE "ui_shot_run" ADD COLUMN "target" text;--> statement-breakpoint
ALTER TABLE "ui_shot_run" ADD COLUMN "changed_paths" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ui_shot_run" ADD COLUMN "foreign_paths" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ui_shot_run" ADD COLUMN "results" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ui_shot_run" ADD COLUMN "outside_calls" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ui_shot_run" ADD COLUMN "aborted_writes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ui_shot_run" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "ui_shot_run" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ui_shot_run" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "ui_shot_run_project_idx" ON "ui_shot_run" USING btree ("project_id","created_at");--> statement-breakpoint
ALTER TABLE "ui_shot_run" ADD CONSTRAINT "ui_shot_run_state_chk" CHECK ("ui_shot_run"."state" in ('queued', 'running', 'done', 'failed', 'timeout', 'unavailable'));