-- Read-only share links for a canvas (PAR-8093, slice 3b). The id is the secret of the link (24 random characters); the
-- public page is a static file dist/ui/s/<id>.html that the worker writes, refreshes and deletes (canvas-share.ts).
-- Rollback: reinstall 0.1.17 (the table is then unused; delete dist/ui/s/*.html by hand), then if wanted:
--   DROP TABLE plugin_studio_e414325bb6.canvas_shares;
CREATE TABLE plugin_studio_e414325bb6.canvas_shares (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  canvas_id text NOT NULL,
  created_by_user_id text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX canvas_shares_canvas ON plugin_studio_e414325bb6.canvas_shares (company_id, canvas_id, created_at DESC);
