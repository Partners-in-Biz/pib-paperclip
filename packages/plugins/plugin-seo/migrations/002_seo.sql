CREATE TABLE plugin_seo_8099f8879a.rank_history (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  keyword_id text NOT NULL REFERENCES plugin_seo_8099f8879a.keywords (id),
  rank integer NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX rank_history_keyword ON plugin_seo_8099f8879a.rank_history (keyword_id, recorded_at);
