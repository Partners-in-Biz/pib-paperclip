-- PAR-4452: a draft can reply to or quote another post (X first), and carries
-- an internal note (for example "HOLD until PAR-1234") that is never published.
-- Additive: older code ignores the columns. Rollback: leave them in place.

ALTER TABLE plugin_social_e70c4e79f2.posts
  ADD COLUMN IF NOT EXISTS reply_to_url text,
  ADD COLUMN IF NOT EXISTS quote_url text,
  ADD COLUMN IF NOT EXISTS note text;
