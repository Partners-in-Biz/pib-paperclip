/**
 * Overview numbers for the Partners page (pure, no Node imports, so the UI can
 * use them).
 */

export interface LinkLite { id: string; company_a_id: string; company_b_id: string; status: string; accepted_a?: boolean; accepted_b?: boolean; created_at?: unknown }
export interface GrantLite { id: string; record_type: string; record_id: string; status: string; source_company_id?: string; grantee_company_id: string; created_at?: unknown }

export interface PartnerSummary {
  activeLinks: number;
  pendingLinks: number;
  /** Pending links this company still has to accept. */
  linksToAccept: number;
  activeGrants: number;
  /** Our records proposed for sharing: a person here accepts them (only the owner company can). */
  grantsToAccept: number;
  /** Partners' records proposed to us, waiting for the owner company. */
  grantsIncoming: number;
  revokedGrants: number;
  /** Active grants per record type, most first. */
  byType: Array<{ type: string; count: number }>;
  /** Active grants per partner company (the other side), most first. */
  byPartner: Array<{ companyId: string; count: number }>;
}

/** "crm.company" / "company" → "company". */
export function recordKind(type: string): string {
  return type.includes(".") ? type.slice(type.lastIndexOf(".") + 1) : type;
}

function ranked(counts: Map<string, number>): Array<[string, number]> {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Whether this company has accepted a pending link already. */
export function acceptedByMe(link: LinkLite, companyId: string | null | undefined): boolean {
  if (!companyId) return false;
  if (link.company_a_id === companyId) return !!link.accepted_a;
  if (link.company_b_id === companyId) return !!link.accepted_b;
  return false;
}

/** The other company on a link. */
export function otherCompany(link: LinkLite, companyId: string | null | undefined): string {
  return link.company_a_id === companyId ? link.company_b_id : link.company_a_id;
}

/** What a link needs, in plain words: it is active, it waits for this company, or it waits for the partner. */
export function linkState(link: LinkLite, companyId: string | null | undefined): "active" | "waiting-for-you" | "waiting-for-partner" {
  if (link.status === "active") return "active";
  return acceptedByMe(link, companyId) ? "waiting-for-partner" : "waiting-for-you";
}

export function partnerSummary(links: LinkLite[], grants: GrantLite[], companyId: string | null | undefined): PartnerSummary {
  const active = grants.filter((g) => g.status === "active");
  const types = new Map<string, number>();
  const partners = new Map<string, number>();
  for (const grant of active) {
    const kind = recordKind(grant.record_type);
    types.set(kind, (types.get(kind) ?? 0) + 1);
    const other = grant.grantee_company_id === companyId ? grant.source_company_id ?? "" : grant.grantee_company_id;
    if (other) partners.set(other, (partners.get(other) ?? 0) + 1);
  }
  const pending = links.filter((l) => l.status !== "active");
  return {
    activeLinks: links.filter((l) => l.status === "active").length,
    pendingLinks: pending.length,
    linksToAccept: pending.filter((l) => !acceptedByMe(l, companyId)).length,
    activeGrants: active.length,
    grantsToAccept: grants.filter((g) => g.status === "proposed" && g.source_company_id === companyId).length,
    grantsIncoming: grants.filter((g) => g.status === "proposed" && g.grantee_company_id === companyId && g.source_company_id !== companyId).length,
    revokedGrants: grants.filter((g) => g.status === "revoked").length,
    byType: ranked(types).map(([type, count]) => ({ type, count })),
    byPartner: ranked(partners).map(([companyId, count]) => ({ companyId, count })),
  };
}
