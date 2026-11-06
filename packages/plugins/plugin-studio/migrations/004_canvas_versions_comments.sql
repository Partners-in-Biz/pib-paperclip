-- Canvas versions and card comments (PAR-8092, slice 3a). Named snapshots of a board, and a comment thread per card.
-- Comments are keyed by canvas and card id and are never removed with a card, so a restored version shows them again.
-- Rollback: reinstall 0.1.12 (the tables are then unused and harmless), then if wanted:
--   DROP TABLE plugin_studio_e414325bb6.canvas_comments; DROP TABLE plugin_studio_e414325bb6.canvas_versions;
CREATE TABLE plugin_studio_e414325bb6.canvas_versions (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  canvas_id text NOT NULL,
  name text NOT NULL,
  doc jsonb NOT NULL,
  revision integer NOT NULL,
  created_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX canvas_versions_canvas ON plugin_studio_e414325bb6.canvas_versions (company_id, canvas_id, created_at DESC);

CREATE TABLE plugin_studio_e414325bb6.canvas_comments (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  canvas_id text NOT NULL,
  card_id text NOT NULL,
  body text NOT NULL,
  canvas_revision integer NOT NULL,
  author_user_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX canvas_comments_card ON plugin_studio_e414325bb6.canvas_comments (company_id, canvas_id, card_id, created_at);
