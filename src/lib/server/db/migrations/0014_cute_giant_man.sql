ALTER TABLE "runner" DROP CONSTRAINT "runner_kind_chk";--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "advanced_checks" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "runner" ADD CONSTRAINT "runner_kind_chk" CHECK ("runner"."kind" in ('local', 'hosted', 'tool'));