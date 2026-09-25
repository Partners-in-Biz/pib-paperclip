CREATE TABLE plugin_social_e70c4e79f2.post_metrics (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  post_id text NOT NULL REFERENCES plugin_social_e70c4e79f2.posts (id),
  views integer NOT NULL DEFAULT 0,
  likes integer NOT NULL DEFAULT 0,
  comments integer NOT NULL DEFAULT 0,
  shares integer NOT NULL DEFAULT 0,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX post_metrics_post ON plugin_social_e70c4e79f2.post_metrics (post_id);
