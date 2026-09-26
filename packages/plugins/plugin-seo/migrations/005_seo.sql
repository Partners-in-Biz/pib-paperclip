-- Keywords are unique per sprint and phrase; positions build a real history.
ALTER TABLE plugin_seo_8099f8879a.keywords
  ADD COLUMN volume integer,
  ADD COLUMN intent text,
  ADD COLUMN target_url text,
  ADD COLUMN ranking_url text,
  ADD COLUMN difficulty_dr integer,
  ADD COLUMN is_priority boolean NOT NULL DEFAULT false,
  ADD COLUMN notes text,
  ADD COLUMN source text NOT NULL DEFAULT 'manual',
  ADD COLUMN current_position real,
  ADD COLUMN impressions integer,
  ADD COLUMN clicks integer,
  ADD COLUMN ctr real,
  ADD COLUMN status text NOT NULL DEFAULT 'not_yet',
  ADD COLUMN retired_at timestamptz,
  ADD COLUMN retired_reason text,
  ADD COLUMN last_pulled_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE plugin_seo_8099f8879a.rank_history
  ADD COLUMN sprint_id text,
  ADD COLUMN position real,
  ADD COLUMN impressions integer,
  ADD COLUMN clicks integer,
  ADD COLUMN ctr real,
  ADD COLUMN source text NOT NULL DEFAULT 'manual',
  ADD COLUMN recorded_on date;

ALTER TABLE plugin_seo_8099f8879a.rank_history ALTER COLUMN rank DROP NOT NULL;

-- The old record-rank inserted a new keyword row every time. Move the history of
-- every duplicate onto the oldest row with the same sprint and phrase ...
UPDATE plugin_seo_8099f8879a.rank_history h SET keyword_id = d.keep_id
FROM (
  SELECT k.id AS dup_id,
    (SELECT o.id FROM plugin_seo_8099f8879a.keywords o
      WHERE o.sprint_id = k.sprint_id AND lower(o.phrase) = lower(k.phrase)
      ORDER BY o.created_at, o.id LIMIT 1) AS keep_id
  FROM plugin_seo_8099f8879a.keywords k
) d
WHERE h.keyword_id = d.dup_id AND d.keep_id <> d.dup_id;

-- ... then retire the duplicates (rows are never deleted by a migration).
UPDATE plugin_seo_8099f8879a.keywords k SET retired_at = now(), retired_reason = 'duplicate'
WHERE EXISTS (
  SELECT 1 FROM plugin_seo_8099f8879a.keywords o
  WHERE o.sprint_id = k.sprint_id AND lower(o.phrase) = lower(k.phrase)
    AND (o.created_at < k.created_at OR (o.created_at = k.created_at AND o.id < k.id))
);

UPDATE plugin_seo_8099f8879a.rank_history h
SET sprint_id = k.sprint_id,
    position = h.rank,
    recorded_on = (h.recorded_at AT TIME ZONE 'Africa/Johannesburg')::date
FROM plugin_seo_8099f8879a.keywords k
WHERE k.id = h.keyword_id;

UPDATE plugin_seo_8099f8879a.keywords k
SET current_position = (
  SELECT h.position FROM plugin_seo_8099f8879a.rank_history h
  WHERE h.keyword_id = k.id AND h.position IS NOT NULL
  ORDER BY h.recorded_at DESC LIMIT 1
)
WHERE k.retired_at IS NULL;

UPDATE plugin_seo_8099f8879a.keywords SET current_position = rank WHERE current_position IS NULL AND rank IS NOT NULL;

UPDATE plugin_seo_8099f8879a.keywords
SET status = CASE
  WHEN current_position <= 3 THEN 'top_3'
  WHEN current_position <= 10 THEN 'top_10'
  WHEN current_position <= 100 THEN 'ranking'
  ELSE 'not_yet' END
WHERE current_position IS NOT NULL AND current_position > 0;

CREATE UNIQUE INDEX keywords_sprint_phrase ON plugin_seo_8099f8879a.keywords (sprint_id, lower(phrase)) WHERE retired_at IS NULL;

CREATE INDEX keywords_sprint ON plugin_seo_8099f8879a.keywords (sprint_id);

CREATE UNIQUE INDEX rank_history_gsc_day ON plugin_seo_8099f8879a.rank_history (keyword_id, source, recorded_on) WHERE source = 'gsc';

CREATE INDEX rank_history_sprint ON plugin_seo_8099f8879a.rank_history (sprint_id, recorded_on);
