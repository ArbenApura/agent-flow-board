ALTER TABLE "oauth_code" ADD COLUMN "resource" text;--> statement-breakpoint
ALTER TABLE "oauth_grant" ADD COLUMN "resource" text;