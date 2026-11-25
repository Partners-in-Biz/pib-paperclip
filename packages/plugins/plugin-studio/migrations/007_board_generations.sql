-- Board generation (PAR-14281, plan PAR-14257 stage 3c): who a board generation counts against, where it came from,
-- and the card inputs copied at the click. Additive columns only; older builds ignore them.
ALTER TABLE plugin_studio_e414325bb6.generations ADD COLUMN origin text;

ALTER TABLE plugin_studio_e414325bb6.generations ADD COLUMN acting_user_id text;

ALTER TABLE plugin_studio_e414325bb6.generations ADD COLUMN input_keys jsonb NOT NULL DEFAULT '[]';

CREATE INDEX generations_board_daily ON plugin_studio_e414325bb6.generations (company_id, acting_user_id, created_at) WHERE origin = 'board';
