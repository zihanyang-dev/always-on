ALTER TABLE "agents" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "deletion_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "cleanup_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "cleanup_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "cleanup_error" text;--> statement-breakpoint
CREATE INDEX "agent_sessions_cleanup_idx" ON "agent_sessions" USING btree ("cleanup_after") WHERE "agent_sessions"."status" = 'deleting';--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_lifecycle_check" CHECK (("agent_sessions"."status" in ('active', 'archived') and "agent_sessions"."deletion_requested_at" is null
          and "agent_sessions"."cleanup_after" is null and "agent_sessions"."cleanup_attempts" = 0 and "agent_sessions"."cleanup_error" is null)
        or ("agent_sessions"."status" = 'deleting' and "agent_sessions"."deletion_requested_at" is not null
          and "agent_sessions"."cleanup_after" is not null and "agent_sessions"."cleanup_attempts" >= 0));