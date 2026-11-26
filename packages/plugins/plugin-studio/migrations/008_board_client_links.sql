-- Board client links (PAR-14847, plan PAR-14835 Approach 1): which CRM client a Planning Canvas board is for. Append-only:
-- a set is one row with the client, a clear is one row with the client columns NULL, and the link of a board is its latest
-- row. Every change is its own row with the person and the time, so the link and its log cannot disagree.
-- The kind is tested IS NOT NULL first: a NULL IN (...) is NULL, and a CHECK passes on NULL.
-- Rollback: reinstall the previous Studio build; this table is then unused and harmless (plugin migrations cannot remove tables).
CREATE TABLE plugin_studio_e414325bb6.board_client_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL,
  board_id text NOT NULL,
  client_kind text,
  client_ref text,
  client_name text,
  user_id text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT board_client_links_all_or_none CHECK (
    (client_kind IS NULL AND client_ref IS NULL AND client_name IS NULL)
    OR (client_kind IS NOT NULL AND client_kind IN ('company', 'contact') AND client_ref IS NOT NULL AND client_name IS NOT NULL)
  )
);

CREATE INDEX board_client_links_latest ON plugin_studio_e414325bb6.board_client_links (company_id, board_id, at DESC, id DESC);
