CREATE UNIQUE INDEX accounts_org_external ON plugin_social_e70c4e79f2.accounts (company_id, platform, external_id)
 WHERE scope = 'org';

CREATE UNIQUE INDEX accounts_personal_external ON plugin_social_e70c4e79f2.accounts (company_id, platform, external_id, owner_user_id)
 WHERE scope = 'personal';
