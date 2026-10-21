ALTER TABLE "runner" ADD COLUMN "audit_head" text;--> statement-breakpoint
ALTER TABLE "runner" ADD COLUMN "audit_lines" integer;--> statement-breakpoint
ALTER TABLE "runner" ADD COLUMN "audit_regressed_at" timestamp with time zone;