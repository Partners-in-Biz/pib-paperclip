import { describe, expect, it, vi } from "vitest";
import { ownClientCounts } from "../src/client-summary.js";
import { clientWorkspacePath, clientSummaryModel } from "../src/client-link.js";
import { campaignPageLink } from "../src/worker.js";

const ctx = (prefix: string | null) => ({ companies: { get: async () => (prefix ? { issuePrefix: prefix } : null) } }) as never;
const base = { id: "c1", clientKind: null, clientRef: null } as never;

describe("client summary (PAR-9231)", () => {
  it("links into the client workspace", () => {
    expect(clientWorkspacePath({ kind: "company", id: "co-1" })).toBe("/campaigns?client=company:co-1");
  });

  it("maps rows to counts and falls back to the ref when the name is missing", async () => {
    const query = vi.fn().mockResolvedValue([
      { client_kind: "company", client_ref: "co-1", client_name: "Acme", running: "2", waiting: "1" },
      { client_kind: null, client_ref: "co-2", client_name: null, running: "0", waiting: "3" },
    ]);
    const rows = await ownClientCounts({ db: { query, namespace: "plugin_campaigns" } } as never, "company-1");
    expect(rows).toEqual([
      { kind: "company", id: "co-1", name: "Acme", running: 2, waiting: 1 },
      { kind: "company", id: "co-2", name: "co-2", running: 0, waiting: 3 },
    ]);
    expect(query.mock.calls[0]![1]).toEqual(["company-1"]);
  });

  it("counts a done issue as waiting (a client launch is manual) and excludes only cancelled", async () => {
    const query = vi.fn().mockResolvedValue([]);
    await ownClientCounts({ db: { query, namespace: "plugin_campaigns" } } as never, "company-1");
    const sql = String(query.mock.calls[0]![0]);
    expect(sql).toContain("i.status <> 'cancelled'");
    expect(sql).not.toContain("'done'");
  });

  it("the approval link carries client= for a client campaign and not for an own one", async () => {
    const client = { ...(base as object), clientKind: "company", clientRef: "co-1" } as never;
    expect(await campaignPageLink(ctx("PIB"), "x", client)).toBe("/PIB/campaigns?campaign=c1&client=company%3Aco-1");
    expect(await campaignPageLink(ctx("PIB"), "x", base)).toBe("/PIB/campaigns?campaign=c1");
  });

  it("summary model: hidden with none, inline for one, list for several", () => {
    const a = { kind: "company" as const, id: "a", name: "A", running: 1, waiting: 2 };
    const b = { kind: "contact" as const, id: "b", name: "B", running: 3, waiting: 0 };
    expect(clientSummaryModel([])).toBeNull();
    expect(clientSummaryModel([a])).toMatchObject({ inline: true, text: "Client campaigns: 1 running, 2 waiting for approval" });
    const many = clientSummaryModel([a, b])!;
    expect(many.inline).toBe(false);
    expect(many.text).toBe("Client campaigns: 4 running, 2 waiting for approval");
    expect(many.items.map((i) => i.href)).toEqual(["/campaigns?client=company:a", "/campaigns?client=contact:b"]);
  });
});
