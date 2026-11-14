CREATE TABLE "dev_registration" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"dev_url" text NOT NULL,
	"profiles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active_profile" text,
	"last_status" text DEFAULT 'unknown' NOT NULL,
	"last_reason_code" text,
	"last_fix_line" text,
	"last_checked_at" timestamp with time zone,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "dev_registration_project_name_uq" UNIQUE("project_id","name"),
	CONSTRAINT "dev_registration_status_chk" CHECK ("dev_registration"."last_status" in ('unknown', 'reachable', 'unreachable', 'error'))
);
--> statement-breakpoint
ALTER TABLE "bridge_approval" DROP CONSTRAINT "bridge_approval_action_chk";--> statement-breakpoint
ALTER TABLE "dev_registration" ADD CONSTRAINT "dev_registration_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dev_registration" ADD CONSTRAINT "dev_registration_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dev_registration_org_idx" ON "dev_registration" USING btree ("org_id","project_id");--> statement-breakpoint
ALTER TABLE "bridge_approval" ADD CONSTRAINT "bridge_approval_action_chk" CHECK ("bridge_approval"."action" in ('register', 'secrets', 'adopt-env', 'roots', 'pictures', 'login', 'dev'));