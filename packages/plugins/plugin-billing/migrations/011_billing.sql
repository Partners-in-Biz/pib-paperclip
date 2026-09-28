-- Billing 0.5: origin ids that name the module and the kind of work, when a standing issue
-- was last opened (done checks count work since then), what the issue was about, and
-- follow-up notes agents log on invoices, quotes, bills and won deals.

-- Standing work issues: the key is the Paperclip issue origin id, billing:<kind>:<id>.
UPDATE plugin_billing_287195dc99.work_issues SET key = 'billing:drafts-to-send:' || company_id WHERE kind = 'drafts' AND key LIKE 'digest:drafts:%';

UPDATE plugin_billing_287195dc99.work_issues SET key = 'billing:overdue-invoices:' || company_id WHERE kind = 'overdue' AND key LIKE 'digest:overdue:%';

UPDATE plugin_billing_287195dc99.work_issues SET key = 'billing:quote-reply:' || subject_id WHERE kind = 'quote_reply' AND key LIKE 'quote-reply:%' AND subject_id IS NOT NULL;

UPDATE plugin_billing_287195dc99.work_issues SET key = 'billing:deal-won:' || subject_id WHERE kind = 'deal_won' AND key LIKE 'deal-won:%' AND subject_id IS NOT NULL;

ALTER TABLE plugin_billing_287195dc99.work_issues
  ADD COLUMN IF NOT EXISTS opened_at timestamptz,
  ADD COLUMN IF NOT EXISTS detail jsonb;

UPDATE plugin_billing_287195dc99.work_issues SET opened_at = created_at WHERE opened_at IS NULL;

-- What an agent did or decided that leaves no other trace in Billing (a reply drafted in the
-- Mailbox, what the owner decided, a promise to pay). Internal only, never on a document.
CREATE TABLE plugin_billing_287195dc99.follow_ups (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  subject_kind text NOT NULL,
  subject_id text NOT NULL,
  note text NOT NULL,
  mail_draft_id text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT follow_ups_subject_kind CHECK (subject_kind IN ('invoice', 'quote', 'bill', 'deal'))
);

CREATE INDEX follow_ups_subject ON plugin_billing_287195dc99.follow_ups (company_id, subject_kind, subject_id, created_at);
