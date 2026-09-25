CREATE TABLE plugin_crm_832258244c.deal_products (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  deal_id text NOT NULL REFERENCES plugin_crm_832258244c.deals (id),
  product_id text NOT NULL REFERENCES plugin_crm_832258244c.products (id),
  quantity integer NOT NULL DEFAULT 1,
  unit_amount_minor bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX deal_products_pair ON plugin_crm_832258244c.deal_products (deal_id, product_id);
