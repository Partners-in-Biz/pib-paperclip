-- Campaigns B2 (PAR-11279): a digest campaign made by create-feed-digest records its feed and the items it holds.
-- feed_url and feed_category say which feed (and which category of it) the digest was made from; feed_item_keys lists the item keys in it.
-- The keys are on the campaign row so one INSERT creates the draft and the claim on its items. An item counts as used only once the campaign has left draft.
-- Nullable columns only: the previous version names its own columns in every insert and update, so it keeps working. Never edit this file once it may have run.

ALTER TABLE plugin_campaigns_d355219713.campaigns
  ADD COLUMN feed_url text,
  ADD COLUMN feed_category text,
  ADD COLUMN feed_item_keys jsonb;

CREATE INDEX campaigns_feed ON plugin_campaigns_d355219713.campaigns (company_id, feed_url) WHERE feed_url IS NOT NULL;
