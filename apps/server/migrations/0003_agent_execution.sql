CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"created_by" text NOT NULL,
	"name" text NOT NULL,
	"visibility" text NOT NULL,
	"configuration" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"message_index" integer NOT NULL,
	"role" text NOT NULL,
	"state" text NOT NULL,
	"text" text NOT NULL,
	"position" integer GENERATED ALWAYS AS IDENTITY (sequence name "agent_messages_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1)
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"input_id" uuid NOT NULL,
	"configuration" jsonb NOT NULL,
	"input_text" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"owner_token" uuid,
	"lease_until" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_runs_input_id_unique" UNIQUE("input_id"),
	CONSTRAINT "agent_runs_state_check" CHECK (("agent_runs"."status" = 'queued' and "agent_runs"."owner_token" is null and "agent_runs"."finished_at" is null)
        or ("agent_runs"."status" in ('running', 'cancelling') and "agent_runs"."owner_token" is not null
          and "agent_runs"."lease_until" is not null and "agent_runs"."started_at" is not null and "agent_runs"."finished_at" is null)
        or ("agent_runs"."status" in ('completed', 'cancelled') and "agent_runs"."finished_at" is not null)
        or ("agent_runs"."status" in ('failed', 'recovery_required') and "agent_runs"."finished_at" is not null and "agent_runs"."error" is not null))
);
--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"workspace_id" text NOT NULL,
	"created_by" text NOT NULL,
	"configuration" jsonb NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"session_file" text,
	"sandbox_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_tool_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_input_id_inbox_events_id_fk" FOREIGN KEY ("input_id") REFERENCES "public"."inbox_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_messages_run_ordinal" ON "agent_messages" USING btree ("run_id","message_index");--> statement-breakpoint
CREATE INDEX "agent_messages_session_position" ON "agent_messages" USING btree ("session_id","position");--> statement-breakpoint
CREATE INDEX "agent_runs_pending_idx" ON "agent_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_session_idx" ON "agent_runs" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_session_writer" ON "agent_runs" USING btree ("session_id") WHERE "agent_runs"."status" in ('running', 'cancelling');