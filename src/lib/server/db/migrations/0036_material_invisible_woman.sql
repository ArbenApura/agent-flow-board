CREATE TABLE "mockup" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"item_id" uuid,
	"title" text NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"visibility" text DEFAULT 'public' NOT NULL,
	"public_enabled" boolean DEFAULT false NOT NULL,
	"public_token_hash" text,
	"trashed_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "mockup_visibility_chk" CHECK ("mockup"."visibility" in ('public', 'private'))
);
--> statement-breakpoint
CREATE TABLE "mockup_kit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"storage_key" text NOT NULL,
	"size" bigint NOT NULL,
	"built_from_commit" text DEFAULT '' NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"stale" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_by_label" text,
	CONSTRAINT "mockup_kit_project_number_uq" UNIQUE("project_id","number")
);
--> statement-breakpoint
CREATE TABLE "mockup_pin" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"mockup_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"x" real NOT NULL,
	"y" real NOT NULL,
	"hint" text DEFAULT '' NOT NULL,
	"body" text NOT NULL,
	"author_id" text,
	"author" text DEFAULT '' NOT NULL,
	"untrusted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mockup_project" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"style" text DEFAULT '' NOT NULL,
	"screens" text[] NOT NULL,
	"themes" text[] NOT NULL,
	"updated_by" text,
	"updated_by_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mockup_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prompt" text DEFAULT '' NOT NULL,
	"updated_by" text,
	"updated_by_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mockup_template_project_name_uq" UNIQUE("project_id","name")
);
--> statement-breakpoint
CREATE TABLE "mockup_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"mockup_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"storage_key" text NOT NULL,
	"size" bigint NOT NULL,
	"checksum" text NOT NULL,
	"keep_notes" text DEFAULT '' NOT NULL,
	"free_notes" text DEFAULT '' NOT NULL,
	"screenshot_key" text,
	"restored_from" integer,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mockup_version_number_uq" UNIQUE("mockup_id","number")
);
--> statement-breakpoint
ALTER TABLE "mockup" ADD CONSTRAINT "mockup_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup" ADD CONSTRAINT "mockup_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup" ADD CONSTRAINT "mockup_item_id_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."item"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_kit" ADD CONSTRAINT "mockup_kit_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_kit" ADD CONSTRAINT "mockup_kit_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_pin" ADD CONSTRAINT "mockup_pin_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_pin" ADD CONSTRAINT "mockup_pin_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_pin" ADD CONSTRAINT "mockup_pin_mockup_id_mockup_id_fk" FOREIGN KEY ("mockup_id") REFERENCES "public"."mockup"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_project" ADD CONSTRAINT "mockup_project_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_project" ADD CONSTRAINT "mockup_project_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_template" ADD CONSTRAINT "mockup_template_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_template" ADD CONSTRAINT "mockup_template_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_version" ADD CONSTRAINT "mockup_version_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_version" ADD CONSTRAINT "mockup_version_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_version" ADD CONSTRAINT "mockup_version_mockup_id_mockup_id_fk" FOREIGN KEY ("mockup_id") REFERENCES "public"."mockup"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mockup_project_idx" ON "mockup" USING btree ("project_id","trashed_at");--> statement-breakpoint
CREATE INDEX "mockup_item_idx" ON "mockup" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mockup_public_token_uq" ON "mockup" USING btree ("public_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "mockup_kit_key_uq" ON "mockup_kit" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "mockup_pin_mockup_idx" ON "mockup_pin" USING btree ("mockup_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "mockup_version_key_uq" ON "mockup_version" USING btree ("storage_key");