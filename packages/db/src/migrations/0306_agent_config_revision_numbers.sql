-- Additive: nullable column so code from before this migration still inserts.
-- Undo: DROP INDEX agent_config_revisions_agent_number_uq; ALTER TABLE agent_config_revisions DROP COLUMN revision_number;
ALTER TABLE "agent_config_revisions" ADD COLUMN IF NOT EXISTS "revision_number" integer;
--> statement-breakpoint
UPDATE "agent_config_revisions" r SET "revision_number" = s.n
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "agent_id" ORDER BY "created_at", "id") AS n
  FROM "agent_config_revisions"
) s
WHERE r."id" = s."id" AND r."revision_number" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "agent_config_revisions" x WHERE x."agent_id" = r."agent_id" AND x."revision_number" IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_config_revisions_agent_number_uq" ON "agent_config_revisions" ("agent_id","revision_number");
