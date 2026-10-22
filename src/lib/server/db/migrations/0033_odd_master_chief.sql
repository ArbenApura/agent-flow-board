CREATE TABLE "session_event" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "session_event_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"org_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"item_id" uuid,
	"tool" text,
	"kind" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_event" ADD CONSTRAINT "session_event_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_event_item_idx" ON "session_event" USING btree ("item_id","id");--> statement-breakpoint
CREATE INDEX "session_event_session_idx" ON "session_event" USING btree ("session_id","id");