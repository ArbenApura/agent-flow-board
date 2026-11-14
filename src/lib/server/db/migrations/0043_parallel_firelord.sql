CREATE TABLE "mockup_kit_asset" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kit_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"storage_key" text NOT NULL,
	"size" bigint NOT NULL,
	"checksum" text NOT NULL,
	CONSTRAINT "mockup_kit_asset_kit_name_uq" UNIQUE("kit_id","name")
);
--> statement-breakpoint
ALTER TABLE "mockup_kit_asset" ADD CONSTRAINT "mockup_kit_asset_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_kit_asset" ADD CONSTRAINT "mockup_kit_asset_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_kit_asset" ADD CONSTRAINT "mockup_kit_asset_kit_id_mockup_kit_id_fk" FOREIGN KEY ("kit_id") REFERENCES "public"."mockup_kit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mockup_kit_asset_key_uq" ON "mockup_kit_asset" USING btree ("storage_key");