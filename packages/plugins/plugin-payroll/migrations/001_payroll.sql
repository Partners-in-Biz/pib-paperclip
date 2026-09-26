-- Payroll (partnersinbiz.payroll), namespace plugin_payroll_c6fcddb95c.
-- Money is integer cents, hours are centi-hours, leave is centi-days.
-- ID / passport, tax reference and bank details are only ever stored sealed
-- (AES-256-GCM, sealed_* columns); pii_masks holds the last digits for display.

CREATE TABLE plugin_payroll_c6fcddb95c.rule_versions (
  id text PRIMARY KEY,
  tax_year text NOT NULL,
  version integer NOT NULL,
  effective_from date NOT NULL,
  effective_to date NOT NULL,
  status text NOT NULL DEFAULT 'published',
  rules jsonb NOT NULL,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  unverified jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes jsonb NOT NULL DEFAULT '[]'::jsonb,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rule_versions_status CHECK (status IN ('published', 'draft'))
);

CREATE UNIQUE INDEX rule_versions_year_version ON plugin_payroll_c6fcddb95c.rule_versions (tax_year, version);

CREATE TABLE plugin_payroll_c6fcddb95c.employees (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  employee_number text NOT NULL,
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text,
  phone text,
  job_title text,
  date_of_birth date,
  start_date date NOT NULL,
  end_date date,
  status text NOT NULL DEFAULT 'active',
  tax_residency text NOT NULL DEFAULT 'resident',
  sealed_identity text,
  sealed_tax text,
  sealed_bank text,
  pii_masks jsonb NOT NULL DEFAULT '{}'::jsonb,
  key_version integer,
  eti_eligible boolean NOT NULL DEFAULT false,
  eti_months_before integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employees_status CHECK (status IN ('active', 'terminated')),
  CONSTRAINT employees_residency CHECK (tax_residency IN ('resident', 'non_resident'))
);

CREATE UNIQUE INDEX employees_number ON plugin_payroll_c6fcddb95c.employees (company_id, employee_number);
CREATE INDEX employees_company ON plugin_payroll_c6fcddb95c.employees (company_id, status);

CREATE TABLE plugin_payroll_c6fcddb95c.employment_terms (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  employee_id text NOT NULL REFERENCES plugin_payroll_c6fcddb95c.employees (id),
  version integer NOT NULL,
  effective_from date NOT NULL,
  frequency text NOT NULL,
  worker_category text NOT NULL,
  rate_minor bigint NOT NULL,
  standard_hours_centi integer NOT NULL DEFAULT 0,
  hours_per_day_centi integer NOT NULL DEFAULT 800,
  days_per_week integer NOT NULL DEFAULT 5,
  overtime_multiplier_bp integer NOT NULL DEFAULT 15000,
  uif_applicable boolean NOT NULL DEFAULT true,
  sdl_applicable boolean NOT NULL DEFAULT true,
  medical jsonb,
  retirement jsonb,
  travel jsonb,
  annual_leave_days integer,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employment_terms_frequency CHECK (frequency IN ('monthly', 'fortnightly', 'weekly')),
  CONSTRAINT employment_terms_category CHECK (worker_category IN ('salaried', 'hourly')),
  CONSTRAINT employment_terms_rate CHECK (rate_minor >= 0)
);

CREATE UNIQUE INDEX employment_terms_version ON plugin_payroll_c6fcddb95c.employment_terms (employee_id, version);

CREATE TABLE plugin_payroll_c6fcddb95c.components (
  company_id text NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL,
  sars_code text,
  taxable boolean NOT NULL,
  irregular boolean NOT NULL DEFAULT false,
  uif boolean NOT NULL,
  sdl boolean NOT NULL,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, code)
);

CREATE TABLE plugin_payroll_c6fcddb95c.recurring_components (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  employee_id text NOT NULL REFERENCES plugin_payroll_c6fcddb95c.employees (id),
  code text NOT NULL,
  amount_minor bigint NOT NULL,
  label text,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recurring_components_amount CHECK (amount_minor >= 0)
);

