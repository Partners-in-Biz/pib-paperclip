/**
 * "Managed by" on a CRM company (access stage B, PAR-12581, plan B-D1 and B-D8).
 *
 * A company is managed by its owner (`owner_user_id`) and up to three more people
 * (`manager_user_ids`, migration 025). A limited person's own companies are the ones
 * he manages: the access guard asks `managedAccountIds` for them. Only an owner or an
 * admin of the workspace may change who manages a company, with any switch setting:
 * the check is here, not only in the access table.
 *
 * One statement per call, every query scoped by company.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { CrmCompanyManagers } from "@partnersinbiz/pib-plugin-kit";
import { insertActivity, table } from "./db.js";
import { CrmError, LOCAL_BOARD_USER_ID, type Viewer } from "./domain.js";

export const MAX_EXTRA_MANAGERS = 3;

export interface ManagersView {
  ownerUserId: string | null;
  managerUserIds: string[];
  /** The caller may change them (owner or admin of the workspace). */
  canChange: boolean;
  /** The caller's own user id, so the page can say "You". */
  you: string | null;
}

const isAdminRole = (role: string | null) => role === "owner" || role === "admin";

/** The ids in a stored `manager_user_ids` value; anything unreadable is an empty list. */
export function managerIdsOf(value: unknown): string[] {
  const list = typeof value === "string" ? safeJson(value) : value;
  return Array.isArray(list) ? [...new Set(list.filter((id): id is string => typeof id === "string" && id !== ""))] : [];
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** What the CRM copy of other plugins gets (`company.upserted` `managers`). */
export function managersEvent(row: { owner_user_id?: string | null; manager_user_ids?: unknown }): CrmCompanyManagers {
  return { ownerUserId: row.owner_user_id ?? null, managerUserIds: managerIdsOf(row.manager_user_ids) };
}

/** The CRM companies of this workspace that one person owns or manages. */
export async function managedAccountIds(ctx: PluginContext, companyId: string, userId: string): Promise<string[]> {
  if (!userId) return [];
  const rows = await ctx.db.query<{ id: string }>(
    `SELECT id FROM ${table(ctx, "companies")}
      WHERE company_id = $1 AND (owner_user_id = $2 OR manager_user_ids @> jsonb_build_array($2::text))
      ORDER BY id`,
    [companyId, userId],
  );
  return rows.map((row) => row.id);
}

/** Who manages one company, for its page. Null when the company is not in this workspace. */
export async function managersView(ctx: PluginContext, viewer: Viewer, accountId: string): Promise<ManagersView | null> {
  const rows = await ctx.db.query<{ owner_user_id: string | null; manager_user_ids: unknown }>(
    `SELECT owner_user_id, manager_user_ids FROM ${table(ctx, "companies")} WHERE company_id = $1 AND id = $2`,
    [viewer.companyId, accountId],
  );
  const row = rows[0];
  if (!row) return null;
  const m = managersEvent(row);
  return { ...m, canChange: isAdminRole(viewer.role) && viewer.userId !== null, you: viewer.userId };
}

function personId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new CrmError(`${label} is required`);
  return value.trim();
}

/**
 * Changes the owner of a company and the people who manage it with him.
 * Owner or admin only (a person, not an agent). Every id must be an active human
 * member of the workspace. `managerUserIds` replaces the whole list.
 */
export async function setManagers(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>): Promise<ManagersView> {
  if (!viewer.userId || viewer.agentId || !isAdminRole(viewer.role)) {
    throw new CrmError("Only an owner or an admin can change who manages a company");
  }
  const accountId = personId(params.companyRecordId ?? params.accountId, "companyRecordId");
  const ownerUserId = personId(params.ownerUserId, "ownerUserId");
  if (params.managerUserIds !== undefined && !Array.isArray(params.managerUserIds)) throw new CrmError("managerUserIds must be a list");
  const extra = [...new Set(((params.managerUserIds as unknown[] | undefined) ?? []).map((id) => personId(id, "A manager")))].filter((id) => id !== ownerUserId);
  if (extra.length > MAX_EXTRA_MANAGERS) throw new CrmError(`A company can have at most ${MAX_EXTRA_MANAGERS} managers beside its owner`);

  const before = await managersView(ctx, viewer, accountId);
  if (!before) throw new CrmError("Company was not found");

  const active = new Set(
    (await ctx.access.members.list({ companyId: viewer.companyId }))
      .filter((m) => m.principalType === "user" && m.status === "active")
      .map((m) => m.principalId),
  );
  for (const id of [ownerUserId, ...extra]) {
    if (id === LOCAL_BOARD_USER_ID || !active.has(id)) throw new CrmError("Only an active member of this company can manage a company");
  }

  await ctx.db.execute(
    `UPDATE ${table(ctx, "companies")}
        SET owner_user_id = $3, manager_user_ids = $4::jsonb, updated_at = now()
      WHERE company_id = $1 AND id = $2`,
    [viewer.companyId, accountId, ownerUserId, JSON.stringify(extra)],
  );
  const after = { ownerUserId, managerUserIds: extra };
  const changes = { before: { ownerUserId: before.ownerUserId, managerUserIds: before.managerUserIds }, after, changedBy: viewer.userId };
  await insertActivity(ctx, {
    companyId: viewer.companyId,
    recordType: "company",
    recordId: accountId,
    kind: "managers",
    body: "Changed who manages this company",
    meta: changes,
  });
  try {
    await ctx.activity.log({
      companyId: viewer.companyId,
      message: "Changed who manages a CRM company",
      entityType: "crm_company",
      entityId: accountId,
      metadata: changes,
    });
  } catch (error) {
    // The CRM's own timeline entry above is the record; the host log is a second copy.
    ctx.logger.info("Could not write the managers audit entry", { error: error instanceof Error ? error.message : String(error) });
  }
  return { ...after, canChange: true, you: viewer.userId };
}
