/** The hidden-issue set (PAR-10548 T2): every SQL clause against a real Postgres. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rememberClientProjects } from "@partnersinbiz/pib-plugin-kit";
import { companyBrief, listUnassigned, loadCompanyData, waitingSplit } from "../src/brief.js";
import { NAMESPACE } from "../src/namespace.js";
import { ownerFilter } from "../src/owner-filter.js";
import { buildView, type LoadResult } from "../src/view.js";
import type { CockpitSnapshot } from "../src/merge.js";
import { COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds, type Hybrid } from "./helpers/hybrid.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;
const A = COMPANY;
const NOW = "2026-10-03T12:00:00.000Z";
const SPRINT = "plugin:partnersinbiz.seo:sprint";
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

d("hidden issue set (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  async function make(config: Record<string, unknown> = {}) {
    seq = 0;
    return worlds.make({ savedConfigs: { [A]: config }, prefixes: { [A]: "PAR" } });
  }
  async function issue(w: Hybrid, o: { identifier: string; origin?: string; project?: string; agent?: string | null; status?: string }): Promise<string> {
    const id = uuid();
    await w.client.query(
      `INSERT INTO public.issues (id, company_id, identifier, title, status, origin_kind, project_id, assignee_agent_id, created_at) VALUES ($1, $2, $3, 'T', $4, $5, $6, $7, now() - interval '3 days')`,
      [id, A, o.identifier, o.status ?? "todo", o.origin ?? null, o.project ?? null, o.agent ?? null],
    );
    return id;
  }
  async function crm(w: Hybrid, id: string, projects: string[], o: { name?: string; deleted?: boolean } = {}) {
    await w.client.query(`INSERT INTO ${NAMESPACE}.crm_companies (id, company_id, name, updated_at, deleted) VALUES ($1, $2, $3, now(), $4)`, [id, A, o.name ?? id, o.deleted ?? false]);
    await rememberClientProjects(w.ctx, A, { clientKind: "company", clientRef: id, projectIds: projects, updatedAt: NOW });
  }
  const hidden = (w: Hybrid) => ownerFilter(w.env, A);

  it("1. an open issue with the sprint origin is hidden; another origin is not", async () => {
    const w = await make();
    const a = await issue(w, { identifier: "PAR-1", origin: SPRINT, agent: "aaaaaaaa-0000-4000-8000-0000000000a1" });
    const b = await issue(w, { identifier: "PAR-2", origin: "manual" });
    const done = await issue(w, { identifier: "PAR-3", origin: SPRINT, status: "done" });
    const r = await hidden(w);
    expect(r.hiddenIssueIds).toContain(a);
    expect(r.hiddenIssueIds).not.toContain(b);
    expect(r.hiddenIssueIds).not.toContain(done);
  });

  it("2. a standing queue identifier is hidden and leaves the unassigned count and items; empty setting counts it", async () => {
    const w = await make({ standingQueueIssues: ["PAR-9356", "bad id"] });
    const queue = await issue(w, { identifier: "PAR-9356" });
    const other = await issue(w, { identifier: "PAR-9357" });
    const r = await hidden(w);
    expect(r.hiddenIssueIds).toEqual([queue]);
    const list = await listUnassigned(w.ctx, A, r.hiddenIssueIds);
    expect([list.count, list.items.map((i) => i.id)]).toEqual([1, [other]]);
    const empty = await make({});
    await issue(empty, { identifier: "PAR-9356" });
    const none = await hidden(empty);
    expect(none.hiddenIssueIds).toEqual([]);
    expect((await listUnassigned(empty.ctx, A, none.hiddenIssueIds)).count).toBe(1);
  });

  it("3. an issue in a project linked only to a canary company is hidden; the same in a real client's project is not", async () => {
    const w = await make();
    const canaryProject = uuid();
    const realProject = uuid();
    await crm(w, "canary-run1", [canaryProject]);
    await crm(w, "9f8e7d6c-0000-4000-8000-000000000001", [realProject], { name: "Real" });
    const c = await issue(w, { identifier: "PAR-1", project: canaryProject });
    const r = await issue(w, { identifier: "PAR-2", project: realProject });
    const out = (await hidden(w)).hiddenIssueIds;
    expect(out).toContain(c);
    expect(out).not.toContain(r);
  });

  it("4. a project linked to both a canary and a real company is not excluded", async () => {
    const w = await make();
    const shared = uuid();
    await crm(w, "canary-run1", [shared]);
    await crm(w, "9f8e7d6c-0000-4000-8000-000000000001", [shared], { name: "Real" });
    const i = await issue(w, { identifier: "PAR-1", project: shared });
    expect((await hidden(w)).hiddenIssueIds).not.toContain(i);
  });

  it("5. a real company with a UUID id named 'PiB Canary Co' is not canary", async () => {
    const w = await make();
    const project = uuid();
    await crm(w, "9f8e7d6c-0000-4000-8000-000000000002", [project], { name: "PiB Canary Co" });
    const i = await issue(w, { identifier: "PAR-1", project });
    expect((await hidden(w)).hiddenIssueIds).not.toContain(i);
  });

  it("6. a deleted canary company's linked project is still excluded", async () => {
    const w = await make();
    const project = uuid();
    await crm(w, "canary-old", [project], { deleted: true });
    const i = await issue(w, { identifier: "PAR-1", project });
    expect((await hidden(w)).hiddenIssueIds).toContain(i);
  });

  it("7. a failed canary read leaves the other parts working and names canary in degraded", async () => {
    const w = await make({ standingQueueIssues: ["PAR-5"] });
    const queue = await issue(w, { identifier: "PAR-5" });
    const sprint = await issue(w, { identifier: "PAR-6", origin: SPRINT });
    const real = w.env.ctx.db;
    (w.env.ctx as unknown as { db: unknown }).db = { ...real, query: (sql: string, p?: unknown[]) => (sql.includes("crm_companies") ? Promise.reject(new Error("boom")) : real.query(sql, p as never)) };
    const r = await hidden(w);
    expect(r.degraded).toEqual(["canary"]);
    expect([...r.hiddenIssueIds].sort()).toEqual([queue, sprint].sort());
  });

  it("8. through splitOwnerWaiting a snapshot item and a REST owner issue on a hidden id leave the tool and buildView lists", async () => {
    const w = await make();
    const sprint = await issue(w, { identifier: "PAR-1", origin: SPRINT });
    const { hiddenIssueIds } = await hidden(w);
    expect(hiddenIssueIds).toEqual([sprint]);
    const item = (key: string, issueId: string) => ({ key, title: key, why: "w", kind: "review", issueId });
    const snapshot = { plugin: "partnersinbiz.social", title: "Social", checkedAt: NOW, kpis: [], health: [], waiting: [item("hid", sprint), item("keep", "i-keep")], activity: [], quality: [] } as unknown as CockpitSnapshot;
    const ownerIssues = [{ id: sprint, title: "Sprint", status: "todo" }, { id: "i-own", title: "Own", status: "todo" }];
    const data = { snapshots: [snapshot], approvals: [], ownerIssues, setupMissing: 0, agents: [], hiddenIssueIds } as never;
    const tool = waitingSplit(data, new Date(NOW)).owner;
    expect(tool.map((e) => e.issueId ?? e.key).sort()).toEqual(["i-keep", "i-own"]);
    const load = { snapshots: { [snapshot.plugin]: { snapshot, receivedAt: NOW } }, setupStatuses: {}, roles: null, ownerFilter: { activeAgentIds: [], hiddenIssueIds } } as unknown as LoadResult;
    const view = buildView({ load, installed: null, modules: null, live: {}, agents: [], now: new Date(NOW), windowMs: 86_400_000, setupMissing: 0, myIssues: ownerIssues } as never);
    expect(view.waiting.some((e) => e.issueId === sprint)).toBe(false);
    expect(view.waiting.some((e) => e.issueId === "i-keep")).toBe(true);
  });

  it("9. a malformed canary project id does not break the query; the good one still hides", async () => {
    const w = await make({ standingQueueIssues: ["PAR-5"] });
    const good = uuid();
    await crm(w, "canary-run1", [good, "not-a-uuid"]);
    const i = await issue(w, { identifier: "PAR-1", project: good });
    const queue = await issue(w, { identifier: "PAR-5" });
    const r = await hidden(w);
    expect(r.degraded).toEqual([]);
    expect([...r.hiddenIssueIds].sort()).toEqual([i, queue].sort());
  });

  it("10. both callers (loadCompanyData, cockpit.load) carry the hidden set and leave it out of unassigned", async () => {
    const w = await make({ standingQueueIssues: ["PAR-9356"] });
    const sprint = await issue(w, { identifier: "PAR-1", origin: SPRINT, agent: "aaaaaaaa-0000-4000-8000-0000000000a1" });
    const queue = await issue(w, { identifier: "PAR-9356" });
    const other = await issue(w, { identifier: "PAR-9357" });
    const data = await loadCompanyData(w.env, A);
    expect([...(data.hiddenIssueIds ?? [])].sort()).toEqual([sprint, queue].sort());
    expect([data.unassigned.count, data.unassigned.items.map((i) => i.id)]).toEqual([1, [other]]);
    const load = (await w.actions.get("cockpit.load")!({ team: false }, { companyId: A, actor: { type: "user", userId: "u1" } })) as { unassigned: { count: number; items: { id: string }[] }; ownerFilter: { hiddenIssueIds: string[] } };
    expect([...load.ownerFilter.hiddenIssueIds].sort()).toEqual([sprint, queue].sort());
    expect([load.unassigned.count, load.unassigned.items.map((i) => i.id)]).toEqual([1, [other]]);
  });

  it("11. setupRouted is true only when a standing queue is set, through ownerFilter, loadCompanyData, cockpit.load and companyBrief", async () => {
    const ctxOf = { companyId: A, actor: { type: "user", userId: "u1" } };
    const OTHER_SEAT = "aaaaaaaa-0000-4000-8000-0000000000b1";
    const routed = await make({ standingQueueIssues: ["PAR-9356"], decisionRights: { seats: { other: OTHER_SEAT } } });
    expect((await hidden(routed)).setupRouted).toBe(true);
    expect((await loadCompanyData(routed.env, A)).setupRouted).toBe(true);
    const load = (await routed.actions.get("cockpit.load")!({ team: false }, ctxOf)) as { ownerFilter: { setupRouted?: boolean } };
    expect(load.ownerFilter.setupRouted).toBe(true);
    const plain = await make();
    expect((await hidden(plain)).setupRouted).toBe(false);
    expect((await loadCompanyData(plain.env, A)).setupRouted).toBe(false);
    const plainLoad = (await plain.actions.get("cockpit.load")!({ team: false }, ctxOf)) as { ownerFilter: { setupRouted?: boolean } };
    expect(plainLoad.ownerFilter.setupRouted).toBe(false);
    // The Finish setup row: with the owner when no queue is set, with others when one is (brief and page).
    const setupKeys = async (w: Hybrid) => {
      await w.ctx.state.set({ scopeKind: "company", scopeId: A, namespace: "cockpit", stateKey: "setup-summary" }, { requiredLeft: 2, requiredDone: 1, requiredTotal: 3, optionalLeft: 0, finishIssueId: null, updatedAt: NOW });
      const brief = await companyBrief(w.env, A);
      return { waiting: brief.waiting.filter((i) => /Finish setup/.test(i.title)).length, others: brief.others.items.filter((i) => /Finish setup/.test(i.title)).length, missing: brief.setupMissing, seat: (brief.others.items.find((i) => /Finish setup/.test(i.title))?.waitsOn as { agentId?: string } | null | undefined)?.agentId ?? null };
    };
    const r = await setupKeys(routed);
    const p = await setupKeys(plain);
    expect(r.missing).toBeGreaterThan(0);
    expect(r).toMatchObject({ waiting: 0, others: 1, seat: OTHER_SEAT });
    expect(p).toMatchObject({ waiting: 1, others: 0 });
    const view = (l: { ownerFilter: unknown }, missing: number) => buildView({ load: { snapshots: {}, setupStatuses: {}, roles: null, ownerFilter: l.ownerFilter } as unknown as LoadResult, installed: null, modules: null, live: {}, agents: [], now: new Date(NOW), windowMs: 86_400_000, setupMissing: missing, myIssues: [] } as never);
    expect(view(load, 2).waitingOthers.find((e) => e.key === "setup:missing")?.waitsOn).toEqual({ kind: "agent", agentId: OTHER_SEAT });
    expect(view(plainLoad, 2).waiting.map((e) => e.key)).toContain("setup:missing");
  });

  it("12. (PAR-14783) the same ask from two sources is one card through waitingSplit (brief tool) and buildView", async () => {
    const mk = (plugin: string, key: string, since: string) => ({ plugin, title: plugin, checkedAt: NOW, kpis: [], health: [], waiting: [{ key, title: "Connect Velox social accounts", why: "w", kind: "grant", since }], activity: [], quality: [] }) as unknown as CockpitSnapshot;
    const a = mk("partnersinbiz.social", "social:connect:1", "2026-10-01T00:00:00.000Z");
    const b = mk("partnersinbiz.other", "other:connect:9", "2026-10-02T00:00:00.000Z");
    const tool = waitingSplit({ snapshots: [a, b], approvals: [], ownerIssues: [], setupMissing: 0, agents: [], hiddenIssueIds: [] } as never, new Date(NOW)).owner;
    expect(tool.map((e) => e.key)).toEqual(["social:connect:1"]);
    expect(tool[0]!.why).toContain("2 listings merged");
    const load = { snapshots: { [a.plugin]: { snapshot: a, receivedAt: NOW }, [b.plugin]: { snapshot: b, receivedAt: NOW } }, setupStatuses: {}, roles: null, ownerFilter: { activeAgentIds: [], hiddenIssueIds: [] } } as unknown as LoadResult;
    const view = buildView({ load, installed: null, modules: null, live: {}, agents: [], now: new Date(NOW), windowMs: 86_400_000, setupMissing: 0, myIssues: [] } as never);
    expect(view.waiting.filter((e) => e.title === "Connect Velox social accounts")).toHaveLength(1);
  });
});
