ALTER TABLE "user_pref" ADD COLUMN "continue_tool" text DEFAULT 'claude-code' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_pref" ADD COLUMN "continue_mode" text DEFAULT 'vscode' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_pref" ADD CONSTRAINT "user_pref_continue_tool_chk" CHECK ("user_pref"."continue_tool" in ('claude-code', 'codex', 'gemini', 'other'));--> statement-breakpoint
ALTER TABLE "user_pref" ADD CONSTRAINT "user_pref_continue_mode_chk" CHECK ("user_pref"."continue_mode" in ('vscode', 'command', 'prompt'));