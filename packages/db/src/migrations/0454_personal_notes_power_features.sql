ALTER TABLE "personal_notes" ADD COLUMN IF NOT EXISTS "daily_date" text;
--> statement-breakpoint
ALTER TABLE "personal_notes" ADD COLUMN IF NOT EXISTS "scheduled_recurrence" text NOT NULL DEFAULT 'none';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "personal_notes_company_user_daily_idx"
  ON "personal_notes" ("company_id", "user_id", "daily_date");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "personal_note_issue_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "note_id" uuid NOT NULL REFERENCES "personal_notes"("id") ON DELETE CASCADE,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "source_line" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "personal_note_issue_links_note_created_idx"
  ON "personal_note_issue_links" ("note_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "personal_note_issue_links_company_issue_idx"
  ON "personal_note_issue_links" ("company_id", "issue_id");
