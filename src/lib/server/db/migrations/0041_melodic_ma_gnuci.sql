CREATE TABLE "note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"folder_id" uuid,
	"visibility" text DEFAULT 'public' NOT NULL,
	"created_by" text,
	"updated_by" text,
	"deleted_at" timestamp with time zone,
	"deleted_by" text,
	"epoch" integer DEFAULT 1 NOT NULL,
	"update_seq" integer DEFAULT 0 NOT NULL,
	"checkpoint_seq" integer DEFAULT 0 NOT NULL,
	"public_enabled" boolean DEFAULT false NOT NULL,
	"public_token_hash" text,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(body, ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "note_project_number_uq" UNIQUE("project_id","number"),
	CONSTRAINT "note_visibility_chk" CHECK ("note"."visibility" in ('public', 'private'))
);
--> statement-breakpoint
CREATE TABLE "note_favourite" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_favourite_uq" UNIQUE("note_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "note_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"mime" text NOT NULL,
	"size" bigint NOT NULL,
	"checksum" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "note_folder" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "note_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"source" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_link_uq" UNIQUE("note_id","target_kind","target_id","source"),
	CONSTRAINT "note_link_kind_chk" CHECK ("note_link"."target_kind" in ('item', 'task', 'mockup', 'note')),
	CONSTRAINT "note_link_source_chk" CHECK ("note_link"."source" in ('panel', 'text'))
);
--> statement-breakpoint
CREATE TABLE "note_update" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"epoch" integer NOT NULL,
	"seq" integer NOT NULL,
	"update" "bytea" NOT NULL,
	"author_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_update_seq_uq" UNIQUE("note_id","epoch","seq")
);
--> statement-breakpoint
CREATE TABLE "note_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"cause" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_version_number_uq" UNIQUE("note_id","number"),
	CONSTRAINT "note_version_cause_chk" CHECK ("note_version"."cause" in ('typing', 'agent', 'api', 'restore'))
);
--> statement-breakpoint
ALTER TABLE "project_counter" ADD COLUMN "next_note" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_folder_id_note_folder_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."note_folder"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_favourite" ADD CONSTRAINT "note_favourite_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_favourite" ADD CONSTRAINT "note_favourite_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_favourite" ADD CONSTRAINT "note_favourite_note_id_note_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."note"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_favourite" ADD CONSTRAINT "note_favourite_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_file" ADD CONSTRAINT "note_file_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_file" ADD CONSTRAINT "note_file_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_file" ADD CONSTRAINT "note_file_note_id_note_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."note"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_folder" ADD CONSTRAINT "note_folder_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_folder" ADD CONSTRAINT "note_folder_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_folder" ADD CONSTRAINT "note_folder_parent_id_note_folder_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."note_folder"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_link" ADD CONSTRAINT "note_link_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_link" ADD CONSTRAINT "note_link_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_link" ADD CONSTRAINT "note_link_note_id_note_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."note"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_update" ADD CONSTRAINT "note_update_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_update" ADD CONSTRAINT "note_update_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_update" ADD CONSTRAINT "note_update_note_id_note_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."note"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_version" ADD CONSTRAINT "note_version_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_version" ADD CONSTRAINT "note_version_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_version" ADD CONSTRAINT "note_version_note_id_note_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."note"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_search_idx" ON "note" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "note_folder_idx" ON "note" USING btree ("project_id","folder_id","deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "note_public_token_uq" ON "note" USING btree ("public_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "note_file_key_uq" ON "note_file" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "note_file_note_idx" ON "note_file" USING btree ("note_id");--> statement-breakpoint
CREATE INDEX "note_folder_parent_idx" ON "note_folder" USING btree ("project_id","parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "note_folder_sibling_uq" ON "note_folder" USING btree ("project_id",coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),lower("name")) WHERE "note_folder"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "note_link_target_idx" ON "note_link" USING btree ("target_kind","target_id");