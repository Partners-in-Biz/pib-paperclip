-- Chat privacy CP-5 (PAR-12830, PAR-12774 plan 4.6, stage 2): every existing chat with an agent becomes
-- private, in all companies. New chats are created private since CP-2b; this flags the ones made before.
-- Each chat is its own privacy root. Tasks started from a chat keep it as privacy parent but stay open
-- (CP-1, the cut), so they are not touched here. updated_at is left as it is: this is not a user edit.
-- Idempotent: a chat that is already private is skipped.
-- Undo (run BEFORE reverting this migration's PR, and before any revert of CP-1):
--   UPDATE issues SET visibility = 'open', privacy_root_issue_id = NULL WHERE conversation_agent_id IS NOT NULL;
UPDATE "issues"
SET "visibility" = 'private', "privacy_root_issue_id" = "id"
WHERE "conversation_agent_id" IS NOT NULL AND "visibility" <> 'private';
