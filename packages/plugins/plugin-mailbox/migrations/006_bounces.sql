-- Delivery failure notices (bounces): the failed recipients and the Message-IDs of the bounced mail.
ALTER TABLE plugin_mailbox_319145c88b.messages
  ADD COLUMN bounce jsonb;
