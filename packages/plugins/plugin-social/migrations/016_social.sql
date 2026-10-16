-- Rollback: ALTER TABLE plugin_social_e70c4e79f2.templates DROP COLUMN scope, DROP COLUMN owner_user_id, DROP CONSTRAINT templates_scope, DROP CONSTRAINT templates_owner;
-- Rollback: ALTER TABLE plugin_social_e70c4e79f2.media_assets DROP COLUMN scope, DROP COLUMN owner_user_id, DROP CONSTRAINT media_assets_scope, DROP CONSTRAINT media_assets_owner;
-- Rollback: ALTER TABLE plugin_social_e70c4e79f2.rss_feeds DROP COLUMN scope, DROP COLUMN owner_user_id, DROP CONSTRAINT rss_feeds_scope, DROP CONSTRAINT rss_feeds_owner;
-- Rollback: ALTER TABLE plugin_social_e70c4e79f2.inbox_items DROP COLUMN scope, DROP COLUMN owner_user_id, DROP CONSTRAINT inbox_items_scope, DROP CONSTRAINT inbox_items_owner;
-- Rollback: DROP INDEX plugin_social_e70c4e79f2.templates_scope_owner, plugin_social_e70c4e79f2.media_assets_scope_owner, plugin_social_e70c4e79f2.rss_feeds_scope_owner, plugin_social_e70c4e79f2.inbox_items_scope_owner, plugin_social_e70c4e79f2.accounts_scope_owner, plugin_social_e70c4e79f2.posts_scope_owner;

-- 0.9.0: personal scope isolation. Add scope and owner_user_id to templates, media_assets, rss_feeds, inbox_items.
-- Accounts and posts already have these columns (migration 001).
-- Destinations inherit scope via post_id, so they are not modified here.

ALTER TABLE plugin_social_e70c4e79f2.templates
ADD COLUMN scope text NOT NULL DEFAULT 'org',
ADD COLUMN owner_user_id text,
ADD CONSTRAINT templates_scope CHECK (scope IN ('org', 'personal')),
ADD CONSTRAINT templates_owner CHECK (scope = 'org' OR owner_user_id IS NOT NULL);

CREATE INDEX templates_scope_owner ON plugin_social_e70c4e79f2.templates (company_id, scope, owner_user_id);

ALTER TABLE plugin_social_e70c4e79f2.media_assets
ADD COLUMN scope text NOT NULL DEFAULT 'org',
ADD COLUMN owner_user_id text,
ADD CONSTRAINT media_assets_scope CHECK (scope IN ('org', 'personal')),
ADD CONSTRAINT media_assets_owner CHECK (scope = 'org' OR owner_user_id IS NOT NULL);

CREATE INDEX media_assets_scope_owner ON plugin_social_e70c4e79f2.media_assets (company_id, scope, owner_user_id);

ALTER TABLE plugin_social_e70c4e79f2.rss_feeds
ADD COLUMN scope text NOT NULL DEFAULT 'org',
ADD COLUMN owner_user_id text,
ADD CONSTRAINT rss_feeds_scope CHECK (scope IN ('org', 'personal')),
ADD CONSTRAINT rss_feeds_owner CHECK (scope = 'org' OR owner_user_id IS NOT NULL);

CREATE INDEX rss_feeds_scope_owner ON plugin_social_e70c4e79f2.rss_feeds (company_id, scope, owner_user_id);

ALTER TABLE plugin_social_e70c4e79f2.inbox_items
ADD COLUMN scope text NOT NULL DEFAULT 'org',
ADD COLUMN owner_user_id text,
ADD CONSTRAINT inbox_items_scope CHECK (scope IN ('org', 'personal')),
ADD CONSTRAINT inbox_items_owner CHECK (scope = 'org' OR owner_user_id IS NOT NULL);

CREATE INDEX inbox_items_scope_owner ON plugin_social_e70c4e79f2.inbox_items (company_id, scope, owner_user_id);

-- Add indexes to accounts and posts for (company_id, scope, owner_user_id)
CREATE INDEX accounts_scope_owner ON plugin_social_e70c4e79f2.accounts (company_id, scope, owner_user_id);
CREATE INDEX posts_scope_owner ON plugin_social_e70c4e79f2.posts (company_id, scope, owner_user_id);
