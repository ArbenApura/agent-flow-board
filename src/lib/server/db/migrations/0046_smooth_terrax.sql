CREATE TABLE "mockup_part" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"mockup_id" uuid,
	"version_number" integer,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"storage_key" text NOT NULL,
	"size" bigint NOT NULL,
	"checksum" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mockup_part" ADD CONSTRAINT "mockup_part_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_part" ADD CONSTRAINT "mockup_part_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_part" ADD CONSTRAINT "mockup_part_mockup_id_mockup_id_fk" FOREIGN KEY ("mockup_id") REFERENCES "public"."mockup"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mockup_part_version_idx" ON "mockup_part" USING btree ("mockup_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "mockup_part_key_uq" ON "mockup_part" USING btree ("storage_key");