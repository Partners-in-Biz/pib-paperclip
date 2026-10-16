-- Personal accounts support: ensure org and personal accounts don't conflict.
-- Org accounts: unique on (company_id, platform, external_id) where scope='org'
-- Personal accounts: unique on (company_id, platform, external_id, owner_user_id) where scope='personal'

CREATE UNIQUE INDEX accounts_org_external ON plugin_social_e70c4e79f2.accounts (company_id, platform, external_id)
 WHERE scope = 'org';

CREATE UNIQUE INDEX accounts_personal_external ON plugin_social_e70c4e79f2.accounts (company_id, platform, external_id, owner_user_id)
 WHERE scope = 'personal';

-- Rollback: DROP INDEX plugin_social_e70c4e79f2.accounts_org_external; DROP INDEX plugin_social_e70c4e79f2.accounts_personal_external;
