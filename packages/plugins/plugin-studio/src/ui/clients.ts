/** The Studio page's client-card logic, kept out of React so it can be tested. */

export interface ClientSummary {
  scopeKey: string;
  name: string;
  counts: { draft: number; approved: number; rejected: number };
  used: number;
  monthlyCap: number | null;
  capSource: "client" | "company" | "default" | "none";
  recentApproved: Array<{ id: string; name: string; kind: string }>;
}

/** Only clients with at least one asset (draft, approved or rejected) get a card. */
export function clientsWithAssets(clients: ReadonlyArray<ClientSummary>): ClientSummary[] {
  return clients.filter((c) => (c.counts?.draft ?? 0) + (c.counts?.approved ?? 0) + (c.counts?.rejected ?? 0) > 0);
}
