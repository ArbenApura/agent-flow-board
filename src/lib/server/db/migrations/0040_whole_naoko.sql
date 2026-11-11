CREATE TABLE "mockup_read" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"mockup_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"ranges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"html_length" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mockup_read_session_uq" UNIQUE("session_id","mockup_id","version_number")
);
--> statement-breakpoint
ALTER TABLE "mockup_read" ADD CONSTRAINT "mockup_read_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_read" ADD CONSTRAINT "mockup_read_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_read" ADD CONSTRAINT "mockup_read_mockup_id_mockup_id_fk" FOREIGN KEY ("mockup_id") REFERENCES "public"."mockup"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mockup_read_mockup_idx" ON "mockup_read" USING btree ("mockup_id","version_number");