CREATE TABLE "bridge_signin_envelope" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"runner_id" uuid NOT NULL,
	"registration" text NOT NULL,
	"key_id" text NOT NULL,
	"alg" text NOT NULL,
	"ciphertext" text NOT NULL,
	"created_by" text,
	"expires_at" timestamp with time zone NOT NULL,
	"leased_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"result" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bridge_signin_envelope_uq" UNIQUE("runner_id","registration")
);
--> statement-breakpoint
ALTER TABLE "runner" ADD COLUMN "signin_key_id" text;--> statement-breakpoint
ALTER TABLE "runner" ADD COLUMN "signin_public_key" text;--> statement-breakpoint
ALTER TABLE "runner" ADD COLUMN "signin_key_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bridge_signin_envelope" ADD CONSTRAINT "bridge_signin_envelope_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_signin_envelope" ADD CONSTRAINT "bridge_signin_envelope_runner_id_runner_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runner"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_signin_envelope" ADD CONSTRAINT "bridge_signin_envelope_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bridge_signin_envelope_exp_idx" ON "bridge_signin_envelope" USING btree ("expires_at");