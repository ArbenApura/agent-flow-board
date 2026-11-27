CREATE TABLE "test_case" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"key" text NOT NULL,
	"area" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"retired_at" timestamp with time zone,
	"retired_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_case_kind_chk" CHECK ("test_case"."kind" in ('ui', 'mcp', 'api', 'unit', 'skill')),
	CONSTRAINT "test_case_priority_chk" CHECK ("test_case"."priority" in ('high', 'normal', 'low'))
);
--> statement-breakpoint
CREATE TABLE "test_case_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"plan_item_id" uuid,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_data" text DEFAULT '' NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"unit_ref" text,
	"devices" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"surfaces" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mode" text DEFAULT 'light' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_case_version_mode_chk" CHECK ("test_case_version"."mode" in ('light', 'dark'))
);
--> statement-breakpoint
CREATE TABLE "test_counter" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"code" text NOT NULL,
	"next" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_plan_case" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"plan_item_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"role" text NOT NULL,
	"baseline" text DEFAULT 'none' NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_plan_case_role_chk" CHECK ("test_plan_case"."role" in ('reuse', 'update', 'new', 'retire')),
	CONSTRAINT "test_plan_case_baseline_chk" CHECK ("test_plan_case"."baseline" in ('none', 'pass', 'fail', 'blocked', 'not_run'))
);
--> statement-breakpoint
CREATE TABLE "test_proof" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"result_id" uuid NOT NULL,
	"step" integer,
	"storage_key" text,
	"gone_at" timestamp with time zone,
	"mime" text NOT NULL,
	"size" bigint NOT NULL,
	"checksum" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_result" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"case_version" integer NOT NULL,
	"device" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"failed_step" integer,
	"actual" text DEFAULT '' NOT NULL,
	"output" text DEFAULT '' NOT NULL,
	"console_lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"browser" text DEFAULT '' NOT NULL,
	"severity" text,
	"bug_priority" text,
	"task_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_result_status_chk" CHECK ("test_result"."status" in ('pass', 'fail', 'blocked', 'not_run')),
	CONSTRAINT "test_result_device_chk" CHECK ("test_result"."device" in ('wide', 'laptop', 'tablet', 'phone', 'custom')),
	CONSTRAINT "test_result_mode_chk" CHECK ("test_result"."mode" in ('light', 'dark')),
	CONSTRAINT "test_result_severity_chk" CHECK ("test_result"."severity" is null or "test_result"."severity" in ('blocker', 'major', 'minor', 'cosmetic')),
	CONSTRAINT "test_result_bug_priority_chk" CHECK ("test_result"."bug_priority" is null or "test_result"."bug_priority" in ('high', 'normal', 'low')),
	CONSTRAINT "test_result_size_chk" CHECK ("test_result"."width" between 200 and 4000 and "test_result"."height" between 200 and 4000)
);
--> statement-breakpoint
CREATE TABLE "test_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"plan_item_id" uuid,
	"run_no" integer NOT NULL,
	"objective" text DEFAULT '' NOT NULL,
	"commit" text DEFAULT '' NOT NULL,
	"harness" text DEFAULT '' NOT NULL,
	"browser" text DEFAULT '' NOT NULL,
	"reviewer" text DEFAULT '' NOT NULL,
	"tier" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"created_by" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "test_run_state_chk" CHECK ("test_run"."state" in ('open', 'finished', 'abandoned'))
);
--> statement-breakpoint
CREATE TABLE "test_surface" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_surface_kind_chk" CHECK ("test_surface"."kind" in ('route', 'mcp', 'api'))
);
--> statement-breakpoint
ALTER TABLE "test_case" ADD CONSTRAINT "test_case_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_case" ADD CONSTRAINT "test_case_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_case_version" ADD CONSTRAINT "test_case_version_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_case_version" ADD CONSTRAINT "test_case_version_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_case_version" ADD CONSTRAINT "test_case_version_case_id_test_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."test_case"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_counter" ADD CONSTRAINT "test_counter_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_counter" ADD CONSTRAINT "test_counter_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_plan_case" ADD CONSTRAINT "test_plan_case_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_plan_case" ADD CONSTRAINT "test_plan_case_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_plan_case" ADD CONSTRAINT "test_plan_case_plan_item_id_item_id_fk" FOREIGN KEY ("plan_item_id") REFERENCES "public"."item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_plan_case" ADD CONSTRAINT "test_plan_case_case_id_test_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."test_case"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_proof" ADD CONSTRAINT "test_proof_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_proof" ADD CONSTRAINT "test_proof_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_proof" ADD CONSTRAINT "test_proof_result_id_test_result_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."test_result"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_result" ADD CONSTRAINT "test_result_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_result" ADD CONSTRAINT "test_result_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_result" ADD CONSTRAINT "test_result_run_id_test_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_result" ADD CONSTRAINT "test_result_case_id_test_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."test_case"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_result" ADD CONSTRAINT "test_result_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_run" ADD CONSTRAINT "test_run_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_run" ADD CONSTRAINT "test_run_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_run" ADD CONSTRAINT "test_run_plan_item_id_item_id_fk" FOREIGN KEY ("plan_item_id") REFERENCES "public"."item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_surface" ADD CONSTRAINT "test_surface_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_surface" ADD CONSTRAINT "test_surface_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "test_case_key_uq" ON "test_case" USING btree ("project_id","key");--> statement-breakpoint
CREATE INDEX "test_case_area_idx" ON "test_case" USING btree ("project_id","area");--> statement-breakpoint
CREATE UNIQUE INDEX "test_case_version_uq" ON "test_case_version" USING btree ("case_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "test_counter_uq" ON "test_counter" USING btree ("project_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "test_plan_case_uq" ON "test_plan_case" USING btree ("plan_item_id","case_id");--> statement-breakpoint
CREATE INDEX "test_plan_case_case_idx" ON "test_plan_case" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "test_proof_key_uq" ON "test_proof" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "test_proof_result_idx" ON "test_proof" USING btree ("result_id");--> statement-breakpoint
CREATE UNIQUE INDEX "test_result_slot_uq" ON "test_result" USING btree ("run_id","case_id","device","width","height");--> statement-breakpoint
CREATE INDEX "test_result_case_idx" ON "test_result" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "test_run_no_uq" ON "test_run" USING btree ("project_id","run_no");--> statement-breakpoint
CREATE INDEX "test_run_plan_idx" ON "test_run" USING btree ("plan_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "test_surface_uq" ON "test_surface" USING btree ("project_id","kind","key");