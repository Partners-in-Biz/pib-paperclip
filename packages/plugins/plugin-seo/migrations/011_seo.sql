-- Jev decisions (keyword intent). Kit decisionsMigration.
CREATE TABLE plugin_seo_8099f8879a.decisions (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  purpose text NOT NULL,
  subject_kind text NOT NULL,
  subject_id text NOT NULL,
  question_key text NOT NULL,
  answer_type text NOT NULL,
  value_text text,
  value_num numeric,
  confidence numeric NOT NULL,
  probabilities jsonb,
  model text NOT NULL,
  acted boolean NOT NULL DEFAULT false,
  corrected_to text,
  corrected_by text,
  corrected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX decisions_subject ON plugin_seo_8099f8879a.decisions (company_id, subject_kind, subject_id);
CREATE INDEX decisions_purpose ON plugin_seo_8099f8879a.decisions (company_id, purpose, created_at);
