/** PAR-6992: an invoice draft has no number; the first send claims it from the org sequence, a second send never claims again. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getInvoice } from "../src/db.js";
import { startInvoiceSend } from "../src/invoices.js";
import { ensureInvoiceNumber } from "../src/numbering.js";
import { NAMESPACE } from "../src/namespace.js";
import plugin from "../src/worker.js";
import { COMPANY, embeddedAvailable, seedClient, SETTINGS, R2_SETTINGS, startHarness, type Harness } from "./helpers/harness.js";

const available = await embeddedAvailable();
const AGENT = { agentId: "agent-am", runId: "run-am", companyId: COMPANY, projectId: "p" };

describe.skipIf(!available)("invoice number claimed at send approval (postgres)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
    await plugin.definition.setup(h.ctx);
  }, 60_000);
  afterAll(async () => {
    await h?.stop();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
  beforeEach(async () => {
    await h.reset();
    h.config.set(COMPANY, { ...SETTINGS, r2: R2_SETTINGS });
    vi.stubGlobal("fetch", async () => new Response()); // R2 accepts the PDF
    await seedClient(h, { id: "ct-lumen", name: "Lumen Digital", email: "ap@lumen.test" });
  });

  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[];
  const counters = () => rows(`SELECT kind, prefix, n FROM ${NAMESPACE}.numbering_counters ORDER BY kind, prefix`);
  const draft = async () => {
    const inv = await h.call<{ id: string }>("billing.create-invoice", { currency: "ZAR", customerKind: "contact", customerRef: "ct-lumen" });
    await h.call("billing.add-line", { invoiceId: inv.id, description: "Retainer", quantity: 1, unitAmountMinor: 100_000 });
    return inv.id;
  };

  it("a new draft has no number and claims nothing", async () => {
    const id = await draft();
    expect((await getInvoice(h.ctx, id))!.number).toBeNull();
    expect(await counters()).toEqual([]);
  });

  it("the first send assigns the next sequence number; a second send keeps it and claims nothing", async () => {
    const id = await draft();
    await startInvoiceSend(h.ctx, id, "user:u1");
    const first = (await getInvoice(h.ctx, id))!.number;
    expect(first).toMatch(/^LUM-0*1$/);
    const after = await counters();
    expect(after.length).toBeGreaterThan(0);
    await startInvoiceSend(h.ctx, id, "user:u1");
    expect((await getInvoice(h.ctx, id))!.number).toBe(first);
    expect(await counters()).toEqual(after);
    // the next invoice gets the next number
    const id2 = await draft();
    await startInvoiceSend(h.ctx, id2, "user:u1");
    expect((await getInvoice(h.ctx, id2))!.number).toMatch(/^LUM-0*2$/);
  });

  it("the mail subject uses the claimed number", async () => {
    const id = await draft();
    await startInvoiceSend(h.ctx, id, "user:u1");
    const number = (await getInvoice(h.ctx, id))!.number;
    const mail = await rows<{ payload: { subject: string } }>(`SELECT payload FROM ${NAMESPACE}.outbox WHERE event = 'mail.send.requested'`);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.payload.subject).toContain(number!);
  });

  it("a draft that already holds a number keeps it and claims nothing", async () => {
    const id = await draft();
    await h.client.query(`UPDATE ${NAMESPACE}.invoices SET number = 'OLD-001' WHERE id = $1`, [id]);
    const settings = { ...SETTINGS } as never;
    expect(await ensureInvoiceNumber(h.ctx, (await getInvoice(h.ctx, id))!, settings)).toBe("OLD-001");
    await startInvoiceSend(h.ctx, id, "user:u1");
    expect((await getInvoice(h.ctx, id))!.number).toBe("OLD-001");
    expect(await counters()).toEqual([]);
  });

  it("deleting an unnumbered draft removes the row and its lines and leaves the counters alone", async () => {
    const id = await draft();
    const before = await counters();
    await h.call("billing.delete-draft-invoice", { invoiceId: id });
    expect(await rows(`SELECT id FROM ${NAMESPACE}.invoices WHERE id = $1`, [id])).toHaveLength(0);
    expect(await rows(`SELECT 1 FROM ${NAMESPACE}.invoice_lines WHERE invoice_id = $1`, [id])).toHaveLength(0);
    expect(await counters()).toEqual(before);
  });
});
