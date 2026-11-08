import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { driveCatchup, type CatchupDeps } from "../src/drive-catchup.js";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
const R2 = { accountId: "a", bucket: "b", accessKeyId: "k", secretAccessKey: "s", publicBaseUrl: "", prefix: "billing" };

const invoices = [
  { id: "i1", number: "INV-0042", status: "sent", customer_kind: "company", customer_ref: "c1", sent_at: "2026-10-21T09:00:00Z", pdf_key: "billing/co1/invoice/2026-10/u1-inv.pdf", mail_seq: 2 },
  { id: "i2", number: "INV-0043", status: "paid", customer_kind: "company", customer_ref: "c2", sent_at: "2026-10-22T09:00:00Z", pdf_key: null, mail_seq: 1 },
  { id: "i3", number: "INV-0044", status: "sent", customer_kind: null, customer_ref: null, sent_at: "2026-10-23T09:00:00Z", pdf_key: "billing/co1/invoice/2026-10/u3.pdf", mail_seq: 1 },
];
const quotes = [{ id: "q1", number: "Q-007", status: "accepted", customer_kind: "contact", customer_ref: "p1", sent_at: "2026-11-02T10:00:00Z", pdf_key: "billing/co1/quote/2026-11/u4.pdf", mail_seq: 1 }];

function setup() {
  const execute = vi.fn();
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    expect(params[0]).toBe("co1");
    expect(sql).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/i);
    return sql.includes(".invoices") ? invoices : quotes;
  });
  const ctx = { db: { namespace: "plugin_billing_test", query, execute }, logger: { warn: vi.fn(), info: vi.fn() } } as unknown as PluginContext;
  const store = new Set<string>();
  const save = vi.fn(async (_ctx: unknown, opts: { name: string; subfolder?: string; client?: { ref: string } }) => {
    store.add(`${opts.client?.ref}/${opts.subfolder}/${opts.name}`);
    return { status: "saved" as const, requestId: "r", driveFileId: `f-${opts.name}`, url: "https://drive.example/f" };
  });
  const deps: CatchupDeps = { r2: vi.fn(async () => R2), readPdf: vi.fn(async () => PDF), save: save as unknown as CatchupDeps["save"], sleep: vi.fn(async () => undefined), now: () => 0 };
  return { ctx, execute, save, deps, store };
}

