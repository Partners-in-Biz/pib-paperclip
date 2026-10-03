/**
 * Effort against revenue per client (Q1b-14) against a real Postgres: paid
 * invoices kept from Billing's event, projects tied to clients, the alert on
 * the Cockpit's own health, and the measure-report tool's client part.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HANDOFF_EVENTS, PIB_PLUGINS, pluginEvent, rememberClientProjects } from "@partnersinbiz/pib-plugin-kit";
import { extraChecks } from "../src/checks.js";
import { clientEffortReport, effortSettings, readPayments, recordPayment } from "../src/client-cost.js";
import { NAMESPACE } from "../src/namespace.js";
import { saveTeam } from "../src/roles.js";
import { COMPANY, OTHER_COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds, type Hybrid } from "./helpers/hybrid.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const A = COMPANY;
const OP = "aaaaaaaa-0000-4000-8000-0000000000a1";
const NOW = "2026-10-03T12:00:00.000Z";
const RUN = { agentId: OP, runId: "run-1", companyId: A, projectId: "" };
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();

d("effort against revenue (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  async function make(config: Record<string, unknown> = { healthIssue: true }) {
    seq = 0;
    const w = await worlds.make({ savedConfigs: { [A]: config }, prefixes: { [A]: "PAR" }, agents: [{ id: OP, companyId: A, name: "Olive", status: "active", role: "general" }] });
    await saveTeam(w.env, A, { operatorAgentId: OP }, "user-owner");
    return w;
  }

  /** A client in the CRM copy, a project, and notional spend on it in the last days. */
  async function clientWithWork(w: Hybrid, o: { id: string; name: string; lifecycle?: string; projectName?: string; usd: number; daysAgo?: number }) {
    const projectId = uuid();
    await w.client.query(`INSERT INTO ${NAMESPACE}.crm_companies (id, company_id, name, lifecycle, updated_at) VALUES ($1, $2, $3, $4, now())`, [o.id, A, o.name, o.lifecycle ?? "customer"]);
    await w.client.query(`INSERT INTO public.projects (id, company_id, name) VALUES ($1, $2, $3)`, [projectId, A, o.projectName ?? o.name]);
    const issueId = uuid();
    await w.client.query(`INSERT INTO public.issues (id, company_id, identifier, title, status, project_id) VALUES ($1, $2, $3, 'Work', 'done', $4)`, [issueId, A, `PAR-${seq}`, projectId]);
    await w.client.query(`UPDATE public.issues SET completed_at = $2 WHERE id = $1`, [issueId, daysAgo(o.daysAgo ?? 3)]);
    await w.client.query(
      `INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at, finished_at, context_snapshot, usage_json) VALUES ($1, $2, $3, 'succeeded', $4, $4, $5::jsonb, $6::jsonb)`,
      [uuid(), A, OP, daysAgo(o.daysAgo ?? 3), JSON.stringify({ issueId }), JSON.stringify({ costUsd: o.usd, inputTokens: 1000, outputTokens: 100 })],
    );
    return projectId;
  }

  const pay = (w: Hybrid, key: string, clientRef: string | null, totalMinor: number, currency = "ZAR", paidAt = daysAgo(5), company = A) =>
    w.fire(pluginEvent(PIB_PLUGINS.billing, HANDOFF_EVENTS.invoicePaid), { companyId: company, payload: { key, clientKind: clientRef ? "company" : undefined, clientRef: clientRef ?? undefined, number: `INV-${key}`, totalMinor, currency, paidAt } });
  const effort = (w: Hybrid) => extraChecks(w.env, A, { fresh: true }).then((r) => r.health.filter((c) => c.key.startsWith("client-effort:")));

  describe("what Billing says was paid", () => {
    it("keeps one row per paid invoice event, so a re-sent event adds nothing", async () => {
      const w = await make();
      await pay(w, "evt-1", "bs1", 250000);
      await pay(w, "evt-1", "bs1", 250000);
      await pay(w, "evt-2", "bs1", 100000, "usd");
      const rows = (await w.client.query(`SELECT key, client_ref, invoice_number, total_minor, currency FROM ${NAMESPACE}.client_revenue ORDER BY key`)).rows;
      expect(rows).toEqual([
        { key: "evt-1", client_ref: "company:bs1", invoice_number: "INV-evt-1", total_minor: "250000", currency: "ZAR" },
        { key: "evt-2", client_ref: "company:bs1", invoice_number: "INV-evt-2", total_minor: "100000", currency: "USD" },
      ]);
      // and the activity line is still recorded once per event
      expect((await w.client.query(`SELECT 1 FROM ${NAMESPACE}.activity WHERE kind = 'invoice_paid'`)).rows).toHaveLength(2);
    });

    it("skips an event with no amount, rounds a fractional one, and counts each company separately", async () => {
      const w = await make();
      await w.fire(pluginEvent(PIB_PLUGINS.billing, HANDOFF_EVENTS.invoicePaid), { companyId: A, payload: { key: "evt-9", number: "INV-9", currency: "ZAR" } });
      await pay(w, "evt-10", null, 1999.6);
      await pay(w, "evt-11", null, 5000, "ZAR", daysAgo(2), OTHER_COMPANY);
      expect(await readPayments(w.ctx, A, daysAgo(30))).toEqual([{ clientRef: null, totalMinor: 2000, currency: "ZAR" }]);
      expect(await readPayments(w.ctx, OTHER_COMPANY, daysAgo(30))).toHaveLength(1);
    });

    it("recordPayment says whether the row was new, and only the last 30 days are read back", async () => {
      const w = await make();
      expect(await recordPayment(w.ctx, A, { key: "k1", clientRef: "company:x", number: null, totalMinor: 100, currency: "zar", paidAt: daysAgo(40) })).toBe(true);
      expect(await recordPayment(w.ctx, A, { key: "k1", clientRef: "company:x", number: null, totalMinor: 100, currency: "ZAR", paidAt: daysAgo(40) })).toBe(false);
      await recordPayment(w.ctx, A, { key: "k2", clientRef: "company:x", number: null, totalMinor: 700, currency: "ZAR", paidAt: daysAgo(10) });
      expect((await readPayments(w.ctx, A, daysAgo(30))).map((p) => p.totalMinor)).toEqual([700]);
    });
  });

  describe("the report and the alert", () => {
    it("sets a customer's notional spend against what it paid in 30 days, and warns past half of it", async () => {
      const w = await make();
      await clientWithWork(w, { id: "bs1", name: "Brightside Dental", usd: 60 });
      await pay(w, "e1", "bs1", 200000); // R 2,000 paid
      const { rows } = await clientEffortReport(w.env, A);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ clientRef: "company:bs1", name: "Brightside Dental", matchedBy: "name", usd: 60, paidZar: 2000, doneIssues: 1, runs: 1 });
      expect(rows[0]!.ratio).toBeCloseTo(0.54, 2); // 60 USD x 18 / R 2,000
      const [check] = await effort(w);
      expect(check).toMatchObject({ key: "client-effort:company:bs1", status: "warn", title: "Brightside Dental: agent effort is 54% of what they paid" });
      expect(check!.detail).toContain("$60 (about R 1,080 at 18 per USD) against R 2,000 paid");
    });

    it("goes red when the effort costs more than the client paid, and clears when a payment comes in", async () => {
      const w = await make();
      await clientWithWork(w, { id: "bs1", name: "Brightside Dental", usd: 120 });
      await pay(w, "e1", "bs1", 100000);
      expect((await effort(w))[0]).toMatchObject({ status: "bad", title: "Brightside Dental: agent effort is 216% of what they paid" });
      await pay(w, "e2", "bs1", 900000);
      expect(await effort(w)).toEqual([]);
    });

    it("a payment older than 30 days does not count, and says nothing was paid when real effort has no income", async () => {
      const w = await make();
      await clientWithWork(w, { id: "bs1", name: "Brightside Dental", usd: 150 });
      await pay(w, "old", "bs1", 5000000, "ZAR", daysAgo(45));
      expect((await effort(w))[0]).toMatchObject({ status: "warn", title: "Brightside Dental: $150 of agent effort and nothing paid in 30 days" });
    });

    it("ties a project to a client through the CRM's link, whatever the project is called", async () => {
      const w = await make();
      const projectId = await clientWithWork(w, { id: "nw1", name: "Northwind", projectName: "Menu site 2026", usd: 80 });
      expect((await clientEffortReport(w.env, A)).rows).toEqual([]);
      await rememberClientProjects(w.ctx, A, { clientKind: "company", clientRef: "nw1", projectIds: [projectId], updatedAt: NOW });
      const { rows } = await clientEffortReport(w.env, A);
      expect(rows[0]).toMatchObject({ clientRef: "company:nw1", matchedBy: "link", usd: 80 });
    });

    it("reads the project links of every client, in batches, and ties each to its own project (60 clients: more than one batch)", async () => {
      const w = await make();
      let reads = 0;
      let live = 0;
      let peak = 0;
      const realGet = w.ctx.state.get.bind(w.ctx.state);
      (w.ctx.state as unknown as { get: typeof realGet }).get = async (key) => {
        reads += 1;
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((resolve) => setImmediate(resolve));
        live -= 1;
        return realGet(key);
      };
      const projects: string[] = [];
      for (let i = 0; i < 60; i += 1) {
        // projects are named differently from the client, so only the CRM link can tie them together
        const id = await clientWithWork(w, { id: `cl${i}`, name: `Client ${i}`, projectName: `Site ${i}`, usd: 10 + i });
        projects.push(id);
        await rememberClientProjects(w.ctx, A, { clientKind: "company", clientRef: `cl${i}`, projectIds: [id], updatedAt: NOW });
      }
      reads = 0;
      const { rows } = await clientEffortReport(w.env, A);
      expect(reads).toBe(60); // one read per client
      expect(peak).toBeGreaterThan(1); // at the same time, not one after another
      expect(peak).toBeLessThanOrEqual(25); // but never all at once
      expect(rows).toHaveLength(60);
      expect(rows.every((r) => r.matchedBy === "link")).toBe(true);
      // every client is tied to ITS project: the spend is 10 + its number
      for (const r of rows) expect(r.usd).toBe(10 + Number(r.name.replace("Client ", "")));
    });

    it("a lead's effort is listed but never alerted, and other companies' work is not counted", async () => {
      const w = await make();
      await clientWithWork(w, { id: "l1", name: "Prospect Pty", lifecycle: "lead", usd: 500 });
      const { rows } = await clientEffortReport(w.env, A);
      expect(rows[0]).toMatchObject({ name: "Prospect Pty", lifecycle: "lead", usd: 500 });
      expect(await effort(w)).toEqual([]);
    });

    it("takes the exchange rate and the alert ratio from the settings, blank or nonsense falling back", async () => {
      const w = await make({ healthIssue: true, usdRate: 10, effortAlertRatio: 0.9 });
      expect(await effortSettings(w.ctx, A)).toEqual({ usdRate: 10, alertRatio: 0.9 });
      await clientWithWork(w, { id: "bs1", name: "Brightside Dental", usd: 100 });
      await pay(w, "e1", "bs1", 200000);
      expect(await effort(w)).toEqual([]); // 100 x 10 / 2,000 = 0.5, under 0.9
      const loose = await make({ healthIssue: true, usdRate: -3, effortAlertRatio: "high" });
      expect(await effortSettings(loose.ctx, A)).toEqual({ usdRate: 18, alertRatio: 0.5 });
    });

    it("the measure-report tool adds the client ranking and says what the numbers are", async () => {
      const w = await make();
      await clientWithWork(w, { id: "bs1", name: "Brightside Dental", usd: 60 });
      await pay(w, "e1", "bs1", 200000);
      const out = (await w.tools.get("measure-report")!({ parts: ["clients"] }, RUN)) as { error?: string; data: { clients: Array<Record<string, any>>; clientNotes: string } };
      expect(out.error).toBeUndefined();
      expect(out.data.clients[0]).toMatchObject({ client: "Brightside Dental", notionalUsd: 60, paidZar: 2000, effortVsPaid: 0.54, rateUsed: 18, matchedBy: "name" });
      expect(out.data.clientNotes).toContain("Billing publishes no retainer amounts");
      const without = (await w.tools.get("measure-report")!({}, RUN)) as { data: Record<string, unknown> };
      expect(without.data.clients).toBeUndefined();
    });
  });
});
