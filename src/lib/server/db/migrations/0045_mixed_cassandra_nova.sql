ALTER TABLE "project" ADD COLUMN "screen_globs" text[] DEFAULT ARRAY['**/*.svelte','**/*.tsx','**/*.vue','**/*.css','**/routes/**','**/components/**']::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "visual_evidence_gate" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "item" ADD COLUMN "slice_gate" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "step" ADD COLUMN "visible" boolean;--> statement-breakpoint
ALTER TABLE "step" ADD COLUMN "visible_inferred" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "step" ADD COLUMN "files" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "step" ADD COLUMN "screens" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "step" ADD COLUMN "widths" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "mockup_version" ADD COLUMN "screens" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "mockup_version" ADD COLUMN "derived" jsonb;