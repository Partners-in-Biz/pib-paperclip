/**
 * Generation from a board card against real Postgres (PAR-14281; plan PAR-14257 E "3c"): the estimate is what is
 * reserved; the daily limit and the cap refuse before any provider call; a failure refunds and stops counting; two
 * clicks at 19 of 20 let exactly one through; the agent path (a run on a board chat thread) counts; the switch and a
 * throwing settings read refuse; the ledger names the board's client or own work; inputs are copied at the click.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { rememberClientProjects } from "@partnersinbiz/pib-plugin-kit";
import { boardGenerationFor, boardMarkForRun, boardUsedToday, type BoardMark } from "../src/board-generation.js";
import { estimateGeneration, processQueue, requestGeneration, resetQueueStateForTests, type Actor, type Runtime } from "../src/generation.js";
import { setCap } from "../src/ledger.js";
import { ProviderError, type GenerationProvider, type JobState } from "../src/provider.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";

const CO = "11111111-1111-4111-8111-111111111111";
const MODEL = "higgsfield-ai/soul/v2/standard";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const available = await embeddedAvailable();
let pg: Pg;

beforeAll(async () => {
  if (available) pg = await startPg();
}, 120_000);
afterAll(async () => {
  if (available) await pg.stop();
});

class CountingProvider implements GenerationProvider {
  readonly key = "higgsfield";
  price = 0.5;
  estimates = 0;
  submits = 0;
  refuse = false;
  state: JobState = { state: "done", urls: ["https://cdn.example.com/out.png"], credits: null };
  async estimate() {
    this.estimates += 1;
    return this.price;
  }
  async submit() {
    this.submits += 1;
    if (this.refuse) throw new ProviderError("refused", "rejected");
    return `job-${this.submits}`;
  }
  async status() {
    return this.state;
  }
}

type Settings = { generate?: unknown; boardGenerationDailyLimit?: unknown } | "throws";

function makeCtx(db: Pg["db"], settings: { value: Settings }, issues: Record<string, { id: string; projectId: string | null; originKind?: string }> = {}): PluginContext {
  return {
    db,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    config: {
      get: async () => {
        if (settings.value === "throws") throw new Error("settings store down");
        return { r2: { accountId: "acct", bucket: "pib-private", accessKeyId: "AK", secretAccessKey: "plain-test-secret" }, higgsfield: { apiKey: "id:secret" }, boards: settings.value };
      },
    },
    secrets: { resolve: async () => "resolved" },
    state: (() => {
      const state = new Map<string, unknown>();
      const key = (k: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }) => JSON.stringify([k.scopeKind, k.scopeId, k.namespace, k.stateKey]);
      return { get: async (k: never) => state.get(key(k)) ?? null, set: async (k: never, v: unknown) => void state.set(key(k), v), delete: async (k: never) => void state.delete(key(k)) };
    })(),
    projects: { get: async (id: string) => ({ id, archivedAt: null }) },
    issues: { get: async (id: string) => issues[id] ?? null, createComment: async () => undefined, requestWakeup: async () => ({ queued: true }) },
  } as unknown as PluginContext;
}

const T = (name: string) => `${pg.db.namespace}.${name}`;

describe.skipIf(!available)("generate on a board card (PAR-14281)", () => {
  let settings: { value: Settings };
  let ctx: PluginContext;
  let provider: CountingProvider;
  let runtime: Runtime;

  beforeEach(async () => {
    await pg.reset();
    resetQueueStateForTests();
    settings = { value: { generate: true } };
    ctx = makeCtx(pg.db, settings);
    provider = new CountingProvider();
    runtime = { provider: async () => provider, download: async () => new Uint8Array(PNG), now: () => Date.now() };
    const now = new Date().toISOString();
    await pg.client.query(`INSERT INTO ${T("crm_companies")} (id, company_id, name, updated_at) VALUES ($1, $2, $3, $4)`, ["acme", CO, "Acme Ltd", now]);
    await rememberClientProjects(ctx, CO, { clientKind: "company", clientRef: "acme", projects: [{ projectId: "project-acme", kind: null }], updatedAt: now });
    await setCap(ctx, CO, "company", 100, "owner-1");
  });

  /** What the worker's `generator` does for a card click, then the click itself. */
  async function click(userId: string, projectId: string | null, extra: Record<string, unknown> = {}, on = ctx) {
    const params = { model: MODEL, prompt: "a lighthouse at dusk", ...extra };
    const board = await boardGenerationFor(on, CO, { projectId }, params, userId, "unrestricted");
    const actor: Actor = { userId, issueId: null, projectId: board.projectId, restriction: "unrestricted", board: board.mark, expectedCredits: extra.expectedCredits as number | undefined };
    return requestGeneration(on, CO, params, actor, runtime);
  }
  const ledger = () => pg.client.query(`SELECT kind, client_kind, client_ref, credits FROM ${T("credit_ledger")} ORDER BY created_at`).then((r) => r.rows as Array<{ kind: string; client_kind: string | null; client_ref: string | null; credits: string }>);

  it("the estimate is the amount reserved, and the ledger names the project board's client", async () => {
    const params = { model: MODEL, prompt: "a lighthouse at dusk" };
    const board = await boardGenerationFor(ctx, CO, { projectId: "project-acme" }, params, "user-1", "unrestricted");
    const est = await estimateGeneration(ctx, CO, params, { userId: "user-1", projectId: board.projectId, board: board.mark }, runtime);
    expect(est).toMatchObject({ creditsTotal: 0.5, dailyLimit: 20, usedToday: 0, client: "company:acme", clientName: "Acme Ltd" });
    const out = await click("user-1", "project-acme", { expectedCredits: est.creditsTotal });
    expect(out.creditsReserved).toBe(est.creditsTotal);
    expect(await ledger()).toEqual([{ kind: "reserve", client_kind: "company", client_ref: "acme", credits: "0.5" }]);
    const row = (await pg.client.query(`SELECT origin, acting_user_id, user_id, project_id FROM ${T("generations")}`)).rows[0];
    expect(row).toEqual({ origin: "board", acting_user_id: "user-1", user_id: "user-1", project_id: "project-acme" });
  });

  it("a company or personal board, and a project without a client, charge own work; a client is never picked by hand", async () => {
    await click("user-1", null);
    await click("user-1", "project-none");
    expect((await ledger()).map((r) => [r.client_kind, r.client_ref])).toEqual([[null, null], [null, null]]);
    await expect(click("user-1", null, { client: "company:acme" })).rejects.toMatchObject({ code: "bad_board_scope" });
  });

  it("a price that moved since the estimate is refused with nothing reserved", async () => {
    await expect(click("user-1", null, { expectedCredits: 0.4 })).rejects.toMatchObject({ code: "estimate_changed" });
    expect(await ledger()).toEqual([]);
  });

  it("over the daily limit: refused with its own code before any provider call", async () => {
    settings.value = { generate: true, boardGenerationDailyLimit: 2 };
    await click("user-1", null);
    await click("user-1", null);
    const before = provider.estimates;
    await expect(click("user-1", null)).rejects.toMatchObject({ code: "board_daily_limit" });
    expect(provider.estimates).toBe(before);
    expect(provider.submits).toBe(0);
    // Another person has their own count; Studio's own page is not counted at all.
    await expect(click("user-2", null)).resolves.toBeTruthy();
    await requestGeneration(ctx, CO, { model: MODEL, prompt: "page" }, { userId: "user-1" }, runtime);
    expect(await boardUsedToday(ctx, CO, "user-1", Date.now())).toBe(2);
  });

  it("over the cap: refused before any provider call, and an unset cap too", async () => {
    await setCap(ctx, CO, "company", 0, "owner-1");
    await expect(click("user-1", null)).rejects.toMatchObject({ code: "cap_reached" });
    await setCap(ctx, CO, "company", null, "owner-1");
    await expect(click("user-1", null)).rejects.toMatchObject({ code: "cap_not_set" });
    expect(provider.estimates).toBe(0);
    expect(provider.submits).toBe(0);
    await setCap(ctx, CO, "company", 0.7, "owner-1");
    await click("user-1", null);
    await expect(click("user-1", null)).rejects.toMatchObject({ code: "cap_reached" });
    expect(provider.submits).toBe(0);
  });

  it("a refused job refunds, and a failed generation no longer counts against the day", async () => {
    settings.value = { generate: true, boardGenerationDailyLimit: 1 };
    provider.refuse = true;
    await click("user-1", null);
    await processQueue(ctx, runtime);
    expect((await ledger()).map((r) => [r.kind, r.credits])).toEqual([["reserve", "0.5"], ["refund", "-0.5"]]);
    expect(await boardUsedToday(ctx, CO, "user-1", Date.now())).toBe(0);
    provider.refuse = false;
    await expect(click("user-1", null)).resolves.toBeTruthy();
  });

  it("two parallel clicks at 19 of 20: exactly one passes", async () => {
    for (let i = 0; i < 19; i++) await click("user-1", null);
    const other = makeCtx(await pg.connect(), settings);
    const results = await Promise.allSettled([click("user-1", null), click("user-1", null, {}, other)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "board_daily_limit" } });
    expect(await boardUsedToday(ctx, CO, "user-1", Date.now())).toBe(20);
  });

  it("switch off, and a settings read that throws, refuse before anything is priced", async () => {
    settings.value = {};
    await expect(click("user-1", null)).rejects.toMatchObject({ code: "board_generation_off" });
    settings.value = { generate: "yes" };
    await expect(click("user-1", null)).rejects.toMatchObject({ code: "board_generation_off" });
    settings.value = "throws";
    await expect(click("user-1", null)).rejects.toMatchObject({ code: "board_generation_off" });
    expect(provider.estimates).toBe(0);
  });

  it("inputs are copied into the row at the click; a later rewire cannot change it", async () => {
    const out = await click("user-1", null, { inputKeys: ["node-a", "node-b"] });
    // The card is rewired: new inputs on the next click, the first row keeps what it was started with.
    await click("user-1", null, { inputKeys: ["node-c"] });
    const rows = (await pg.client.query(`SELECT id, input_keys FROM ${T("generations")} ORDER BY created_at`)).rows as Array<{ id: string; input_keys: string[] }>;
    expect(rows.find((r) => r.id === out.generationIds[0])?.input_keys).toEqual(["node-a", "node-b"]);
    expect(rows.map((r) => r.input_keys)).toEqual([["node-a", "node-b"], ["node-c"]]);
    await expect(click("user-1", null, { inputKeys: Array.from({ length: 9 }, (_, i) => `k${i}`) })).rejects.toMatchObject({ code: "bad_request" });
  });

  describe("the agent path (stage 3d)", () => {
    function agentCtx(responsible: string | null, originKind: string) {
      const issues = { "thread-1": { id: "thread-1", projectId: null, originKind, originId: "b0a7d000-0000-4000-8000-000000000001:chat" }, "task-1": { id: "task-1", projectId: null } };
      const base = makeCtx(pg.db, settings, issues);
      const db = {
        namespace: pg.db.namespace,
        execute: pg.db.execute,
        query: async (sql: string, params?: unknown[]) => (/public\.heartbeat_runs/.test(sql) ? [{ issue_id: "thread-1", responsible_user_id: responsible }] : pg.db.query(sql, params)),
      };
      return { ...base, db } as unknown as PluginContext;
    }
    const run = { runId: "run-1", agentId: "agent-1", companyId: CO, projectId: "" } as unknown as ToolRunContext;

    it("a run on a board chat thread counts against its person, and is refused at the limit", async () => {
      settings.value = { generate: true, boardGenerationDailyLimit: 1 };
      const actx = agentCtx("user-1", "planning_canvas");
      const mark = (await boardMarkForRun(actx, run, "thread-1")) as BoardMark;
      expect(mark).toEqual({ userId: "user-1", dailyLimit: 1, inputKeys: [] });
      await setCap(ctx, CO, "agent_run", 10, "owner-1");
      await requestGeneration(actx, CO, { model: MODEL, prompt: "x" }, { agentId: "agent-1", runId: "run-1", issueId: "thread-1", projectId: null, board: mark }, runtime);
      await expect(click("user-1", null)).rejects.toMatchObject({ code: "board_daily_limit" });
    });

    it("a run on any other issue is not a board generation; a thread run with no person is refused", async () => {
      expect(await boardMarkForRun(agentCtx("user-1", "manual"), run, "task-1")).toBeNull();
      await expect(boardMarkForRun(agentCtx(null, "planning_canvas"), run, "thread-1")).rejects.toMatchObject({ code: "board_no_person" });
      settings.value = {};
      await expect(boardMarkForRun(agentCtx("user-1", "planning_canvas"), run, "thread-1")).rejects.toMatchObject({ code: "board_generation_off" });
    });
  });
});
