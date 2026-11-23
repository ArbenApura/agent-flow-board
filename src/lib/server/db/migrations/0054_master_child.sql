ALTER TABLE "item" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "item" ADD COLUMN "child_no" integer;--> statement-breakpoint
ALTER TABLE "item" ADD CONSTRAINT "item_parent_id_item_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."item"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "item_parent_idx" ON "item" USING btree ("project_id","parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "item_parent_child_no_uq" ON "item" USING btree ("parent_id","child_no");--> statement-breakpoint
ALTER TABLE "item" ADD CONSTRAINT "item_parent_self_chk" CHECK ("item"."parent_id" is distinct from "item"."id");