CREATE UNIQUE INDEX recurring_components_code ON plugin_payroll_c6fcddb95c.recurring_components (employee_id, code);

CREATE TABLE plugin_payroll_c6fcddb95c.pay_runs (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  number text NOT NULL,
  kind text NOT NULL DEFAULT 'regular',
  frequency text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  pay_date date NOT NULL,
  tax_year text NOT NULL,
  rule_version_id text,
  status text NOT NULL DEFAULT 'draft',
  prepared_by_user_id text,
  prepared_by_agent_id text,
  prepared_at timestamptz,
  approver_user_id text,
  approval_issue_id text,
  approval_requested_at timestamptz,
  approved_by_user_id text,
  approved_at timestamptz,
  locked_by_user_id text,
  locked_at timestamptz,
  reverses_run_id text,
  corrects_run_id text,
  reversed_by_run_id text,
  ledger_status text NOT NULL DEFAULT 'none',
  journal_id text,
  journal_number text,
  ledger_error text,
  totals jsonb NOT NULL DEFAULT '{}'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pay_runs_kind CHECK (kind IN ('regular', 'correction', 'reversal')),
  CONSTRAINT pay_runs_frequency CHECK (frequency IN ('monthly', 'fortnightly', 'weekly')),
  CONSTRAINT pay_runs_status CHECK (status IN ('draft', 'calculated', 'pending_approval', 'approved', 'locked', 'reversed', 'cancelled')),
  CONSTRAINT pay_runs_ledger CHECK (ledger_status IN ('none', 'pending', 'posted', 'rejected', 'failed'))
);

CREATE UNIQUE INDEX pay_runs_number ON plugin_payroll_c6fcddb95c.pay_runs (company_id, number);
CREATE INDEX pay_runs_company ON plugin_payroll_c6fcddb95c.pay_runs (company_id, pay_date);
CREATE INDEX pay_runs_approval ON plugin_payroll_c6fcddb95c.pay_runs (approval_issue_id);

CREATE TABLE plugin_payroll_c6fcddb95c.pay_run_inputs (
  run_id text NOT NULL REFERENCES plugin_payroll_c6fcddb95c.pay_runs (id),
  employee_id text NOT NULL,
  company_id text NOT NULL,
  inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by_user_id text,
  updated_by_agent_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, employee_id)
);

CREATE TABLE plugin_payroll_c6fcddb95c.pay_run_items (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  run_id text NOT NULL REFERENCES plugin_payroll_c6fcddb95c.pay_runs (id),
  employee_id text NOT NULL,
  terms_id text,
  status text NOT NULL DEFAULT 'ok',
  error text,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  gross_minor bigint NOT NULL DEFAULT 0,
  taxable_minor bigint NOT NULL DEFAULT 0,
  paye_minor bigint NOT NULL DEFAULT 0,
  uif_employee_minor bigint NOT NULL DEFAULT 0,
  uif_employer_minor bigint NOT NULL DEFAULT 0,
  sdl_minor bigint NOT NULL DEFAULT 0,
  eti_minor bigint NOT NULL DEFAULT 0,
  deductions_minor bigint NOT NULL DEFAULT 0,
  employer_contributions_minor bigint NOT NULL DEFAULT 0,
  net_minor bigint NOT NULL DEFAULT 0,
  employer_cost_minor bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pay_run_items_status CHECK (status IN ('ok', 'error', 'excluded'))
);

CREATE UNIQUE INDEX pay_run_items_employee ON plugin_payroll_c6fcddb95c.pay_run_items (run_id, employee_id);
CREATE INDEX pay_run_items_company_employee ON plugin_payroll_c6fcddb95c.pay_run_items (company_id, employee_id);

