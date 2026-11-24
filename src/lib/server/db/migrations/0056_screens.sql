CREATE TABLE "screen" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"phase_key" text,
	"screen_key" text NOT NULL,
	"mode" text NOT NULL,
	"width" integer NOT NULL,
	"role" text NOT NULL,
	"caption" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"storage_key" text NOT NULL,
	"size" bigint NOT NULL,
	"checksum" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "screen_mode_chk" CHECK ("screen"."mode" in ('light', 'dark')),
	CONSTRAINT "screen_role_chk" CHECK ("screen"."role" in ('before', 'after')),
	CONSTRAINT "screen_width_chk" CHECK ("screen"."width" between 200 and 4000)
);
--> statement-breakpoint
CREATE TABLE "screen_annotation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"screen_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"x" real NOT NULL,
	"y" real NOT NULL,
	"w" real,
	"h" real,
	"body" text NOT NULL,
	"author_id" text,
	"author" text DEFAULT '' NOT NULL,
	"untrusted" boolean DEFAULT false NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "screen_annotation_kind_chk" CHECK ("screen_annotation"."kind" in ('pin', 'box', 'arrow')),
	CONSTRAINT "screen_annotation_xy_chk" CHECK ("screen_annotation"."x" between 0 and 1 and "screen_annotation"."y" between 0 and 1),
	CONSTRAINT "screen_annotation_wh_chk" CHECK (("screen_annotation"."w" is null or "screen_annotation"."w" between -1 and 1) and ("screen_annotation"."h" is null or "screen_annotation"."h" between -1 and 1))
);
--> statement-breakpoint
ALTER TABLE "screen" ADD CONSTRAINT "screen_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screen" ADD CONSTRAINT "screen_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screen" ADD CONSTRAINT "screen_item_id_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screen_annotation" ADD CONSTRAINT "screen_annotation_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screen_annotation" ADD CONSTRAINT "screen_annotation_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screen_annotation" ADD CONSTRAINT "screen_annotation_screen_id_screen_id_fk" FOREIGN KEY ("screen_id") REFERENCES "public"."screen"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "screen_slot_uq" ON "screen" USING btree ("item_id","screen_key","mode","width","role");--> statement-breakpoint
CREATE UNIQUE INDEX "screen_key_uq" ON "screen" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "screen_item_idx" ON "screen" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "screen_annotation_screen_idx" ON "screen_annotation" USING btree ("screen_id");