describe("billing.drive-catchup", () => {
  it("dry run lists every document and saves nothing", async () => {
    const { ctx, execute, save, deps } = setup();
    const out = await driveCatchup(ctx, "co1", { from: "2026-10-20", to: "2026-11-07" }, deps);
    expect(out.dryRun).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(deps.readPdf).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(out.items.map((i) => [i.number, i.result, i.reason])).toEqual([
      ["INV-0042", "would_save", undefined],
      ["INV-0043", "skipped", "no_stored_pdf"],
      ["INV-0044", "skipped", "no_client"],
      ["Q-007", "would_save", undefined],
    ]);
    expect(out.counts).toEqual({ would_save: 2, "skipped:no_stored_pdf": 1, "skipped:no_client": 1 });
  });

  it("names the copy by the send date and last send seq, saves to the client's 03 Deliverables, paced", async () => {
    const { ctx, execute, save, deps } = setup();
    const out = await driveCatchup(ctx, "co1", { from: "2026-10-20", to: "2026-11-07", dryRun: false }, deps);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0][1]).toMatchObject({
      companyId: "co1",
      kind: "client",
      name: "2026-10-21 Invoice INV-0042 v02.pdf",
      mimeType: "application/pdf",
      subfolder: "03 Deliverables",
      client: { kind: "company", ref: "c1" },
      bytes: PDF,
    });
    expect(save.mock.calls[1][1]).toMatchObject({ name: "2026-11-02 Quote Q-007 v01.pdf", client: { kind: "contact", ref: "p1" } });
    expect(deps.sleep).toHaveBeenCalledTimes(1);
    expect(deps.sleep).toHaveBeenCalledWith(2000);
    expect(execute).not.toHaveBeenCalled();
    expect(out.counts).toEqual({ saved: 2, "skipped:no_stored_pdf": 1, "skipped:no_client": 1 });
  });

  it("a second run sends the same name and bytes, so the CRM's folder+name+sha256 dedupe makes it a no-op", async () => {
    const { ctx, save, deps, store } = setup();
    await driveCatchup(ctx, "co1", { from: "2026-10-20", to: "2026-11-07", dryRun: false }, deps);
    const first = save.mock.calls.map((c) => c[1]);
    await driveCatchup(ctx, "co1", { from: "2026-10-20", to: "2026-11-07", dryRun: false }, deps);
    expect(save.mock.calls.slice(2).map((c) => c[1])).toEqual(first);
    expect(store.size).toBe(2);
  });

  it("refuses a stored file that is not a PDF and a key from another company", async () => {
    const { ctx, save, deps } = setup();
    deps.readPdf = vi.fn(async () => new Uint8Array([1, 2, 3, 4, 5]));
    invoices[0].pdf_key = "billing/other/invoice/2026-10/x.pdf";
    try {
      const out = await driveCatchup(ctx, "co1", { from: "2026-10-20", to: "2026-11-07", dryRun: false }, deps);
      expect(out.items[0]).toMatchObject({ number: "INV-0042", result: "skipped", reason: "foreign_pdf_key" });
      expect(out.items[3]).toMatchObject({ number: "Q-007", result: "failed", reason: "stored_file_not_pdf" });
      expect(save).not.toHaveBeenCalled();
    } finally {
      invoices[0].pdf_key = "billing/co1/invoice/2026-10/u1-inv.pdf";
    }
  });

  it("works in batches: limit saves per call, then nextAfterId carries on (PAR-8121)", async () => {
    const { ctx, save, deps } = setup();
    const first = await driveCatchup(ctx, "co1", { from: "2026-10-20", to: "2026-11-07", dryRun: false, limit: 1 }, deps);
    expect(first.items.map((i) => [i.number, i.result])).toEqual([["INV-0042", "saved"]]);
    expect(first).toMatchObject({ done: false, nextAfterId: "invoice:i1", remaining: 3 });
    const second = await driveCatchup(ctx, "co1", { from: "2026-10-20", to: "2026-11-07", dryRun: false, limit: 1, afterId: first.nextAfterId }, deps);
    expect(second.items.map((i) => [i.number, i.result, i.reason])).toEqual([
      ["INV-0043", "skipped", "no_stored_pdf"],
      ["INV-0044", "skipped", "no_client"],
      ["Q-007", "saved", undefined],
    ]);
    expect(second).toMatchObject({ done: true, nextAfterId: null, remaining: 0 });
    expect(save).toHaveBeenCalledTimes(2);
    await expect(driveCatchup(ctx, "co1", { from: "2026-10-20", to: "2026-11-07", dryRun: false, afterId: "invoice:nope" }, deps)).rejects.toThrow(/afterId/);
  });

  it("stops starting saves once the time budget is used", async () => {
    const { ctx, save, deps } = setup();
    let t = 0;
    deps.now = () => t;
    save.mockImplementationOnce(async () => {
      t += 16_000;
      return { status: "saved" as const, requestId: "r", driveFileId: "f", url: "u" };
    });
    const out = await driveCatchup(ctx, "co1", { from: "2026-10-20", to: "2026-11-07", dryRun: false, limit: 10 }, deps);
    expect(save).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ done: false, nextAfterId: "invoice:i1" });
  });

  it("refuses a second saving call while one runs; dry runs are not blocked", async () => {
    const { ctx, deps } = setup();
    let release!: () => void;
    deps.readPdf = vi.fn(() => new Promise<Uint8Array>((resolve) => { release = () => resolve(PDF); }));
    const first = driveCatchup(ctx, "co1", { from: "2026-10-20", to: "2026-11-07", dryRun: false, limit: 1 }, deps);
    await vi.waitFor(() => expect(deps.readPdf).toHaveBeenCalled());
    await expect(driveCatchup(ctx, "co1", { from: "2026-10-20", to: "2026-11-07", dryRun: false }, deps)).rejects.toThrow(/already running/);
    await expect(driveCatchup(ctx, "co1", { from: "2026-10-20", to: "2026-11-07" }, deps)).resolves.toMatchObject({ dryRun: true });
    release();
    await expect(first).resolves.toMatchObject({ done: false });
    deps.readPdf = vi.fn(async () => PDF);
    await expect(driveCatchup(ctx, "co1", { from: "2026-10-20", to: "2026-11-07", dryRun: false, afterId: "invoice:i1" }, deps)).resolves.toMatchObject({ done: true });
  });

  it("checks the range", async () => {
    const { ctx, deps } = setup();
    await expect(driveCatchup(ctx, "co1", { from: "20 Oct", to: "2026-11-07" }, deps)).rejects.toThrow(/from must be a date/);
    await expect(driveCatchup(ctx, "co1", { from: "2026-11-07", to: "2026-10-20" }, deps)).rejects.toThrow(/on or after/);
    await expect(driveCatchup(ctx, "co1", { from: "2026-01-01", to: "2026-11-07" }, deps)).rejects.toThrow(/limited/);
  });
});
