ALTER TABLE "skill" ADD COLUMN "files" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_revision" ADD COLUMN "files" jsonb DEFAULT '[]'::jsonb NOT NULL;