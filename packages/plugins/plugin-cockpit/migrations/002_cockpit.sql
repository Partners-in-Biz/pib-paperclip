-- Company memory: short facts agents learn, the briefs each task got, and
-- the feedback that tunes them. Facts are never deleted: they are superseded
-- (replaced by a newer fact) or archived (kept, but no longer in briefs).
-- origin: tool = memory-add, harvest = a Learned line in a comment,
-- person = added on the Memory tab of the Cockpit.
CREATE TABLE plugin_cockpit_b8a99e8b16.memory_facts (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  client_ref text,
  client_name text,
  area text NOT NULL DEFAULT 'general',
  kind text NOT NULL DEFAULT 'fact',
  text text NOT NULL,
  text_hash text NOT NULL,
  pinned boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  supersedes text,
  superseded_by text,
  source_issue_id text,
  source_identifier text,
  source_run_id text,
  source_comment_id text,
  origin text NOT NULL DEFAULT 'tool',
  created_by_agent_id text,
  created_by_user_id text,
  expires_at timestamptz,
  use_count integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  helpful_count integer NOT NULL DEFAULT 0,
  noise_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_facts_status CHECK (status IN ('active', 'superseded', 'archived')),
  CONSTRAINT memory_facts_kind CHECK (kind IN ('fact', 'preference', 'rule', 'lesson', 'warning')),
  CONSTRAINT memory_facts_origin CHECK (origin IN ('tool', 'harvest', 'person')),
  CONSTRAINT memory_facts_text_len CHECK (char_length(text) BETWEEN 1 AND 400)
);
CREATE INDEX memory_facts_scope ON plugin_cockpit_b8a99e8b16.memory_facts (company_id, status, client_ref, area);
CREATE INDEX memory_facts_updated ON plugin_cockpit_b8a99e8b16.memory_facts (company_id, updated_at DESC);
CREATE UNIQUE INDEX memory_facts_active_hash ON plugin_cockpit_b8a99e8b16.memory_facts (company_id, text_hash) WHERE status = 'active';

-- Every brief an agent got: which facts, how they were picked, and what the
-- keyword baseline would have picked (to compare methods from feedback).
CREATE TABLE plugin_cockpit_b8a99e8b16.memory_briefs (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  issue_id text,
  issue_identifier text,
  agent_id text,
  run_id text,
  query text,
  client_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  area text,
  method text NOT NULL,
  model text,
  version text NOT NULL,
  total_facts integer NOT NULL DEFAULT 0,
  candidate_count integer NOT NULL DEFAULT 0,
  fact_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  baseline_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  scores jsonb NOT NULL DEFAULT '{}'::jsonb,
  tokens integer NOT NULL DEFAULT 0,
  jev_input_tokens integer NOT NULL DEFAULT 0,
  latency_ms integer NOT NULL DEFAULT 0,
  facts_version text,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_briefs_method CHECK (method IN ('jev', 'baseline', 'empty', 'search'))
);
CREATE INDEX memory_briefs_issue ON plugin_cockpit_b8a99e8b16.memory_briefs (company_id, issue_id, agent_id, created_at DESC);
CREATE INDEX memory_briefs_recent ON plugin_cockpit_b8a99e8b16.memory_briefs (company_id, created_at DESC);

-- Agent (or person) feedback on a brief: a needed fact that was missing, or
-- a fact that was noise. `in_baseline` says whether the keyword baseline
-- would have included a missing fact.
CREATE TABLE plugin_cockpit_b8a99e8b16.memory_feedback (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  brief_id text,
  issue_id text,
  agent_id text,
  user_id text,
  kind text NOT NULL,
  fact_id text,
  text text,
  in_baseline boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_feedback_kind CHECK (kind IN ('missing', 'noise', 'wrong'))
);
CREATE INDEX memory_feedback_recent ON plugin_cockpit_b8a99e8b16.memory_feedback (company_id, created_at DESC);
