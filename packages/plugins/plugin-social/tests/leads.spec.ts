import { describe, expect, it, vi } from "vitest";
import type { InboxItemRow } from "../src/db.js";
import { enqueueRecentLeads, LEAD_RESULT_EVENT, onLeadResult, parseLeadResult, sendLead } from "../src/handoff.js";
import { NAMESPACE } from "../src/namespace.js";
import plugin from "../src/worker.js";
import { fakeCtx } from "./helpers.js";

const T = (name: string) => `${NAMESPACE}.${name}`;

const item = {
  id: "i1", platform: "instagram", author: "sam", body: "How much for a logo?", permalink: "https://instagram.com/p/1",
  client_kind: "company", client_ref: "c1", received_at: "2026-09-26T08:00:00Z", created_at: "2026-09-26T08:00:00Z",
} as unknown as InboxItemRow;

describe("Social → CRM leads through the kit outbox", () => {
  it("stores the lead and sends it once; sending the same key again is a no-op", async () => {
    const emit = vi.fn(async () => undefined);
    const keys = new Set<string>();
    const ctx = fakeCtx({ events: { emit, on: vi.fn() } }, {
      executeResult: (sql, params) => {
        if (!sql.startsWith(`INSERT INTO ${T("outbox")}`)) return 1;
        if (keys.has(String(params[0]))) return 0;
        keys.add(String(params[0]));
        return 1;
      },
    });
    expect(await sendLead(ctx, "co", item, 0.9)).toBe(true);
    expect(await sendLead(ctx, "co", item, 0.9)).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("lead.captured", "co", expect.objectContaining({ key: "social:inbox:i1", clientKind: "company", clientRef: "c1", confidence: 0.9 }));
    const insert = ctx.fakeDb.executes.find((e) => e.sql.startsWith(`INSERT INTO ${T("outbox")}`))!;
    expect(insert.params.slice(0, 3)).toEqual(["social:inbox:i1", "co", "lead.captured"]);
    // The client scope travels with the lead: the CRM keeps a client's lead as the client's own.
    expect(JSON.parse(String(insert.params[3]))).toMatchObject({ clientKind: "company", clientRef: "c1" });
  });

  it("never throws when the store fails (the hourly check queues it again)", async () => {
    const ctx = fakeCtx({ events: { emit: vi.fn(), on: vi.fn() } }, { executeResult: () => { throw new Error("db down"); } });
    expect(await sendLead(ctx, "co", item, null)).toBe(false);
  });

  it("the CRM's answer settles the row: stored, held or ignored all stop the re-sends", async () => {
    expect(LEAD_RESULT_EVENT).toBe("plugin.partnersinbiz.crm.lead.captured.result");
    expect(parseLeadResult({ key: "mail:1", status: "stored" })).toBeNull();
    expect(parseLeadResult({ key: "social:inbox:i1", status: "maybe" })).toBeNull();
    expect(parseLeadResult({ key: "social:inbox:i1", status: "held", reason: "CRM settings not saved" })).toEqual({ key: "social:inbox:i1", status: "held", contactId: null, reason: "CRM settings not saved" });

    const ctx = fakeCtx({}, {
      queryResult: (sql) => (sql.includes(`FROM ${T("outbox")} WHERE key = $1`) ? [{ key: "social:inbox:i1", company_id: "co", event: "lead.captured", payload: {}, status: "pending", attempts: 1, last_error: null, result: null }] : []),
    });
    expect(await onLeadResult(ctx, { companyId: "co", payload: { key: "social:inbox:i1", status: "stored", contactId: "ct-9" } } as never)).toBe(true);
    const update = ctx.fakeDb.executes.find((e) => e.sql.startsWith(`UPDATE ${T("outbox")} SET status = $2`))!;
    expect(update.params.slice(0, 2)).toEqual(["social:inbox:i1", "done"]);
    expect(await onLeadResult(ctx, { companyId: "co", payload: { key: "other:1", status: "stored" } } as never)).toBe(false);
  });

  it("the hourly safety net only queues recent leads that never reached the outbox", async () => {
    const emit = vi.fn(async () => undefined);
    const ctx = fakeCtx({ events: { emit, on: vi.fn() } }, {
      queryResult: (sql) => (sql.includes("triaged_at >= now() - interval '24 hours'") ? [{ ...item, confidence: "0.8" }] : []),
    });
    expect(await enqueueRecentLeads(ctx, "co")).toBe(1);
    const query = ctx.fakeDb.queries.find((q) => q.sql.includes("triaged_at >= now()"))!.sql;
    expect(query).toContain(`NOT EXISTS (SELECT 1 FROM ${T("outbox")} o`);
    expect(query).toContain("NOT IN ('escalated', 'spam_read')");
    expect(emit).toHaveBeenCalledWith("lead.captured", "co", expect.objectContaining({ key: "social:inbox:i1", confidence: 0.8 }));
  });

  it("the worker listens for the CRM's answers and runs the redeliver job", async () => {
    const listeners = new Set<string>();
    const jobs = new Set<string>();
    const ctx = fakeCtx({
      tools: { register: () => undefined },
      actions: { register: () => undefined },
      jobs: { register: (key: string) => void jobs.add(key) },
      events: { on: (name: string) => void listeners.add(name), emit: async () => undefined },
    });
    await plugin.definition.setup(ctx);
    expect(listeners.has(LEAD_RESULT_EVENT)).toBe(true);
    expect(jobs.has("redeliver")).toBe(true);
  });
});
