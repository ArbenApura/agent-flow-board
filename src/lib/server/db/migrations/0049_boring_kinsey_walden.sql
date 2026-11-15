CREATE TABLE "connect_setup_mark" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"state" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connect_setup_mark_uq" UNIQUE("org_id","user_id","key"),
	CONSTRAINT "connect_setup_mark_key_chk" CHECK ("connect_setup_mark"."key" in ('tools', 'skills', 'bridge', 'editor', 'checks', 'token', 'panel')),
	CONSTRAINT "connect_setup_mark_state_chk" CHECK ("connect_setup_mark"."state" in ('done', 'skipped', 'open', 'closed'))
);
--> statement-breakpoint
ALTER TABLE "connect_setup_mark" ADD CONSTRAINT "connect_setup_mark_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connect_setup_mark" ADD CONSTRAINT "connect_setup_mark_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connect_setup_mark_user_idx" ON "connect_setup_mark" USING btree ("user_id","org_id");