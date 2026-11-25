CREATE TABLE "qa_bug" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"cause_key" text NOT NULL,
	"task_id" uuid NOT NULL,
	"feature_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qa_feature" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"key" text NOT NULL,
	"area" text DEFAULT '' NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"priority" text,
	"code_globs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sizes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"map" jsonb DEFAULT '{"journeys":[]}'::jsonb NOT NULL,
	"edited_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"conflicts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"untrusted" boolean DEFAULT false NOT NULL,
	"removed_at" timestamp with time zone,
	"merged_into" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qa_feature_priority_chk" CHECK ("qa_feature"."priority" is null or "qa_feature"."priority" in ('high', 'normal', 'low'))
);
--> statement-breakpoint
CREATE TABLE "qa_plan_feature" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"plan_item_id" uuid NOT NULL,
	"feature_id" uuid NOT NULL,
	"baseline_outcome" text DEFAULT 'unknown' NOT NULL,
	"baseline_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qa_plan_feature_baseline_chk" CHECK ("qa_plan_feature"."baseline_outcome" in ('works', 'broken', 'could_not_test', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "qa_result" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"run_item_id" uuid NOT NULL,
	"feature_id" uuid NOT NULL,
	"case_key" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"outcome" text NOT NULL,
	"severity" text,
	"width" integer NOT NULL,
	"mode" text NOT NULL,
	"role" text DEFAULT '' NOT NULL,
	"target_host" text NOT NULL,
	"observed" text DEFAULT '' NOT NULL,
	"data_entered" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"commit" text DEFAULT '' NOT NULL,
	"screen_id" uuid,
	"annotation_id" uuid,
	"task_id" uuid,
	"session_id" text,
	"redacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qa_result_outcome_chk" CHECK ("qa_result"."outcome" in ('works', 'broken', 'could_not_test')),
	CONSTRAINT "qa_result_mode_chk" CHECK ("qa_result"."mode" in ('light', 'dark')),
	CONSTRAINT "qa_result_severity_chk" CHECK ("qa_result"."severity" is null or "qa_result"."severity" in ('blocker', 'major', 'minor', 'cosmetic')),
	CONSTRAINT "qa_result_width_chk" CHECK ("qa_result"."width" between 200 and 4000)
);
--> statement-breakpoint
CREATE TABLE "qa_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"run_no" integer NOT NULL,
	"item_id" uuid NOT NULL,
	"scope" text DEFAULT '' NOT NULL,
	"target_host" text NOT NULL,
	"writes" boolean DEFAULT false NOT NULL,
	"commit" text DEFAULT '' NOT NULL,
	"sizes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qa_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"next_run" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "qa_bug" ADD CONSTRAINT "qa_bug_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_bug" ADD CONSTRAINT "qa_bug_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_bug" ADD CONSTRAINT "qa_bug_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_bug" ADD CONSTRAINT "qa_bug_feature_id_qa_feature_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."qa_feature"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_feature" ADD CONSTRAINT "qa_feature_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_feature" ADD CONSTRAINT "qa_feature_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_plan_feature" ADD CONSTRAINT "qa_plan_feature_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_plan_feature" ADD CONSTRAINT "qa_plan_feature_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_plan_feature" ADD CONSTRAINT "qa_plan_feature_plan_item_id_item_id_fk" FOREIGN KEY ("plan_item_id") REFERENCES "public"."item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_plan_feature" ADD CONSTRAINT "qa_plan_feature_feature_id_qa_feature_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."qa_feature"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_result" ADD CONSTRAINT "qa_result_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_result" ADD CONSTRAINT "qa_result_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_result" ADD CONSTRAINT "qa_result_run_id_qa_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."qa_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_result" ADD CONSTRAINT "qa_result_feature_id_qa_feature_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."qa_feature"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_result" ADD CONSTRAINT "qa_result_screen_id_screen_id_fk" FOREIGN KEY ("screen_id") REFERENCES "public"."screen"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_result" ADD CONSTRAINT "qa_result_annotation_id_screen_annotation_id_fk" FOREIGN KEY ("annotation_id") REFERENCES "public"."screen_annotation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_result" ADD CONSTRAINT "qa_result_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_run" ADD CONSTRAINT "qa_run_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_run" ADD CONSTRAINT "qa_run_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_run" ADD CONSTRAINT "qa_run_item_id_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_settings" ADD CONSTRAINT "qa_settings_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_settings" ADD CONSTRAINT "qa_settings_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "qa_bug_cause_uq" ON "qa_bug" USING btree ("project_id","cause_key");--> statement-breakpoint
CREATE INDEX "qa_bug_task_idx" ON "qa_bug" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "qa_feature_key_uq" ON "qa_feature" USING btree ("project_id","key");--> statement-breakpoint
CREATE INDEX "qa_feature_project_idx" ON "qa_feature" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "qa_plan_feature_uq" ON "qa_plan_feature" USING btree ("plan_item_id","feature_id");--> statement-breakpoint
CREATE INDEX "qa_plan_feature_feature_idx" ON "qa_plan_feature" USING btree ("feature_id");--> statement-breakpoint
CREATE UNIQUE INDEX "qa_result_try_uq" ON "qa_result" USING btree ("run_id","case_key","width","mode","attempt");--> statement-breakpoint
CREATE INDEX "qa_result_feature_idx" ON "qa_result" USING btree ("feature_id","created_at");--> statement-breakpoint
CREATE INDEX "qa_result_run_idx" ON "qa_result" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "qa_run_item_uq" ON "qa_run" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "qa_run_no_uq" ON "qa_run" USING btree ("project_id","run_no");--> statement-breakpoint
CREATE UNIQUE INDEX "qa_settings_project_uq" ON "qa_settings" USING btree ("project_id");