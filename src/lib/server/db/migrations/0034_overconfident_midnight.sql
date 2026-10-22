CREATE INDEX "project_org_upper_key_idx" ON "project" USING btree ("org_id",upper("key"));--> statement-breakpoint
CREATE INDEX "item_org_upper_ref_idx" ON "item" USING btree ("org_id",upper("ref"));--> statement-breakpoint
CREATE INDEX "item_alias_org_upper_alias_idx" ON "item_alias" USING btree ("org_id",upper("alias"));--> statement-breakpoint
CREATE INDEX "event_undo_of_idx" ON "event" USING btree ("undo_of") WHERE "event"."undo_of" is not null;