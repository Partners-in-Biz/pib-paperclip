-- 0.11.0: manual accounts. A manual account has no API link (the platform has not approved our app yet, or never will):
-- its posts go through the same drafting, review, approval and scheduling, and at the publish time a person posts
-- them by hand from the post page. `awaiting_manual` is the destination state that waits for that person.
-- Additive. Rollback: leave both in place (older code then treats an `awaiting_manual` destination as not published).

ALTER TABLE plugin_social_e70c4e79f2.accounts
  ADD COLUMN IF NOT EXISTS manual boolean NOT NULL DEFAULT false;

ALTER TABLE plugin_social_e70c4e79f2.destinations
  DROP CONSTRAINT IF EXISTS destinations_status;

ALTER TABLE plugin_social_e70c4e79f2.destinations
  ADD CONSTRAINT destinations_status CHECK (status IN ('pending', 'publishing', 'retrying', 'awaiting_manual', 'published', 'failed'));
