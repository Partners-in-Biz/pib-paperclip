-- A client sprint belongs to a CRM company or a CRM contact (a sole trader).
-- Sprints without client_ref are Partners in Biz's own sites.
ALTER TABLE plugin_seo_8099f8879a.sprints ADD COLUMN client_kind text;

-- Every client sprint before this version referenced a CRM company.
UPDATE plugin_seo_8099f8879a.sprints SET client_kind = 'company' WHERE client_ref IS NOT NULL AND client_kind IS NULL;

ALTER TABLE plugin_seo_8099f8879a.sprints ADD CONSTRAINT sprints_client_kind_check CHECK (
  (client_ref IS NULL AND client_kind IS NULL) OR (client_ref IS NOT NULL AND client_kind IN ('company', 'contact'))
);

CREATE INDEX sprints_company_client_kind ON plugin_seo_8099f8879a.sprints (company_id, client_kind, client_ref);
