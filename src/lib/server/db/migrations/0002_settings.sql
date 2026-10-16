ALTER TABLE "org" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "reference_pages" text[] DEFAULT '{}'::text[] NOT NULL;