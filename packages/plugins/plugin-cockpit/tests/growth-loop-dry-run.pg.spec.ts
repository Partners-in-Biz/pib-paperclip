/**
 * The growth loop dry run (PAR-4170, W5 C41). The Social plugin's real growth service runs one experiment on the canary client, from the
 * program through two tagged posts and six metric records to `measure-experiments`, and its own `growth.verdict` event reaches the Cockpit's real
 * subscriber, which writes the ledger row. Nothing here writes the ledger: the count is 0 before the job and 1 after it.
 * It is a test, not a journey file, because a journey can only call tools and there is none for the job (it runs daily), and the autopilot
 * level and the experiment's approval are for a person (the Acceptance agent never approves).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { socialConfigFrom } from "../../plugin-social/src/config.js";
import { NAMESPACE } from "../../plugin-social/src/namespace.js";
import { applyExperimentTag, approveExperiment, measureExperimentsJob, proposeExperiment, scoreCompany, type GrowthActor, type GrowthEnv } from "../../plugin-social/src/growth/service.js";
import { fakeCtx as socialFakeCtx, TEST_UI_BASE } from "../../plugin-social/tests/helpers.js";
import { daysAgo, memoryStore, type MemPost } from "../../plugin-social/tests/memory-store.js";
import { COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds, type Hybrid } from "./helpers/hybrid.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const CO = COMPANY;
/** Social's test host knows one company by this id; the Cockpit world has its own, so the event is delivered under the Cockpit's. */
const SOCIAL_CO = "co";
const CANARY_ID = "canary-1a2b3c4d";
const CANARY = { kind: "company" as const, id: CANARY_ID, name: "PiB Canary Co" };
const CANARY_SCOPE = `client:company:${CANARY_ID}`;
const OTHER_SCOPE = "client:company:c-other";
const AGENT: GrowthActor = { companyId: SOCIAL_CO, userId: null, agentId: "agent-1", isAgent: true };
const PERSON: GrowthActor = { companyId: SOCIAL_CO, userId: "user-1", agentId: null, isAgent: false };
const RUN = { agentId: "aaaaaaaa-0000-4000-8000-0000000000a1", runId: "run-1", companyId: CO, projectId: "" };
const T = (name: string) => `${NAMESPACE}.${name}`;

