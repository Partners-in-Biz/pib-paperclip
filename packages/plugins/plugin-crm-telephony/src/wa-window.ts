import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";

/**
 * Check if communication window is open for a contact (24h since last inbound message).
 * Returns true if there's been an inbound message from this contact in the last 24 hours.
 */
export async function isWindowOpen(
  dbClient: PluginDatabaseClient,
  namespace: string,
  companyId: string,
  contactE164: string,
  now: Date = new Date(),
): Promise<boolean> {
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const result = await dbClient.query<{ found: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM ${namespace}.tel_messages
       WHERE company_id = $1
         AND from_e164 = $2
         AND direction = 'inbound'
         AND channel = 'whatsapp'
         AND received_at IS NOT NULL
         AND received_at > $3
     ) as found`,
    [companyId, contactE164, twentyFourHoursAgo.toISOString()],
  );

  return result[0]?.found ?? false;
}
