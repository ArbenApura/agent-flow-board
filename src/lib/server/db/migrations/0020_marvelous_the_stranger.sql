CREATE TABLE "claim_interval" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"tool" text NOT NULL,
	"project_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"phase" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "claim_interval_session_len" CHECK ("claim_interval"."session_id" is null or char_length("claim_interval"."session_id") <= 200),
	CONSTRAINT "claim_interval_tool_len" CHECK ("claim_interval"."tool" is null or char_length("claim_interval"."tool") <= 100)
);
--> statement-breakpoint
CREATE TABLE "model_price" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" text DEFAULT '' NOT NULL,
	"model" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"input_micros_per_mtok" bigint NOT NULL,
	"output_micros_per_mtok" bigint NOT NULL,
	"cache_read_micros_per_mtok" bigint,
	"cache_write_micros_per_mtok" bigint,
	"reasoning_micros_per_mtok" bigint,
	"source" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_price_uq" UNIQUE("org_id","provider","model","effective_from"),
	CONSTRAINT "model_price_input_chk" CHECK ("model_price"."input_micros_per_mtok" is null or ("model_price"."input_micros_per_mtok" >= 0 and "model_price"."input_micros_per_mtok" <= 1000000000000)),
	CONSTRAINT "model_price_output_chk" CHECK ("model_price"."output_micros_per_mtok" is null or ("model_price"."output_micros_per_mtok" >= 0 and "model_price"."output_micros_per_mtok" <= 1000000000000)),
	CONSTRAINT "model_price_cache_read_chk" CHECK ("model_price"."cache_read_micros_per_mtok" is null or ("model_price"."cache_read_micros_per_mtok" >= 0 and "model_price"."cache_read_micros_per_mtok" <= 1000000000000)),
	CONSTRAINT "model_price_cache_write_chk" CHECK ("model_price"."cache_write_micros_per_mtok" is null or ("model_price"."cache_write_micros_per_mtok" >= 0 and "model_price"."cache_write_micros_per_mtok" <= 1000000000000)),
	CONSTRAINT "model_price_reasoning_chk" CHECK ("model_price"."reasoning_micros_per_mtok" is null or ("model_price"."reasoning_micros_per_mtok" >= 0 and "model_price"."reasoning_micros_per_mtok" <= 1000000000000)),
	CONSTRAINT "model_price_model_len" CHECK ("model_price"."model" is null or char_length("model_price"."model") <= 100),
	CONSTRAINT "model_price_provider_len" CHECK ("model_price"."provider" is null or char_length("model_price"."provider") <= 100),
	CONSTRAINT "model_price_source_len" CHECK ("model_price"."source" is null or char_length("model_price"."source") <= 500)
);
--> statement-breakpoint
CREATE TABLE "usage_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid,
	"item_id" uuid,
	"phase" text,
	"step" text,
	"user_id" text NOT NULL,
	"session_id" text,
	"harness_session" text,
	"harness" text NOT NULL,
	"harness_version" text,
	"provider" text,
	"model" text NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"reasoning_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_micros" bigint,
	"cost_source" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"attribution" text DEFAULT 'none' NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"agent_name" text,
	"skill" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_event_dedupe_uq" UNIQUE("org_id","dedupe_key"),
	CONSTRAINT "usage_event_cost_source_chk" CHECK ("usage_event"."cost_source" in ('billed', 'reported', 'computed', 'unpriced', 'estimated')),
	CONSTRAINT "usage_event_attribution_chk" CHECK ("usage_event"."attribution" in ('exact', 'window', 'manual', 'none')),
	CONSTRAINT "usage_event_input_chk" CHECK ("usage_event"."input_tokens" is null or ("usage_event"."input_tokens" >= 0 and "usage_event"."input_tokens" <= 1000000000000)),
	CONSTRAINT "usage_event_output_chk" CHECK ("usage_event"."output_tokens" is null or ("usage_event"."output_tokens" >= 0 and "usage_event"."output_tokens" <= 1000000000000)),
	CONSTRAINT "usage_event_cache_read_chk" CHECK ("usage_event"."cache_read_tokens" is null or ("usage_event"."cache_read_tokens" >= 0 and "usage_event"."cache_read_tokens" <= 1000000000000)),
	CONSTRAINT "usage_event_cache_write_chk" CHECK ("usage_event"."cache_write_tokens" is null or ("usage_event"."cache_write_tokens" >= 0 and "usage_event"."cache_write_tokens" <= 1000000000000)),
	CONSTRAINT "usage_event_reasoning_chk" CHECK ("usage_event"."reasoning_tokens" is null or ("usage_event"."reasoning_tokens" >= 0 and "usage_event"."reasoning_tokens" <= 1000000000000)),
	CONSTRAINT "usage_event_cost_chk" CHECK ("usage_event"."cost_micros" is null or ("usage_event"."cost_micros" >= 0 and "usage_event"."cost_micros" <= 1000000000000)),
	CONSTRAINT "usage_event_harness_len" CHECK ("usage_event"."harness" is null or char_length("usage_event"."harness") <= 100),
	CONSTRAINT "usage_event_harness_version_len" CHECK ("usage_event"."harness_version" is null or char_length("usage_event"."harness_version") <= 100),
	CONSTRAINT "usage_event_provider_len" CHECK ("usage_event"."provider" is null or char_length("usage_event"."provider") <= 100),
	CONSTRAINT "usage_event_model_len" CHECK ("usage_event"."model" is null or char_length("usage_event"."model") <= 100),
	CONSTRAINT "usage_event_agent_len" CHECK ("usage_event"."agent_name" is null or char_length("usage_event"."agent_name") <= 100),
	CONSTRAINT "usage_event_skill_len" CHECK ("usage_event"."skill" is null or char_length("usage_event"."skill") <= 100),
	CONSTRAINT "usage_event_session_len" CHECK ("usage_event"."session_id" is null or char_length("usage_event"."session_id") <= 200),
	CONSTRAINT "usage_event_harness_session_len" CHECK ("usage_event"."harness_session" is null or char_length("usage_event"."harness_session") <= 200),
	CONSTRAINT "usage_event_dedupe_len" CHECK ("usage_event"."dedupe_key" is null or char_length("usage_event"."dedupe_key") <= 200)
);
--> statement-breakpoint
CREATE TABLE "usage_source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"harness" text NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_unrecognised_at" timestamp with time zone,
	"accepted" bigint DEFAULT 0 NOT NULL,
	"unrecognised" bigint DEFAULT 0 NOT NULL,
	"refused" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_source_uq" UNIQUE("org_id","harness"),
	CONSTRAINT "usage_source_harness_len" CHECK ("usage_source"."harness" is null or char_length("usage_source"."harness") <= 100)
);
--> statement-breakpoint
ALTER TABLE "claim_interval" ADD CONSTRAINT "claim_interval_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_price" ADD CONSTRAINT "model_price_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_source" ADD CONSTRAINT "usage_source_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "claim_interval_session_idx" ON "claim_interval" USING btree ("org_id","session_id","started_at");--> statement-breakpoint
CREATE INDEX "claim_interval_user_idx" ON "claim_interval" USING btree ("org_id","user_id","tool","started_at");--> statement-breakpoint
CREATE INDEX "usage_event_item_idx" ON "usage_event" USING btree ("org_id","item_id","occurred_at");--> statement-breakpoint
CREATE INDEX "usage_event_time_idx" ON "usage_event" USING btree ("org_id","occurred_at");--> statement-breakpoint
CREATE INDEX "usage_event_user_idx" ON "usage_event" USING btree ("org_id","user_id","occurred_at");