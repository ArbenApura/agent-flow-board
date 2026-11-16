-- One computer registers once per person and organisation. Older duplicate tool rows of the same owner and name are removed first, keeping the newest.
DELETE FROM "runner" r
USING "runner" newer
WHERE r."kind" = 'tool'
  AND newer."kind" = 'tool'
  AND r."org_id" = newer."org_id"
  AND r."owner_id" IS NOT DISTINCT FROM newer."owner_id"
  AND r."name" = newer."name"
  AND (r."created_at", r."id") < (newer."created_at", newer."id");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_tool_owner_name_uq" ON "runner" USING btree ("org_id","owner_id","name") WHERE "runner"."kind" = 'tool';
