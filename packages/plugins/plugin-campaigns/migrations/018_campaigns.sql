-- Campaigns B2 (PAR-14328): one open draft per feed and category, so two concurrent create-feed-digest calls cannot both open a draft.
-- Partial unique index over drafts that carry a feed. coalesce() makes a null category count as one value.
-- A draft that leaves draft (launched, cancelled) frees the slot. Index only: the previous version never reads it.

CREATE UNIQUE INDEX campaigns_feed_open_draft ON plugin_campaigns_d355219713.campaigns (company_id, feed_url, coalesce(feed_category, ''))
  WHERE status = 'draft' AND feed_url IS NOT NULL;
