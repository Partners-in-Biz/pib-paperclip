-- Client scope. Own work has no client (client_ref IS NULL); client work
-- belongs to one CRM company or one CRM contact (a sole trader), so every
-- scoped table carries client_kind next to client_ref. Rows written before
-- contacts were allowed are companies. OAuth sessions keep the client in
-- their extra jsonb (clientKind + clientRef), so they need no column.

ALTER TABLE plugin_social_e70c4e79f2.accounts ADD COLUMN IF NOT EXISTS client_kind text;

ALTER TABLE plugin_social_e70c4e79f2.posts ADD COLUMN IF NOT EXISTS client_kind text;

ALTER TABLE plugin_social_e70c4e79f2.media_assets ADD COLUMN IF NOT EXISTS client_kind text;

ALTER TABLE plugin_social_e70c4e79f2.rss_feeds ADD COLUMN IF NOT EXISTS client_kind text;

ALTER TABLE plugin_social_e70c4e79f2.inbox_items
  ADD COLUMN IF NOT EXISTS client_kind text,
  ADD COLUMN IF NOT EXISTS client_name text;

UPDATE plugin_social_e70c4e79f2.accounts SET client_kind = 'company' WHERE client_ref IS NOT NULL AND client_kind IS NULL;

UPDATE plugin_social_e70c4e79f2.posts SET client_kind = 'company' WHERE client_ref IS NOT NULL AND client_kind IS NULL;

UPDATE plugin_social_e70c4e79f2.media_assets SET client_kind = 'company' WHERE client_ref IS NOT NULL AND client_kind IS NULL;

UPDATE plugin_social_e70c4e79f2.rss_feeds SET client_kind = 'company' WHERE client_ref IS NOT NULL AND client_kind IS NULL;

UPDATE plugin_social_e70c4e79f2.inbox_items SET client_kind = 'company' WHERE client_ref IS NOT NULL AND client_kind IS NULL;

-- Inbox items take their client from the account they arrived on.
UPDATE plugin_social_e70c4e79f2.inbox_items i
   SET client_kind = a.client_kind, client_ref = a.client_ref, client_name = a.client_name
  FROM plugin_social_e70c4e79f2.accounts a
 WHERE a.id = i.account_id
   AND (COALESCE(i.client_ref, '') <> COALESCE(a.client_ref, '') OR COALESCE(i.client_name, '') <> COALESCE(a.client_name, ''));

ALTER TABLE plugin_social_e70c4e79f2.accounts
  ADD CONSTRAINT accounts_client_kind CHECK (client_kind IS NULL OR client_kind IN ('company', 'contact'));

ALTER TABLE plugin_social_e70c4e79f2.posts
  ADD CONSTRAINT posts_client_kind CHECK (client_kind IS NULL OR client_kind IN ('company', 'contact'));

ALTER TABLE plugin_social_e70c4e79f2.media_assets
  ADD CONSTRAINT media_assets_client_kind CHECK (client_kind IS NULL OR client_kind IN ('company', 'contact'));

ALTER TABLE plugin_social_e70c4e79f2.rss_feeds
  ADD CONSTRAINT rss_feeds_client_kind CHECK (client_kind IS NULL OR client_kind IN ('company', 'contact'));

ALTER TABLE plugin_social_e70c4e79f2.inbox_items
  ADD CONSTRAINT inbox_items_client_kind CHECK (client_kind IS NULL OR client_kind IN ('company', 'contact'));

CREATE INDEX IF NOT EXISTS accounts_scope ON plugin_social_e70c4e79f2.accounts (company_id, client_ref, client_kind);

CREATE INDEX IF NOT EXISTS posts_scope ON plugin_social_e70c4e79f2.posts (company_id, client_ref, client_kind, status);

CREATE INDEX IF NOT EXISTS media_assets_scope ON plugin_social_e70c4e79f2.media_assets (company_id, client_ref, client_kind);

CREATE INDEX IF NOT EXISTS rss_feeds_scope ON plugin_social_e70c4e79f2.rss_feeds (company_id, client_ref, client_kind);

CREATE INDEX IF NOT EXISTS inbox_items_scope ON plugin_social_e70c4e79f2.inbox_items (company_id, client_ref, client_kind, status);