CREATE TABLE plugin_payroll_c6fcddb95c.payslips (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  run_id text NOT NULL REFERENCES plugin_payroll_c6fcddb95c.pay_runs (id),
  employee_id text NOT NULL,
  number text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  r2_key text,
  bytes integer,
  sha256 text,
  mail_key text,
  emailed_to text,
  emailed_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payslips_status CHECK (status IN ('pending', 'ready', 'sending', 'sent', 'failed'))
);

CREATE UNIQUE INDEX payslips_run_employee ON plugin_payroll_c6fcddb95c.payslips (run_id, employee_id);
CREATE INDEX payslips_mail_key ON plugin_payroll_c6fcddb95c.payslips (mail_key);

CREATE TABLE plugin_payroll_c6fcddb95c.leave_requests (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  employee_id text NOT NULL REFERENCES plugin_payroll_c6fcddb95c.employees (id),
  leave_type text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  days_centi integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  reason text,
  approval_issue_id text,
  requested_by_user_id text,
  requested_by_agent_id text,
  decided_by_user_id text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leave_requests_type CHECK (leave_type IN ('annual', 'sick', 'family', 'unpaid')),
  CONSTRAINT leave_requests_status CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  CONSTRAINT leave_requests_days CHECK (days_centi > 0)
);

CREATE INDEX leave_requests_employee ON plugin_payroll_c6fcddb95c.leave_requests (company_id, employee_id);
CREATE INDEX leave_requests_issue ON plugin_payroll_c6fcddb95c.leave_requests (approval_issue_id);

CREATE TABLE plugin_payroll_c6fcddb95c.leave_openings (
  company_id text NOT NULL,
  employee_id text NOT NULL REFERENCES plugin_payroll_c6fcddb95c.employees (id),
  leave_type text NOT NULL,
  days_centi integer NOT NULL,
  as_of date NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, leave_type)
);

CREATE TABLE plugin_payroll_c6fcddb95c.ytd_openings (
  company_id text NOT NULL,
  employee_id text NOT NULL REFERENCES plugin_payroll_c6fcddb95c.employees (id),
  tax_year text NOT NULL,
  codes jsonb NOT NULL DEFAULT '{}'::jsonb,
  gross_minor bigint NOT NULL DEFAULT 0,
  paye_minor bigint NOT NULL DEFAULT 0,
  uif_minor bigint NOT NULL DEFAULT 0,
  sdl_minor bigint NOT NULL DEFAULT 0,
  eti_minor bigint NOT NULL DEFAULT 0,
  imported_by_user_id text,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, tax_year)
);

