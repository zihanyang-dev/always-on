DROP INDEX "workspace_members_workspace_id_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_members_identity" ON "workspace_members" USING btree ("workspace_id","user_id");