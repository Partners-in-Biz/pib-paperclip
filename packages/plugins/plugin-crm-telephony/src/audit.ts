import type { PluginContext } from "@paperclipai/plugin-sdk";
import { NAMESPACE } from "./namespace.js";

export interface AuditEntry {
  companyId: string;
  userId: string;
  action: string;
  contactId?: string;
  detail?: Record<string, unknown>;
}

export async function writeAudit(db: PluginContext["db"], entry: AuditEntry): Promise<void> {
  const sql = `
    INSERT INTO ${NAMESPACE}.tel_audit (company_id, user_id, action, contact_id, detail)
    VALUES ($1, $2, $3, $4, $5)
  `;

  const detail = entry.detail || {};

  await db.execute(sql, [
    entry.companyId,
    entry.userId,
    entry.action,
    entry.contactId || null,
    detail,
  ]);
}
