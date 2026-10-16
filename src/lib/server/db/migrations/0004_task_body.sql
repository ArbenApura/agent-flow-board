ALTER TABLE "task" DROP CONSTRAINT "task_status_chk";--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "body" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "group_name" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "priority" text;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_status_chk" CHECK ("task"."status" in ('TODO', 'IN PROGRESS', 'DONE', 'DROPPED', 'FUTURE'));