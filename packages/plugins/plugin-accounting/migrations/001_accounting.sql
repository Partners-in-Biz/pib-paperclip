-- Accounting: the books every PiB plugin posts to. Money is integer minor units.

CREATE TABLE plugin_accounting_03d0185a67.books (
  company_id text PRIMARY KEY,
  currency text NOT NULL DEFAULT 'ZAR',
  chart_template text NOT NULL,
  seeded_at timestamptz NOT NULL DEFAULT now(),
  rejection_issue_id text,
  cutover_date date,
  opening_journal_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plugin_accounting_03d0185a67.accounts (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  type text NOT NULL,
  subtype text NOT NULL,
  cash_flow text NOT NULL DEFAULT 'operating',
  description text NOT NULL DEFAULT '',
  system boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_type CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  CONSTRAINT accounts_cash_flow CHECK (cash_flow IN ('cash', 'operating', 'investing', 'financing', 'none'))
);

CREATE UNIQUE INDEX accounts_code ON plugin_accounting_03d0185a67.accounts (company_id, code);

CREATE TABLE plugin_accounting_03d0185a67.account_roles (
  company_id text NOT NULL,
  role text NOT NULL,
  account_code text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, role)
);

CREATE TABLE plugin_accounting_03d0185a67.periods (
  company_id text NOT NULL,
  period text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  changed_by text,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, period),
  CONSTRAINT periods_status CHECK (status IN ('open', 'soft_closed', 'closed'))
);

CREATE TABLE plugin_accounting_03d0185a67.journals (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  seq bigint NOT NULL,
  number text NOT NULL,
  date date NOT NULL,
  memo text NOT NULL DEFAULT '',
  kind text NOT NULL,
  currency text NOT NULL,
  fx_rate numeric,
  book_currency text NOT NULL,
  total_minor bigint NOT NULL,
  lines jsonb NOT NULL,
  source_key text NOT NULL,
  source jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'posted',
  reverses_id text,
  reversed_by_id text,
  posted_by jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash text NOT NULL,
  hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT journals_status CHECK (status IN ('posted', 'reversed'))
);

CREATE UNIQUE INDEX journals_seq ON plugin_accounting_03d0185a67.journals (company_id, seq);

CREATE UNIQUE INDEX journals_source ON plugin_accounting_03d0185a67.journals (company_id, source_key);

CREATE INDEX journals_date ON plugin_accounting_03d0185a67.journals (company_id, date);

CREATE INDEX journals_reverses ON plugin_accounting_03d0185a67.journals (reverses_id) WHERE reverses_id IS NOT NULL;

CREATE TABLE plugin_accounting_03d0185a67.journal_drafts (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  date date NOT NULL,
  memo text NOT NULL DEFAULT '',
  currency text NOT NULL DEFAULT 'ZAR',
  fx_rate numeric,
  lines jsonb NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  approval_issue_id text,
  created_by jsonb NOT NULL DEFAULT '{}'::jsonb,
  approved_by text,
  journal_id text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT journal_drafts_status CHECK (status IN ('draft', 'pending_approval', 'posted', 'rejected', 'cancelled'))
);

CREATE INDEX journal_drafts_company ON plugin_accounting_03d0185a67.journal_drafts (company_id, status);

CREATE TABLE plugin_accounting_03d0185a67.posting_rejections (
  company_id text NOT NULL,
  key text NOT NULL,
  event text NOT NULL,
  source jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload jsonb NOT NULL,
  error text NOT NULL,
  attempts integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'open',
  journal_id text,
  first_at timestamptz NOT NULL DEFAULT now(),
  last_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  PRIMARY KEY (company_id, key),
  CONSTRAINT posting_rejections_status CHECK (status IN ('open', 'resolved', 'dismissed'))
);

CREATE TABLE plugin_accounting_03d0185a67.tax_rates (
  company_id text NOT NULL,
  code text NOT NULL,
  version integer NOT NULL,
  label text NOT NULL,
  kind text NOT NULL,
  rate_bps integer NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  source text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, code, version),
  CONSTRAINT tax_rates_kind CHECK (kind IN ('standard', 'capital', 'zero', 'export', 'exempt', 'out_of_scope'))
);

