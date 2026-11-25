CREATE TABLE "session_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"item_id" uuid,
	"path" text NOT NULL,
	"last_edited_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_file_uq" UNIQUE("session_id","path")
);
--> statement-breakpoint
CREATE TABLE "project_pitfall" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"text_key" text NOT NULL,
	"path" text,
	"source_item_id" uuid,
	"created_by" text NOT NULL,
	"author_kind" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_pitfall_kind_chk" CHECK ("project_pitfall"."kind" in ('environment', 'known-red-test', 'editing', 'live-safety')),
	CONSTRAINT "project_pitfall_author_kind_chk" CHECK ("project_pitfall"."author_kind" in ('person', 'agent'))
);
--> statement-breakpoint
ALTER TABLE "session_file" ADD CONSTRAINT "session_file_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_file" ADD CONSTRAINT "session_file_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_file" ADD CONSTRAINT "session_file_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_file" ADD CONSTRAINT "session_file_item_id_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."item"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_pitfall" ADD CONSTRAINT "project_pitfall_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_pitfall" ADD CONSTRAINT "project_pitfall_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_pitfall" ADD CONSTRAINT "project_pitfall_source_item_id_item_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."item"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_file_project_idx" ON "session_file" USING btree ("project_id","last_edited_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_pitfall_text_uq" ON "project_pitfall" USING btree ("project_id","text_key") WHERE "project_pitfall"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "project_pitfall_project_idx" ON "project_pitfall" USING btree ("project_id","created_at");