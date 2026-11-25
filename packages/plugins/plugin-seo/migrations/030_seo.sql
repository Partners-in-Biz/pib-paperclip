-- 0.52.5 (PAR-14558): a page carried from an open approval draft into a newer one keeps its draft_key (the draft it is in)
-- and gets carry_key (the newer draft that lists it too). It moves to carry_key only when the Mailbox says the older draft
-- is gone (mail.draft.closed replaced or deleted); a draft a person edited stays, with its pages (mail.draft.kept sets
-- draft_status = 'kept'). Older rows keep NULL: nothing carried.
-- The preview server (ops/preview-server, role pib_preview) neither reads nor writes this column, so no GRANT is needed.
-- Rollback: revert the plugin (the old code never reads the column), then optionally
--   ALTER TABLE plugin_seo_8099f8879a.previews DROP COLUMN carry_key;
ALTER TABLE plugin_seo_8099f8879a.previews ADD COLUMN carry_key text;
