-- 0.5.2: Company Cockpit and hand-offs.
-- - inbox (kit inboxMigration): events received once (SEO content.published).
-- - handoffs: one repurpose task per published SEO page (claimed before the issue is opened).
-- - posts.review_issue_id: the Reviewer's issue for a post in review.
-- - posts.review_returns: times a person sent the post back from review to draft.

CREATE TABLE plugin_social_e70c4e79f2.inbox (
  key text PRIMARY KEY,
  company_id text NOT NULL,
  event text NOT NULL,
  result jsonb,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plugin_social_e70c4e79f2.handoffs (
  key text PRIMARY KEY,
  company_id text NOT NULL,
  kind text NOT NULL,
  issue_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX handoffs_company ON plugin_social_e70c4e79f2.handoffs (company_id, created_at);

ALTER TABLE plugin_social_e70c4e79f2.posts
  ADD COLUMN IF NOT EXISTS review_issue_id text,
  ADD COLUMN IF NOT EXISTS review_returns integer NOT NULL DEFAULT 0;
