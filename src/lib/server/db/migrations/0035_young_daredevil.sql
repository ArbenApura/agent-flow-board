CREATE TABLE "mcp_call_timing" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mcp_call_timing_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"org_id" uuid NOT NULL,
	"project_id" uuid,
	"tool" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_call_timing" ADD CONSTRAINT "mcp_call_timing_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_call_timing_project_idx" ON "mcp_call_timing" USING btree ("org_id","project_id","duration_ms");--> statement-breakpoint
CREATE INDEX "mcp_call_timing_created_idx" ON "mcp_call_timing" USING btree ("org_id","created_at");