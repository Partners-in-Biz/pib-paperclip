-- 0.25.0: pacing per sprint. Auto (every existing sprint) opens template tasks by the calendar, as before. Manual opens
-- none of them until a person presses Start on a week. The daily housekeeping (data pulls, snapshots, measurements) and the
-- weekly proposals keep running either way. released_at is when a person started the week of a task, or the task itself.

ALTER TABLE plugin_seo_8099f8879a.sprints ADD COLUMN pacing text NOT NULL DEFAULT 'auto';

ALTER TABLE plugin_seo_8099f8879a.sprints ADD CONSTRAINT sprints_pacing_check CHECK (pacing IN ('auto', 'manual'));

ALTER TABLE plugin_seo_8099f8879a.sprint_tasks ADD COLUMN released_at timestamptz;
