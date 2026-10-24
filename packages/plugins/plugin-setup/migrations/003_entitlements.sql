-- What each company bought (PAR-5153). One row per company and module; written only by an
-- operator-company owner or admin (setup.set-entitlements). No rows = cockpit and memory only.
-- Existing companies are entitled to everything (plan 'pib') by the plugin's first start after
-- this migration, so nothing changes for them.
-- Undo: DROP TABLE plugin_setup_48494712db.entitlements (the old code never reads it).
CREATE TABLE plugin_setup_48494712db.entitlements (
  company_id text NOT NULL,
  module text NOT NULL,
  state text NOT NULL CHECK (state IN ('entitled', 'trial', 'off')),
  plan text,
  until timestamptz,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, module)
);
