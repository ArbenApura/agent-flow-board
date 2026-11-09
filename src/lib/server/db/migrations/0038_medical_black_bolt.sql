CREATE TABLE "bridge_approval" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid,
	"runner_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"batch_id" uuid,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"content_hash" text NOT NULL,
	"why" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"requested_by" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decided_via" text,
	"claimed_at" timestamp with time zone,
	"claimed_by_runner" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bridge_approval_request_uq" UNIQUE("runner_id","request_id"),
	CONSTRAINT "bridge_approval_action_chk" CHECK ("bridge_approval"."action" in ('register', 'secrets', 'adopt-env', 'roots', 'pictures', 'login')),
	CONSTRAINT "bridge_approval_status_chk" CHECK ("bridge_approval"."status" in ('pending', 'approved', 'refused', 'expired', 'cancelled', 'claimed'))
);
--> statement-breakpoint
ALTER TABLE "bridge_approval" ADD CONSTRAINT "bridge_approval_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_approval" ADD CONSTRAINT "bridge_approval_runner_id_runner_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runner"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_approval" ADD CONSTRAINT "bridge_approval_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_approval" ADD CONSTRAINT "bridge_approval_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bridge_approval_status_idx" ON "bridge_approval" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "bridge_approval_batch_idx" ON "bridge_approval" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bridge_approval_pending_uq" ON "bridge_approval" USING btree ("runner_id","action","target") WHERE "bridge_approval"."status" = 'pending';