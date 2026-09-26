/**
 * Guided setup and module switches: the setup-status route, the hourly push
 * to the Setup plugin, jobs skipping companies with Billing off, and no
 * journals while Accounting is off.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { SETUP_STATUS_ROUTE, type SetupStatus } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import { NAMESPACE } from "../src/namespace.js";
import plugin from "../src/worker.js";
import { COMPANY, embeddedAvailable, seedClient, SETTINGS, startHarness, type Harness } from "./helpers/harness.js";

const available = await embeddedAvailable();
const MODULES_UPDATED = "plugin.partnersinbiz.setup.modules.updated";
const UUID = "0f1e2d3c-4b5a-4968-8776-655443322110";

const FULL = {
  ...SETTINGS,
  sender: { ...SETTINGS.sender, address: "1 Main Road\nBallito" },
  r2: { accountId: "acc", bucket: "pib-billing-private", accessKeyId: "AKIA", secretAccessKey: { secretId: "r2" } },
};

describe("manifest", () => {
  it("declares the setup-status route and matches the package version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(manifest.version).toBe("0.3.1");
    expect(pkg.version).toBe(manifest.version);
    expect(manifest.apiRoutes).toContainEqual(SETUP_STATUS_ROUTE);
    expect(manifest.capabilities).toContain("api.routes.register");
  });
});

describe.skipIf(!available)("billing setup (postgres)", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
    await plugin.definition.setup(h.ctx);
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  beforeEach(async () => {
    await h.reset();
    for (const key of [...h.state.keys()]) if (key.includes(":pib-setup:")) h.state.delete(key);
  });

  const route = (companyId = COMPANY) =>
    plugin.definition.onApiRequest!({ routeKey: "setup-status", method: "GET", path: "/setup-status", params: {}, query: { companyId }, body: null, actor: { actorType: "user", actorId: "user-1" }, companyId, headers: {} } as PluginApiRequestInput);

  async function status(): Promise<SetupStatus> {
    const res = await route();
    expect(res.status).toBe(200);
    return res.body as SetupStatus;
  }

  const item = (s: SetupStatus, key: string) => s.items.find((i) => i.key === key)!;

  async function switchModules(modules: Record<string, boolean>, updatedAt = new Date().toISOString()) {
    await h.deliver(MODULES_UPDATED, COMPANY, { companyId: COMPANY, modules, updatedAt });
  }

  async function sentInvoice() {
    const invoice = await h.call<{ id: string }>("billing.create-invoice", { currency: "ZAR", customerKind: "contact", customerRef: "ct-lumen" });
    await h.call("billing.add-line", { invoiceId: invoice.id, description: "SEO sprint", quantity: 1, unitAmountMinor: 100_000 });
    await h.call("billing.mark-sent", { invoiceId: invoice.id });
    return invoice;
  }

  async function journalKeys(): Promise<string[]> {
    return ((await h.client.query(`SELECT key FROM ${NAMESPACE}.outbox WHERE event = 'ledger.post.requested' ORDER BY key`)).rows as Array<{ key: string }>).map((r) => r.key);
  }

  it("lists what is missing before anything is saved, linking to the plugin list", async () => {
    const s = await status();
    expect(s).toMatchObject({ plugin: "partnersinbiz.billing", module: "billing", title: "Billing", version: "0.3.1" });
    expect(s.items[0]).toMatchObject({ key: "settings", status: "missing", required: true, href: "/company/settings/instance/plugins" });
    expect(item(s, "sender")).toMatchObject({ status: "missing", required: true });
    expect(item(s, "eft")).toMatchObject({ status: "missing", required: true });
    expect(item(s, "r2")).toMatchObject({ status: "missing", required: true });
    expect(item(s, "r2").steps?.[0]).toContain("create a new bucket");
    expect(item(s, "mailbox")).toMatchObject({ status: "optional", required: false, href: "/mailbox" });
    expect(item(s, "reminders")).toMatchObject({ status: "optional", required: false });
    expect(item(s, "first_client")).toMatchObject({ status: "optional", href: "/crm" });
    expect(s.items.map((i) => i.key)).toEqual(["settings", "sender", "eft", "r2", "mailbox", "ledger", "reminders", "receipts", "jev", "first_client"]);
  });

  it("marks configured items done and links settings by installation uuid once the page reported it", async () => {
    h.config.set(COMPANY, { ...FULL, dunning: { enabled: true }, anthropic: { apiKey: { secretId: "a" } } });
    await seedClient(h, { id: "ct-lumen", name: "Lumen Digital", email: "ap@lumen.test" });
    await h.call("billing.load", { uiBase: `/_plugins/${UUID}/ui/` });
    const s = await status();
    expect(s.items[0]).toMatchObject({ key: "settings", status: "done", href: `/company/settings/instance/plugins/${UUID}` });
    for (const key of ["sender", "eft", "r2", "reminders", "receipts", "first_client"]) expect(item(s, key).status).toBe("done");
    expect(item(s, "sender").href).toBe(`/company/settings/instance/plugins/${UUID}`);
    expect(item(s, "jev").status).toBe("optional");
  });

  it("asks for a VAT number only when the business charges VAT", async () => {
    const sender = { name: "Small Co", address: "2 Side St" };
    h.config.set(COMPANY, { ...FULL, sender });
    expect(item(await status(), "sender")).toMatchObject({ status: "missing" });
    expect(item(await status(), "sender").detail).toContain("VAT number");
    h.config.set(COMPANY, { ...FULL, sender, defaultTaxCode: "za_out_of_scope" });
    expect(item(await status(), "sender").status).toBe("done");
  });

  it("pushes the status to the Setup plugin from the hourly job", async () => {
    h.config.set(COMPANY, { ...FULL });
    await seedClient(h, { id: "ct-lumen", name: "Lumen Digital", email: "ap@lumen.test" });
    await h.runJob("mark-overdue");
    const pushed = h.emitted.filter((e) => e.name === "setup.status");
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ companyId: COMPANY, payload: { plugin: "partnersinbiz.billing", module: "billing" } });
  });

  describe("module switches", () => {
    beforeEach(async () => {
      h.config.set(COMPANY, { ...FULL });
      await seedClient(h, { id: "ct-lumen", name: "Lumen Digital", email: "ap@lumen.test" });
    });

    it("stops marking invoices overdue and running schedules while Billing is off", async () => {
      const invoice = await sentInvoice();
      await h.client.query(`UPDATE ${NAMESPACE}.invoices SET due_at = now() - interval '2 days' WHERE id = $1`, [invoice.id]);
      await h.call("billing.create-recurring", { templateInvoiceId: invoice.id, frequency: "monthly", nextRunAt: "2026-08-01T00:00:00Z" });
      await switchModules({ billing: false });

      await h.runJob("mark-overdue");
      await h.runJob("run-recurring");
      const statusOf = async () => ((await h.client.query(`SELECT status FROM ${NAMESPACE}.invoices WHERE id = $1`, [invoice.id])).rows[0] as { status: string }).status;
      expect(await statusOf()).toBe("sent");
      expect((await h.client.query(`SELECT count(*)::int AS n FROM ${NAMESPACE}.invoices WHERE recurring_id IS NOT NULL`)).rows[0]).toEqual({ n: 0 });

      await switchModules({ billing: true });
      await h.runJob("mark-overdue");
      await h.runJob("run-recurring");
      expect(await statusOf()).toBe("overdue");
      expect((await h.client.query(`SELECT count(*)::int AS n FROM ${NAMESPACE}.invoices WHERE recurring_id IS NOT NULL`)).rows[0]).toEqual({ n: 1 });
    });

    it("ignores an older module update", async () => {
      await switchModules({ billing: false }, "2026-09-26T10:00:00Z");
      await switchModules({ billing: true }, "2026-09-25T10:00:00Z");
      const invoice = await sentInvoice();
      await h.client.query(`UPDATE ${NAMESPACE}.invoices SET due_at = now() - interval '2 days' WHERE id = $1`, [invoice.id]);
      await h.runJob("mark-overdue");
      expect(((await h.client.query(`SELECT status FROM ${NAMESPACE}.invoices WHERE id = $1`, [invoice.id])).rows[0] as { status: string }).status).toBe("sent");
    });

    it("sends no journals while Accounting is off, and says so in the status", async () => {
      await switchModules({ accounting: false });
      const off = await sentInvoice();
      expect(await journalKeys()).toEqual([]);
      expect(((await h.client.query(`SELECT ledger_status FROM ${NAMESPACE}.invoices WHERE id = $1`, [off.id])).rows[0] as { ledger_status: string | null }).ledger_status).toBeNull();
      expect(item(await status(), "ledger").detail).toContain("Accounting is switched off");

      await switchModules({ accounting: true });
      const on = await sentInvoice();
      expect(await journalKeys()).toEqual([`billing:invoice:${on.id}:issue`]);
    });

    it("keeps re-sending in-flight work while Billing is off", async () => {
      await sentInvoice();
      await h.client.query(`UPDATE ${NAMESPACE}.outbox SET next_attempt_at = now() - interval '1 minute'`);
      await switchModules({ billing: false });
      h.emitted.length = 0;
      await h.runJob("redeliver");
      expect(h.emitted.some((e) => e.name === "ledger.post.requested")).toBe(true);
    });
  });
});
