CREATE TABLE IF NOT EXISTS "personal_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL DEFAULT '',
  "tags" text[] NOT NULL DEFAULT '{}'::text[],
  "color" text NOT NULL DEFAULT 'default',
  "pinned" boolean NOT NULL DEFAULT false,
  "archived" boolean NOT NULL DEFAULT false,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
  "scheduled_for" timestamp with time zone,
  "scheduled_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "scheduled_project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
  "scheduled_priority" text NOT NULL DEFAULT 'medium',
  "scheduled_issue_status" text NOT NULL DEFAULT 'todo',
  "scheduled_instructions" text,
  "scheduled_status" text NOT NULL DEFAULT 'none',
  "scheduled_error" text,
  "handed_off_issue_id" uuid REFERENCES "issues"("id") ON DELETE SET NULL,
  "handed_off_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "personal_notes_company_user_updated_idx"
  ON "personal_notes" ("company_id", "user_id", "updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "personal_notes_scheduled_pending_idx"
  ON "personal_notes" ("scheduled_status", "scheduled_for");