CREATE TABLE plugin_accounting_03d0185a67.bank_accounts (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  name text NOT NULL,
  account_code text NOT NULL,
  bank_name text NOT NULL DEFAULT '',
  number_last4 text NOT NULL DEFAULT '',
  currency text NOT NULL DEFAULT 'ZAR',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX bank_accounts_company ON plugin_accounting_03d0185a67.bank_accounts (company_id);

CREATE TABLE plugin_accounting_03d0185a67.statements (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  bank_account_id text NOT NULL REFERENCES plugin_accounting_03d0185a67.bank_accounts (id),
  file_name text NOT NULL DEFAULT '',
  format text NOT NULL,
  object_key text,
  content_digest text NOT NULL,
  line_count integer NOT NULL DEFAULT 0,
  new_count integer NOT NULL DEFAULT 0,
  duplicate_count integer NOT NULL DEFAULT 0,
  period_start date,
  period_end date,
  opening_minor bigint,
  closing_minor bigint,
  imported_by jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX statements_digest ON plugin_accounting_03d0185a67.statements (bank_account_id, content_digest);

CREATE TABLE plugin_accounting_03d0185a67.bank_lines (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  bank_account_id text NOT NULL REFERENCES plugin_accounting_03d0185a67.bank_accounts (id),
  statement_id text,
  date date NOT NULL,
  amount_minor bigint NOT NULL,
  description text NOT NULL DEFAULT '',
  reference text,
  counterparty text,
  balance_minor bigint,
  fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'unreconciled',
  suggestions jsonb NOT NULL DEFAULT '[]'::jsonb,
  jev jsonb,
  match jsonb,
  journal_id text,
  reconciliation_id text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_lines_status CHECK (status IN ('unreconciled', 'matching', 'reconciled', 'excluded'))
);

CREATE UNIQUE INDEX bank_lines_fingerprint ON plugin_accounting_03d0185a67.bank_lines (bank_account_id, fingerprint);

CREATE INDEX bank_lines_account ON plugin_accounting_03d0185a67.bank_lines (company_id, bank_account_id, date);

CREATE INDEX bank_lines_journal ON plugin_accounting_03d0185a67.bank_lines (journal_id) WHERE journal_id IS NOT NULL;

CREATE TABLE plugin_accounting_03d0185a67.bank_rules (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  name text NOT NULL,
  priority integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  field text NOT NULL,
  operator text NOT NULL,
  value text NOT NULL DEFAULT '',
  amount_min_minor bigint,
  amount_max_minor bigint,
  direction text NOT NULL DEFAULT 'any',
  account_code text NOT NULL,
  tax_code text,
  counterparty text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_rules_field CHECK (field IN ('description', 'counterparty', 'reference', 'amount')),
  CONSTRAINT bank_rules_operator CHECK (operator IN ('contains', 'starts_with', 'equals', 'amount_between')),
  CONSTRAINT bank_rules_direction CHECK (direction IN ('any', 'in', 'out'))
);

CREATE INDEX bank_rules_company ON plugin_accounting_03d0185a67.bank_rules (company_id, priority);

CREATE TABLE plugin_accounting_03d0185a67.open_items (
  company_id text NOT NULL,
  key text NOT NULL,
  kind text NOT NULL,
  item_id text NOT NULL,
  number text NOT NULL DEFAULT '',
  counterparty_name text NOT NULL DEFAULT '',
  client_kind text,
  client_ref text,
  currency text NOT NULL,
  total_minor bigint NOT NULL,
  outstanding_minor bigint NOT NULL,
  issue_date date,
  due_date date,
  refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT '',
  source_plugin text NOT NULL DEFAULT '',
  source_updated_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, key),
  CONSTRAINT open_items_kind CHECK (kind IN ('receivable', 'payable'))
);

CREATE INDEX open_items_open ON plugin_accounting_03d0185a67.open_items (company_id, kind, outstanding_minor);

CREATE TABLE plugin_accounting_03d0185a67.reconciliations (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  bank_account_id text NOT NULL REFERENCES plugin_accounting_03d0185a67.bank_accounts (id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  opening_minor bigint NOT NULL,
  closing_minor bigint NOT NULL,
  lines_total_minor bigint NOT NULL DEFAULT 0,
  difference_minor bigint NOT NULL DEFAULT 0,
  unreconciled_count integer NOT NULL DEFAULT 0,
  gl_balance_minor bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft',
  approval_issue_id text,
  prepared_by jsonb NOT NULL DEFAULT '{}'::jsonb,
  approved_by text,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reconciliations_status CHECK (status IN ('draft', 'pending_approval', 'locked'))
);

CREATE UNIQUE INDEX reconciliations_period ON plugin_accounting_03d0185a67.reconciliations (bank_account_id, period_start, period_end);

CREATE TABLE plugin_accounting_03d0185a67.vat_returns (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  boxes jsonb NOT NULL DEFAULT '{}'::jsonb,
  detail jsonb NOT NULL DEFAULT '[]'::jsonb,
  adjustments jsonb NOT NULL DEFAULT '{}'::jsonb,
  approval_issue_id text,
  prepared_by jsonb NOT NULL DEFAULT '{}'::jsonb,
  prepared_at timestamptz NOT NULL DEFAULT now(),
  approved_by text,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vat_returns_status CHECK (status IN ('draft', 'pending_approval', 'locked'))
);

CREATE UNIQUE INDEX vat_returns_period ON plugin_accounting_03d0185a67.vat_returns (company_id, period_start, period_end);

CREATE TABLE plugin_accounting_03d0185a67.budgets (
  company_id text NOT NULL,
  account_code text NOT NULL,
  month text NOT NULL,
  amount_minor bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, account_code, month)
);

CREATE TABLE plugin_accounting_03d0185a67.forecast_lines (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  month text NOT NULL,
  description text NOT NULL,
  amount_minor bigint NOT NULL,
  repeat text NOT NULL DEFAULT 'none',
  until_month text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT forecast_lines_repeat CHECK (repeat IN ('none', 'monthly'))
);

CREATE INDEX forecast_lines_company ON plugin_accounting_03d0185a67.forecast_lines (company_id, month);

CREATE TABLE plugin_accounting_03d0185a67.assets (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  name text NOT NULL,
  category text NOT NULL DEFAULT '',
  asset_account_code text NOT NULL,
  accumulated_account_code text NOT NULL,
  expense_account_code text NOT NULL,
  cost_minor bigint NOT NULL,
  residual_minor bigint NOT NULL DEFAULT 0,
  life_months integer NOT NULL,
  acquired_date date NOT NULL,
  depreciation_start date NOT NULL,
  opening_accumulated_minor bigint NOT NULL DEFAULT 0,
  opening_through text,
  status text NOT NULL DEFAULT 'active',
  disposed_date date,
  disposal_proceeds_minor bigint,
  disposal_account_code text,
  disposal_journal_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assets_status CHECK (status IN ('active', 'disposed'))
);

CREATE INDEX assets_company ON plugin_accounting_03d0185a67.assets (company_id, status);

CREATE TABLE plugin_accounting_03d0185a67.fx_rates (
  base text NOT NULL,
  currency text NOT NULL,
  date date NOT NULL,
  rate numeric NOT NULL,
  source text NOT NULL DEFAULT 'frankfurter',
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (base, currency, date)
);

CREATE TABLE plugin_accounting_03d0185a67.job_marks (
  company_id text NOT NULL,
  mark text NOT NULL,
  value text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, mark)
);

CREATE TABLE plugin_accounting_03d0185a67.outbox (
  key text PRIMARY KEY,
  company_id text NOT NULL,
  event text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CONSTRAINT outbox_status CHECK (status IN ('pending', 'done', 'failed'))
);

CREATE INDEX outbox_due ON plugin_accounting_03d0185a67.outbox (status, next_attempt_at);

CREATE TABLE plugin_accounting_03d0185a67.inbox (
  key text PRIMARY KEY,
  company_id text NOT NULL,
  event text NOT NULL,
  result jsonb,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plugin_accounting_03d0185a67.decisions (
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

CREATE INDEX decisions_subject ON plugin_accounting_03d0185a67.decisions (company_id, subject_kind, subject_id);

CREATE INDEX decisions_purpose ON plugin_accounting_03d0185a67.decisions (company_id, purpose, created_at);
