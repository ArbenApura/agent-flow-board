ALTER TABLE "check" ADD COLUMN "registration" text;--> statement-breakpoint
ALTER TABLE "check_run" ADD COLUMN "registration" text;--> statement-breakpoint
ALTER TABLE "check_run" ADD COLUMN "ran_registration" text;--> statement-breakpoint
ALTER TABLE "check_run" ADD COLUMN "ran_repo" text;--> statement-breakpoint
ALTER TABLE "check_run" ADD COLUMN "ran_branch" text;--> statement-breakpoint
ALTER TABLE "runner" ADD COLUMN "registrations" jsonb;