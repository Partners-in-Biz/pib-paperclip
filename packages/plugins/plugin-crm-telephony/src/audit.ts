import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";

export interface AuditEntry {
  companyId: string;
  userId: string;
  action: string;
  contactId?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * Write an audit log entry to tel_audit table.
 * Detail should not include sensitive message bodies.
 */
export async function writeAudit(
  dbClient: PluginDatabaseClient,
  namespace: string,
  entry: AuditEntry,
): Promise<void> {
  const detail = entry.detail || {};
  const detailJson = JSON.stringify(detail);

  await dbClient.execute(
    `INSERT INTO ${namespace}.tel_audit (company_id, user_id, action, contact_id, detail)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [entry.companyId, entry.userId, entry.action, entry.contactId || null, detailJson],
  );
}
