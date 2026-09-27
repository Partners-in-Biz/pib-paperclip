-- 0.8.0: content.published goes to Social only once the change is live.
-- One row per hand-off key (seo:content:<id> or seo:content:task-<id>). A row waits until any
-- approved pull request is merged (wait_task_id is the merge task) and the page answers 200,
-- then it is sent, and re-sent for 24 hours because events arrive at most once.
-- status: waiting, sent, stuck (still not live 3 days after queued_at; shown in the Cockpit and in today)
-- or dropped (the content row or task is no longer live or done).
CREATE TABLE plugin_seo_8099f8879a.announcements (
  key text PRIMARY KEY,
  company_id text NOT NULL,
  sprint_id text NOT NULL,
  content_id text,
  task_id text,
  wait_task_id text,
  url text,
  status text NOT NULL DEFAULT 'waiting',
  checks integer NOT NULL DEFAULT 0,
  last_http_status integer,
  last_error text,
  payload jsonb,
  queued_at timestamptz NOT NULL DEFAULT now(),
  next_check_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  CONSTRAINT announcements_status_check CHECK (status IN ('waiting', 'sent', 'stuck', 'dropped'))
);

CREATE INDEX announcements_due ON plugin_seo_8099f8879a.announcements (company_id, status, next_check_at);

CREATE INDEX announcements_wait ON plugin_seo_8099f8879a.announcements (company_id, wait_task_id);
