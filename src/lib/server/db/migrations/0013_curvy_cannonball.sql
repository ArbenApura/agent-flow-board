CREATE TABLE "skill" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"summary" text NOT NULL,
	"body" text NOT NULL,
	"hash" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"author_id" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid,
	"skill_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"name" text NOT NULL,
	"summary" text NOT NULL,
	"body" text NOT NULL,
	"hash" text NOT NULL,
	"author_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill" ADD CONSTRAINT "skill_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill" ADD CONSTRAINT "skill_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill" ADD CONSTRAINT "skill_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_revision" ADD CONSTRAINT "skill_revision_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_revision" ADD CONSTRAINT "skill_revision_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_revision" ADD CONSTRAINT "skill_revision_skill_id_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_project_name_uq" ON "skill" USING btree ("project_id","name") WHERE deleted_at is null and project_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_org_name_uq" ON "skill" USING btree ("org_id","name") WHERE deleted_at is null and project_id is null;--> statement-breakpoint
CREATE INDEX "skill_project_idx" ON "skill" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "skill_org_idx" ON "skill" USING btree ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_revision_skill_revision_uq" ON "skill_revision" USING btree ("skill_id","revision");--> statement-breakpoint
CREATE INDEX "skill_revision_skill_idx" ON "skill_revision" USING btree ("skill_id","revision");