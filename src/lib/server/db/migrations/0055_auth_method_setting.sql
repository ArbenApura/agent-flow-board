CREATE TABLE "auth_method_setting" (
	"id" text PRIMARY KEY NOT NULL,
	"password_enabled" boolean DEFAULT true NOT NULL,
	"google_enabled" boolean DEFAULT false NOT NULL,
	"google_client_id" text,
	"google_client_secret" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_method_setting" ADD CONSTRAINT "auth_method_setting_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;