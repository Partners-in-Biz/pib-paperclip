/**
 * The "Managed by" card's logic (access stage B, PAR-12581), kept out of React so it can be tested.
 * The worker decides who may change it (`canChange`) and checks every id again; this only shapes the page.
 */
export const MAX_EXTRA_MANAGERS = 3;

export interface ManagersData {
  ownerUserId: string | null;
  managerUserIds: string[];
  canChange: boolean;
  you: string | null;
}

export interface MemberOption {
  userId: string;
  label: string;
}

export interface ManagersDraft {
  ownerUserId: string;
  managerUserIds: string[];
}

/** A person's name for the card: "You", the member's name, or a neutral word when names cannot be read. */
export function personLabel(userId: string, data: Pick<ManagersData, "you">, names: ReadonlyMap<string, string>): string {
  if (data.you && userId === data.you) return "You";
  return names.get(userId) ?? "A team member";
}

/** The line under the owner: who manages it beside him. */
export function managersLine(data: ManagersData, names: ReadonlyMap<string, string>): string {
  if (!data.ownerUserId && data.managerUserIds.length === 0) return "Nobody yet";
  const owner = data.ownerUserId ? `${personLabel(data.ownerUserId, data, names)} (owner)` : "No owner";
  const extra = data.managerUserIds.map((id) => personLabel(id, data, names));
  return [owner, ...extra].join(", ");
}

export function draftOf(data: ManagersData): ManagersDraft {
  return { ownerUserId: data.ownerUserId ?? "", managerUserIds: [...data.managerUserIds] };
}

/** Why the draft cannot be saved, or null. */
export function draftProblem(draft: ManagersDraft): string | null {
  if (!draft.ownerUserId) return "Pick an owner";
  const extra = draft.managerUserIds.filter((id) => id && id !== draft.ownerUserId);
  if (new Set(extra).size !== extra.length) return "A person is on the list twice";
  if (extra.length > MAX_EXTRA_MANAGERS) return `At most ${MAX_EXTRA_MANAGERS} managers beside the owner`;
  return null;
}

/** The params of `crm.set-managers`: blanks and the owner left out of the extra list. */
export function setManagersParams(companyRecordId: string, draft: ManagersDraft) {
  return {
    companyRecordId,
    ownerUserId: draft.ownerUserId,
    managerUserIds: [...new Set(draft.managerUserIds.filter((id) => id && id !== draft.ownerUserId))],
  };
}

/** Members from `GET /api/companies/:id/members` (active people only), or null when they cannot be read. */
export function parseMembers(body: unknown): MemberOption[] | null {
  const rows = (body as { members?: unknown } | null)?.members;
  if (!Array.isArray(rows)) return null;
  const out: MemberOption[] = [];
  for (const m of rows as Array<Record<string, unknown> | null>) {
    if (!m || m.principalType !== "user" || m.status !== "active" || typeof m.principalId !== "string") continue;
    const user = (m.user ?? null) as { name?: unknown; email?: unknown } | null;
    const name = typeof user?.name === "string" && user.name.trim() ? user.name.trim() : null;
    const email = typeof user?.email === "string" && user.email.trim() ? user.email.trim() : null;
    out.push({ userId: m.principalId, label: name ?? email ?? m.principalId });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}