d("the growth loop dry run on the canary client", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  const ledger = async (cockpit: Hybrid, scope?: string) => ((await cockpit.tools.get("growth-ledger")!(scope ? { scope } : {}, RUN)) as { data: { count: number; items: Array<Record<string, unknown>> } }).data;

  async function setup() {
    const cockpit = await worlds.make({ savedConfigs: { [CO]: { healthIssue: true } }, prefixes: { [CO]: "PAR" } });
    const { store, db } = memoryStore();
    const created: Array<Record<string, unknown>> = [];
    const config = { publicBaseUrl: "https://paperclip.test", timezone: "Africa/Johannesburg" };
    const ctx = socialFakeCtx(
      {
        config: { get: vi.fn(async () => config) },
        issues: {
          create: vi.fn(async (input: Record<string, unknown>) => {
            created.push(input);
            return { id: `iss-${created.length}`, status: String(input.status ?? "todo") };
          }),
          get: vi.fn(async (id: string) => ({ id, status: "todo" })),
          update: vi.fn(async (id: string) => ({ id })),
          createComment: vi.fn(async () => undefined),
          requestWakeup: vi.fn(async () => ({ queued: true })),
        },
        companies: { get: vi.fn(async () => ({ id: SOCIAL_CO, issuePrefix: "PAR", defaultResponsibleUserId: "default-person" })) },
        projects: { managed: { get: vi.fn(async () => ({ projectId: "proj-social" })) } },
        // The host's delivery: what Social emits arrives at the Cockpit as `plugin.<key>.<event>`.
        events: { emit: vi.fn(async (name: string, _companyId: string, payload: unknown) => cockpit.fire(`plugin.partnersinbiz.social.${name}`, { companyId: CO, payload })) },
      },
      { queryResult: (sql, params) => (sql.includes(T("crm_companies")) && params[1] === CANARY_ID ? [{ id: CANARY_ID, name: CANARY.name, domain: "canary.invalid", lifecycle: "customer" }] : []) }
    );
    const clock = { at: new Date() };
    const env: GrowthEnv = { ctx, store, now: () => clock.at };
    return { cockpit, clock, env, db, created, social: socialConfigFrom(ctx, SOCIAL_CO, config, TEST_UI_BASE), ctx };
  }

  const post = (w: Awaited<ReturnType<typeof setup>>, id: string, days: number): MemPost => {
    const p: MemPost = { id, companyId: SOCIAL_CO, body: `Acceptance rehearsal ${id}`, media: [], status: "published", clientKind: CANARY.kind, clientRef: CANARY.id, clientName: CANARY.name, publishedAt: daysAgo(days), experimentId: null, experimentArm: null, createdAt: daysAgo(days + 1) };
    w.db.posts.push(p);
    return p;
  };
  const metric = (w: Awaited<ReturnType<typeof setup>>, p: MemPost, likes: number) =>
    w.db.metrics.push({ companyId: SOCIAL_CO, window: "7d", destinationId: `d-${p.id}`, postId: p.id, accountId: "acc1", platform: "facebook", publishedAt: p.publishedAt, likes, comments: 0, shares: 0, saves: 0, clicks: 0, reach: 100, impressions: null, views: null, clientKind: p.clientKind, clientRef: p.clientRef, clientName: p.clientName });

  it("measures one experiment, and Social's own event writes the ledger row for the canary scope only; a person still decides the playbook change", async () => {
    const w = await setup();
    // Four earlier posts at the account's usual level (the baseline the score needs): with the two tagged posts, eight metric records in all.
    for (const [i, days] of [25, 22, 19, 16].entries()) metric(w, post(w, `base${i}`, days), 10);

    // The program starts on its own on first use, on safe autopilot: the agent proposes and a person starts the experiment.
    const exp = await proposeExperiment(w.env, AGENT, { client: `company:${CANARY_ID}`, hypothesis: "A question hook lifts engagement", hypothesisType: "hook:question", variable: "hook", minPerArm: 2, arms: [{ key: "control", description: "Statement hook" }, { key: "variant", description: "Question hook" }] } as never);
    expect(exp.status).toBe("proposed");
    await approveExperiment(w.env, PERSON, { experimentId: exp.experimentId });

    // Two posts in each arm: the least an experiment accepts (minPerArm 2), so the verdict is a real one and not a 21-day timeout.
    for (const [arm, likes] of [["control", 10], ["variant", 20]] as const) {
      for (const n of [1, 2]) {
        const p = post(w, `${arm}-${n}`, 8);
        await applyExperimentTag(w.env, SOCIAL_CO, { id: p.id, client_kind: CANARY.kind, client_ref: CANARY.id, client_name: CANARY.name } as never, { experimentId: exp.experimentId, arm });
        metric(w, p, likes);
      }
    }
    await scoreCompany(w.env, w.social);

    expect((await ledger(w.cockpit)).count).toBe(0);
    const summary = await measureExperimentsJob(w.ctx, async () => undefined, w.env);
    expect(summary).toMatchObject({ measured: 1, errors: 0 });

    const emitted = (w.ctx.events.emit as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === "growth.verdict");
    expect(emitted).toHaveLength(1);
    const rows = await ledger(w.cockpit, CANARY_SCOPE);
    expect(rows.count, "the verdict event must write exactly one ledger row").toBe(1);
    expect(rows.items[0]).toMatchObject({ channel: "social", scopeKey: CANARY_SCOPE, experimentId: exp.experimentId, verdict: "win", items: 4, playbookDecision: "pending" });
    expect((await ledger(w.cockpit, OTHER_SCOPE)).count).toBe(0);

    // Reviewer decides: on safe autopilot nothing is kept by the run; the change waits as pending for a person.
    expect(rows.items[0]!.playbookDecision).toBe("pending");
    expect(w.created.some((i) => /playbook|decide|growth/i.test(String(i.title)))).toBe(true);
  }, 60_000);
});
