import { describe, expect, it, vi } from "vitest";
import { ownClientCounts, clientWorkspacePath } from "../src/client-summary.js";
import { launchReviewBrief } from "../src/worker.js";
import { campaignScope } from "../src/domain.js";
import { withClientParam } from "@partnersinbiz/pib-plugin-kit";

describe("client summary (PAR-9231)", () => {
  it("links into the client workspace", () => {
    expect(clientWorkspacePath({ kind: "company", id: "co-1" })).toBe("/campaigns?client=company:co-1");
  });

  it("maps rows to counts and falls back to the ref when the name is missing", async () => {
    const query = vi.fn().mockResolvedValue([
      { client_kind: "company", client_ref: "co-1", client_name: "Acme", running: "2", waiting: "1" },
      { client_kind: null, client_ref: "co-2", client_name: null, running: "0", waiting: "3" },
    ]);
    const ctx = { db: { query, namespace: "plugin_campaigns" } } as never;
    const rows = await ownClientCounts(ctx, "company-1");
    expect(rows).toEqual([
      { kind: "company", id: "co-1", name: "Acme", running: 2, waiting: 1 },
      { kind: "company", id: "co-2", name: "co-2", running: 0, waiting: 3 },
    ]);
    expect(query.mock.calls[0]![1]).toEqual(["company-1"]);
  });

  it("the approval link carries client= for a client campaign", () => {
    const path = withClientParam("/campaigns?campaign=c1", campaignScope({ clientKind: "company", clientRef: "co-1" }));
    expect(path).toBe("/campaigns?campaign=c1&client=company%3Aco-1");
    expect(launchReviewBrief).toBeTypeOf("function");
  });
});