CREATE TABLE plugin_payroll_c6fcddb95c.exports (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  kind text NOT NULL,
  ref text NOT NULL,
  file_name text NOT NULL,
  content_type text NOT NULL,
  r2_key text,
  bytes integer NOT NULL DEFAULT 0,
  sha256 text,
  row_count integer NOT NULL DEFAULT 0,
  created_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX exports_company ON plugin_payroll_c6fcddb95c.exports (company_id, created_at);

CREATE TABLE plugin_payroll_c6fcddb95c.audit (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  actor_user_id text,
  actor_agent_id text,
  action text NOT NULL,
  entity_kind text NOT NULL,
  entity_id text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX audit_company ON plugin_payroll_c6fcddb95c.audit (company_id, at);

CREATE TABLE plugin_payroll_c6fcddb95c.outbox (
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

CREATE INDEX outbox_due ON plugin_payroll_c6fcddb95c.outbox (status, next_attempt_at);

CREATE TABLE plugin_payroll_c6fcddb95c.inbox (
  key text PRIMARY KEY,
  company_id text NOT NULL,
  event text NOT NULL,
  result jsonb,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- Rule version for the 2026/27 tax year (src/seed.ts; figures verified on sars.gov.za 2026-09-26)
INSERT INTO plugin_payroll_c6fcddb95c.rule_versions (id, tax_year, version, effective_from, effective_to, status, rules, sources, unverified, notes, content_hash)
VALUES ('za-2026-27-v1', '2026/27', 1, '2026-03-01', '2027-02-28', 'published',
  '{"endDate":"2027-02-28","eti":{"effectiveFrom":"2025-04-01","firstYear":[{"kind":"percent","rateBp":6000,"upToMinor":249999},{"amountMinor":150000,"kind":"fixed","upToMinor":549999},{"amountMinor":150000,"kind":"taper","taperBp":7500,"taperFromMinor":550000,"upToMinor":749999},{"kind":"none","upToMinor":null}],"maxAge":29,"maxQualifyingMonths":24,"minAge":18,"minimumWageHourlyMinor":3023,"secondYear":[{"kind":"percent","rateBp":3000,"upToMinor":249999},{"amountMinor":75000,"kind":"fixed","upToMinor":549999},{"amountMinor":75000,"kind":"taper","taperBp":3750,"taperFromMinor":550000,"upToMinor":749999},{"kind":"none","upToMinor":null}],"standardMonthlyHours":160,"wholeClaimLostBelowMinimumWage":true},"medicalCredits":{"additionalDependantMinor":25400,"firstDependantMinor":37600,"mainMemberMinor":37600},"paye":{"brackets":[{"aboveMinor":0,"baseTaxMinor":0,"rateBp":1800,"upToMinor":24510000},{"aboveMinor":24510000,"baseTaxMinor":4411800,"rateBp":2600,"upToMinor":38310000},{"aboveMinor":38310000,"baseTaxMinor":7999800,"rateBp":3100,"upToMinor":53020000},{"aboveMinor":53020000,"baseTaxMinor":12559900,"rateBp":3600,"upToMinor":69580000},{"aboveMinor":69580000,"baseTaxMinor":18521500,"rateBp":3900,"upToMinor":88700000},{"aboveMinor":88700000,"baseTaxMinor":25978300,"rateBp":4100,"upToMinor":187860000},{"aboveMinor":187860000,"baseTaxMinor":66633900,"rateBp":4500,"upToMinor":null}]},"periods":{"fortnightly":26,"monthly":12,"weekly":52},"rebates":{"primaryMinor":1782000,"secondaryAge":65,"secondaryMinor":976500,"tertiaryAge":75,"tertiaryMinor":324900},"retirement":{"annualCapMinor":43000000,"deductionRateBp":2750},"sdl":{"afterRetirementDeduction":true,"annualExemptionThresholdMinor":50000000,"rateBp":100},"startDate":"2026-03-01","taxYear":"2026/27","thresholds":{"age65to74Minor":15325000,"age75PlusMinor":17130000,"under65Minor":9900000},"travel":{"businessUseInclusionBp":2000,"inclusionBp":8000,"reimbursiveRatePerKmMinor":495},"uif":{"employeeRateBp":100,"employerRateBp":100,"monthlyCeilingMinor":1771200}}'::jsonb,
  '[{"covers":["paye.brackets","rebates","thresholds"],"title":"SARS: Rates of tax for individuals (2027 tax year)","url":"https://www.sars.gov.za/tax-rates/income-tax/rates-of-tax-for-individuals/","accessed":"2026-09-26","note":"Page last updated 17/03/2026. Same figures in the PAYE-GEN-01-G21 and PAYE-GEN-01-G01 guides."},{"covers":["paye","rebates","thresholds","medicalCredits","uif","sdl","retirement","travel"],"title":"SARS PAYE-GEN-01-G21: Guide for employers in respect of employees'' tax for 2027 (Revision 1)","url":"https://www.sars.gov.za/wp-content/uploads/Ops/Guides/PAYE-GEN-01-G21-Guide-for-Employers-iro-Employees-Tax-for-2027-External-Guide.pdf","accessed":"2026-09-26","note":"Deduction tables in effect from 1 March 2026; bonus method; SDL on the balance after allowable deductions."},{"covers":["paye.brackets","rebates"],"title":"SARS PAYE-GEN-01-G01: Guide for employers in respect of tax deduction tables (Revision 16)","url":"https://www.sars.gov.za/wp-content/uploads/Ops/Guides/PAYE-GEN-01-G01-Guide-for-Employers-in-respect-of-Tax-Deduction-Tables-External-Guide.pdf","accessed":"2026-09-26","note":"Age rebates apply if the employee is 65 / 75 on the last day of the year of assessment."},{"covers":["medicalCredits"],"title":"SARS: Medical tax credit rates","url":"https://www.sars.gov.za/tax-rates/medical-tax-credit-rates/","accessed":"2026-09-26","note":"R376 main member, R376 first dependant, R254 each additional dependant (last updated 25/02/2026)."},{"covers":["uif"],"title":"SARS: Unemployment Insurance Fund","url":"https://www.sars.gov.za/types-of-tax/unemployment-insurance-fund/","accessed":"2026-09-26","note":"1% + 1%, ceiling R17 712 a month since 1 June 2021; no change for 2026/27 (last updated 19/08/2026)."},{"covers":["uif","treatment.uif"],"title":"SARS UIF-GEN-01-G01: Guide for employers in respect of the UIF (Revision 9)","url":"https://www.sars.gov.za/wp-content/uploads/Ops/Guides/UIF-GEN-01-G01-Guide-for-Employers-in-respect-of-the-Unemployment-Insurance-Fund-External-Guide.pdf","accessed":"2026-09-26","note":"UIF remuneration excludes commission; staff working under 24 hours a month are exempt."},{"covers":["sdl"],"title":"SARS: Skills Development Levy","url":"https://www.sars.gov.za/types-of-tax/skills-development-levy/","accessed":"2026-09-26","note":"1%; employers expecting leviable remuneration of R500 000 or less over the next 12 months are exempt."},{"covers":["eti"],"title":"SARS: Employment Tax Incentive","url":"https://www.sars.gov.za/types-of-tax/pay-as-you-earn/employment-tax-incentive-eti/","accessed":"2026-09-26","note":"Bands from 1 April 2025: under R2 500 at 60% / 30%, R2 500–R5 499.99 at R1 500 / R750, tapering to nil at R7 500. Scheme runs to 28 February 2029."},{"covers":["eti"],"title":"SARS PAYE-GEN-01-G05: Guide for employers in respect of the ETI (Revision 17)","url":"https://www.sars.gov.za/wp-content/uploads/Ops/Guides/PAYE-GEN-01-G05-Guide-for-Employers-in-respect-of-Employment-Tax-Incentive-External-Guide.pdf","accessed":"2026-09-26","note":"24 qualifying months per employee (counted only when claimed); under 160 hours: gross up, then pro-rate by hours ÷ 160; age 18–29."},{"covers":["eti.minimumWageHourlyMinor"],"title":"Department of Employment and Labour: national minimum wage R30.23 per hour","url":"https://www.labour.gov.za/minister-of-employment-and-labour-meth-increases-the-statutory-national-minimum-wage-to-r30-23-per-hour","accessed":"2026-09-26","note":"Binding from 1 March 2026 (statement dated 3 February 2026)."},{"covers":["retirement.annualCapMinor","eti.wholeClaimLostBelowMinimumWage"],"title":"SARS: Budget 2026 frequently asked questions","url":"https://www.sars.gov.za/about/sars-tax-and-customs-system/budget/budget-2026-frequently-asked-questions/","accessed":"2026-09-26","note":"Retirement deduction cap R430 000 from 1 March 2026; one employee paid below the minimum wage disqualifies the month''s ETI claim."},{"covers":["retirement"],"title":"National Treasury: Budget Review 2026 (Table 4.6)","url":"https://www.treasury.gov.za/documents/National%20Budget/2026/review/FullBR.pdf","accessed":"2026-09-26","note":"Retirement cap raised from R350 000 (set in 2016) to R430 000, effective 1 March 2026."},{"covers":["travel"],"title":"SARS: Rates per kilometer","url":"https://www.sars.gov.za/tax-rates/employers/rates-per-kilometer/","accessed":"2026-09-26","note":"Prescribed rate R4.95 per km from 1 March 2026 (last updated 26/02/2026)."},{"covers":["travel"],"title":"SARS PAYE-GEN-01-G03: Guide for employers in respect of allowances (2027 tax year)","url":"https://www.sars.gov.za/wp-content/uploads/Ops/Guides/PAYE-GEN-01-G03-Guide-for-Employers-in-respect-of-Allowances-External-Guide.pdf","accessed":"2026-09-26","note":"80% of a travel allowance is included for PAYE, or 20% if at least 80% of use is for business; the full allowance goes under 3701."},{"covers":["statutory.sourceCodes"],"title":"SARS PAYE-AE-06-G06: Guide for codes applicable to employees tax certificates 2027 (Revision 14)","url":"https://www.sars.gov.za/wp-content/uploads/Ops/Guides/PAYE-AE-06-G06-Guide-for-Codes-Applicable-to-Employees-Tax-Certificates-2027-External-Guide.pdf","accessed":"2026-09-26","note":"Codes 3601–3828, 4001–4006, 4102, 4115, 4116, 4118, 4141, 4142, 4149, 4150, 4472–4474, 4497. 3615, 3697, 3698, 4101 and 4103 are discontinued."},{"covers":["statutory.emp201"],"title":"SARS: Completing the monthly employer declaration (EMP201)","url":"https://www.sars.gov.za/types-of-tax/pay-as-you-earn/completing-the-monthly-employer-declaration-emp201/","accessed":"2026-09-26","note":"PAYE payable is PAYE less ETI utilised; due by the 7th (or the last business day before)."},{"covers":["leave"],"title":"Basic Conditions of Employment Act 75 of 1997 (sections 20, 22 and 27)","url":"https://www.labour.gov.za/DocumentCenter/Acts/Basic%20Conditions%20of%20Employment/Act%20-%20Basic%20Conditions%20of%20Employment.pdf","accessed":"2026-09-26","note":"21 consecutive days annual leave; 6 weeks'' working days sick leave per 36 months (1 per 26 days in the first 6 months); 3 days family responsibility after 4 months for 4+ days a week."}]'::jsonb,
  '[{"path":"treatment.uifFringeBenefits","note":"UIF is charged on taxable fringe benefits (employer medical and retirement contributions). SARS lists what UIF excludes and these are not on the list, but no SARS page says so directly."},{"path":"treatment.uifSdlTravelAllowance","note":"UIF and SDL are charged on the taxable part (80% or 20%) of a travel allowance. Inferred from the Fourth Schedule; not stated by SARS."},{"path":"statutory.it3aReasonCode","note":"IT3(a) certificates default to reason code 02. SARS accepts codes 02 to 10; check the right one per employee in the certificate guide."},{"path":"leave.annualWorkingDays","note":"Annual leave is shown as days per week × 3 working days (15 for a 5-day week). The Act says 21 consecutive days; the working-day figure is derived."}]'::jsonb,
  '["Retirement cap: SARS and Treasury apply R430 000 from 1 March 2026; one industry report says the Rates Act gazetted on 1 April 2026 left it out. Follow SARS unless told otherwise.","ETI and the minimum wage: the SARS ETI guide disqualifies only the employee paid below the minimum wage; the Budget 2026 FAQ says the whole month''s claim is lost. The stricter FAQ rule is used.","The SARS tables guide heading says 2025/2026 but its dates and rates are for 2026/27 (1 March 2026 to 28 February 2027).","SARS''s own bonus example in the 2027 employer guide does not reconcile with the 2027 table; the method (tax with minus tax without) is used."]'::jsonb,
  'ba1da081e5d80bd4ab1914c0853eea71b74fc441cc466c5204dea1d697f02cc2')
ON CONFLICT (id) DO NOTHING;
