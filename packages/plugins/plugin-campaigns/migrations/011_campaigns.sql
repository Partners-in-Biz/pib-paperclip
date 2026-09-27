-- Campaigns 0.4.0: one suppression list fed by Campaigns, the CRM and the Mailbox, and launch on approval.

-- Suppressions: any reason the kit sends, the scope (marketing or all mail) and who reported it.
ALTER TABLE plugin_campaigns_d355219713.suppressions
  DROP CONSTRAINT suppressions_reason;

ALTER TABLE plugin_campaigns_d355219713.suppressions
  ADD CONSTRAINT suppressions_reason CHECK (reason IN ('unsubscribe', 'bounce', 'complaint', 'manual'));

ALTER TABLE plugin_campaigns_d355219713.suppressions
  ADD COLUMN scope text NOT NULL DEFAULT 'marketing',
  ADD COLUMN source text NOT NULL DEFAULT 'partnersinbiz.campaigns',
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE plugin_campaigns_d355219713.suppressions
  ADD CONSTRAINT suppressions_scope CHECK (scope IN ('marketing', 'all'));

CREATE INDEX suppressions_source_created ON plugin_campaigns_d355219713.suppressions (source, created_at);

-- Campaigns: the person who approved the launch, when it launched, and why a launch on approval failed.
ALTER TABLE plugin_campaigns_d355219713.campaigns
  ADD COLUMN approved_by_user_id text,
  ADD COLUMN launched_at timestamptz,
  ADD COLUMN launch_error text;

CREATE INDEX campaigns_approval_issue ON plugin_campaigns_d355219713.campaigns (approval_issue_id) WHERE approval_issue_id IS NOT NULL;
