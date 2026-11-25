// Pure helpers shared by the worker and the UI bundle: no db or server imports (esbuild would pull them into the UI).
import { formatClientParam } from "@partnersinbiz/pib-plugin-kit/client-ref";

export interface ClientSummaryRow {
  kind: "company" | "contact";
  id: string;
  name: string;
  running: number;
  waiting: number;
}

/** `/campaigns?client=<kind>:<id>` */
export function clientWorkspacePath(row: Pick<ClientSummaryRow, "kind" | "id">): string {
  return `/campaigns?client=${formatClientParam(row)}`;
}

export interface ClientSummaryModel {
  text: string;
  items: Array<{ name: string; href: string; text: string }>;
  inline: boolean;
}

/** What the own page's client line shows: null (hidden) with no clients, one inline link for one client, a list for several. */
export function clientSummaryModel(rows: ClientSummaryRow[]): ClientSummaryModel | null {
  if (rows.length === 0) return null;
  const counts = (r: number, w: number) => `${r} running, ${w} waiting for approval`;
  const running = rows.reduce((sum, row) => sum + row.running, 0);
  const waiting = rows.reduce((sum, row) => sum + row.waiting, 0);
  return {
    text: `Client campaigns: ${counts(running, waiting)}`,
    inline: rows.length === 1,
    items: rows.map((row) => ({ name: row.name, href: clientWorkspacePath(row), text: counts(row.running, row.waiting) })),
  };
}
