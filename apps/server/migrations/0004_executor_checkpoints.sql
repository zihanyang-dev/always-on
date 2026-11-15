ALTER TABLE "agent_sessions" ADD COLUMN "execution_checkpoint" jsonb;--> statement-breakpoint
UPDATE "agent_sessions"
SET "execution_checkpoint" = jsonb_build_object('kind', 'pi', 'version', 1, 'sessionFile', "session_file")
WHERE "session_file" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP COLUMN "session_file";
