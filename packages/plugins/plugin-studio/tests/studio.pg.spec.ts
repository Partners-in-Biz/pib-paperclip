import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { rememberClientProjects } from "@partnersinbiz/pib-plugin-kit";
import { assetFileForAgent, assetOut, getAssetRow, importFromAttachment, linkAsset, listAssets } from "../src/assets.js";
import { estimateGeneration, processQueue, requestGeneration, generationStatus, resetQueueStateForTests, type Runtime } from "../src/generation.js";
import { capHistory, setCap, usage, currentPeriod, DEFAULT_RUN_LIMIT, runLimitOf, runUsage, agentLimitKey } from "../src/ledger.js";
import { ProviderError, type GenerationProvider, type JobState } from "../src/provider.js";
import { isCompanyOwner, usageView } from "../src/service.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";

const CO = "11111111-1111-4111-8111-111111111111";
const OTHER_CO = "22222222-2222-4222-8222-222222222222";
const ACME = { kind: "company" as const, id: "acme" };
const GLOBEX = { kind: "company" as const, id: "globex" };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

const available = await embeddedAvailable();
let pg: Pg;
let workdir: string;

beforeAll(async () => {
  if (available) pg = await startPg();
  workdir = mkdtempSync(join(tmpdir(), "studio-files-"));
  process.env.PIB_STUDIO_WORKDIR = workdir;
}, 120_000);

afterAll(async () => {
  if (available) await pg.stop();
  rmSync(workdir, { recursive: true, force: true });
  delete process.env.PIB_STUDIO_WORKDIR;
});

interface World {
  ctx: PluginContext;
  comments: Array<{ issueId: string; body: string }>;
  wakes: Array<{ issueId: string; idempotencyKey?: string | null }>;
  refuseWake: { on: boolean };
  puts: string[];
}

function makeWorld(): World {
  const state = new Map<string, unknown>();
  const stateKey = (k: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }) => JSON.stringify([k.scopeKind, k.scopeId, k.namespace, k.stateKey]);
  const comments: World["comments"] = [];
  const wakes: World["wakes"] = [];
  const refuseWake = { on: false };
  const puts: string[] = [];
  const issues: Record<string, { id: string; projectId: string | null }> = {
    "issue-acme": { id: "issue-acme", projectId: "project-acme" },
    "issue-globex": { id: "issue-globex", projectId: "project-globex" },
    "issue-own": { id: "issue-own", projectId: "project-own" },
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PUT") {
      puts.push(new URL(url).pathname);
      return new Response(null, { status: 200 });
    }
    return new Response(PNG, { status: 200 });
  }));
  const ctx = {
    db: pg.db,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    config: {
      get: async () => ({
        r2: { accountId: "acct", bucket: "pib-private", accessKeyId: "AK", secretAccessKey: "plain-test-secret" },
        higgsfield: { apiKey: "id:secret" },
      }),
    },
    secrets: { resolve: async () => "resolved" },
    state: {
      get: async (k: never) => state.get(stateKey(k)) ?? null,
      set: async (k: never, value: unknown) => void state.set(stateKey(k), value),
      delete: async (k: never) => void state.delete(stateKey(k)),
    },
    projects: { get: async (id: string) => ({ id, archivedAt: null }) },
    issues: {
      get: async (id: string) => issues[id] ?? null,
      createComment: async (issueId: string, body: string) => void comments.push({ issueId, body }),
      requestWakeup: async (issueId: string, _companyId: string, options?: { idempotencyKey?: string | null }) => {
        if (refuseWake.on) throw new Error("Issue is not wakeable in status: done");
        wakes.push({ issueId, idempotencyKey: options?.idempotencyKey });
        return { queued: true };
      },
      listAttachments: async (issueId: string) => (issueId === "issue-acme" ? [{ id: "att-1", byteSize: PNG.length, originalFilename: "made.png", contentType: "image/png" }] : []),
      getAttachmentContent: async () => ({ contentBase64: Buffer.from(PNG).toString("base64"), originalFilename: "made.png", contentType: "image/png" }),
    },
    access: {
      members: {
        list: async () => [
          { principalType: "user", principalId: "owner-1", status: "active", membershipRole: "owner" },
          { principalType: "user", principalId: "admin-1", status: "active", membershipRole: "admin" },
          { principalType: "user", principalId: "former-owner", status: "removed", membershipRole: "owner" },
        ],
      },
    },
  } as unknown as PluginContext;
  return { ctx, comments, wakes, refuseWake, puts };
}

class FakeProvider implements GenerationProvider {
  readonly key = "higgsfield";
  price = 0.5;
  submits: string[] = [];
  next: () => string = () => `job-${this.submits.length}`;
  state: JobState = { state: "done", urls: ["https://cdn.example.com/out.png"], credits: null };
  async estimate() {
    return this.price;
  }
  async submit(model: string) {
    this.submits.push(model);
    return this.next();
  }
  async status() {
    return this.state;
  }
}

function runtimeWith(provider: GenerationProvider, overrides: Partial<Runtime> = {}): Runtime {
  return { provider: async () => provider, download: async () => new Uint8Array(PNG), now: () => Date.now(), ...overrides };
}

const REQUEST = { model: "higgsfield-ai/soul/v2/standard", prompt: "A business man" };
const AGENT = { agentId: "agent-1", runId: "run-1" };

async function rows(world: World, sql: string, params: unknown[] = []): Promise<any[]> {
  void world;
  return pg.db.query(sql, params);
}

const T = (name: string) => `${pg.db.namespace}.${name}`;

describe.skipIf(!available)("Studio against real Postgres", () => {
  let world: World;
  let provider: FakeProvider;
  let runtime: Runtime;

  beforeEach(async () => {
    await pg.reset();
    resetQueueStateForTests();
    world = makeWorld();
    provider = new FakeProvider();
    runtime = runtimeWith(provider);
    const now = new Date().toISOString();
    for (const [id, name] of [["acme", "Acme Ltd"], ["globex", "Globex Inc"]] as const) {
      await pg.client.query(`INSERT INTO ${T("crm_companies")} (id, company_id, name, updated_at) VALUES ($1, $2, $3, $4)`, [id, CO, name, now]);
    }
    await rememberClientProjects(world.ctx, CO, { clientKind: "company", clientRef: "acme", projects: [{ projectId: "project-acme", kind: null }], updatedAt: now });
    await rememberClientProjects(world.ctx, CO, { clientKind: "company", clientRef: "globex", projects: [{ projectId: "project-globex", kind: null }], updatedAt: now });
  });

  afterEach(() => vi.unstubAllGlobals());

  const work = (issueId: string, projectId: string) => ({ ...AGENT, issueId, projectId });
  const acmeWork = () => work("issue-acme", "project-acme");

  describe("per agent run limit", () => {
    beforeEach(() => setCap(world.ctx, CO, "company", 100, "owner-1"));

    it("defaults to 2 credits per run and refuses past it with run_limit", async () => {
      expect(runLimitOf([])).toBe(DEFAULT_RUN_LIMIT);
      expect(DEFAULT_RUN_LIMIT).toBe(2);
      const run = { agentId: "agent-1", runId: "run-default" };
      let used = 0;
      let refused = false;
      for (let i = 0; i < 100 && !refused; i++) {
        try {
          const out = await requestGeneration(world.ctx, CO, REQUEST, run, runtime);
          expect(out).toBeTruthy();
          used = await runUsage(world.ctx, CO, "run-default");
          expect(used).toBeLessThanOrEqual(DEFAULT_RUN_LIMIT);
        } catch (err) {
          expect(err).toMatchObject({ code: "run_limit" });
          refused = true;
        }
      }
      expect(refused).toBe(true);
      expect(used).toBeGreaterThan(0);
      // A fresh run starts at zero; people (no run id) are not limited by it.
      await expect(requestGeneration(world.ctx, CO, REQUEST, { agentId: "agent-1", runId: "run-other" }, runtime)).resolves.toBeTruthy();
      await expect(requestGeneration(world.ctx, CO, { ...REQUEST, batchSize: 4 }, { userId: "user-1" } as never, runtime)).resolves.toBeTruthy();
    });

    it("is a setting: 0 stops agent runs, a higher value lets them through", async () => {
      await setCap(world.ctx, CO, "agent_run", 0, "owner-1");
      await expect(requestGeneration(world.ctx, CO, REQUEST, { agentId: "agent-1", runId: "run-zero" }, runtime)).rejects.toMatchObject({ code: "run_limit" });
      await setCap(world.ctx, CO, "agent_run", 50, "owner-1");
      await expect(requestGeneration(world.ctx, CO, { ...REQUEST, batchSize: 4 }, { agentId: "agent-1", runId: "run-zero" }, runtime)).resolves.toBeTruthy();
    });
  });

  describe("per agent limit (PAR-8142)", () => {
    const CREATIVE = { agentId: "creative-1", runId: "run-creative" };
    const DEV = { agentId: "dev-1", runId: "run-dev" };
    const reservedRows = async () => (await rows(world, `SELECT COUNT(*)::int AS n FROM ${T("credit_ledger")}`))[0].n as number;

    it("resolves agent limit, then company limit, then the default of 2", () => {
      const caps = [
        { scopeKey: agentLimitKey("creative-1"), monthlyCredits: 10 },
        { scopeKey: "agent_run", monthlyCredits: 5 },
      ];
      expect(runLimitOf(caps, "creative-1")).toBe(10);
      expect(runLimitOf(caps, "dev-1")).toBe(5);
      expect(runLimitOf(caps, null)).toBe(5);
      expect(runLimitOf([{ scopeKey: agentLimitKey("creative-1"), monthlyCredits: 10 }], "dev-1")).toBe(DEFAULT_RUN_LIMIT);
    });

    it("the agent limit overrides the company limit, and does not apply to another agent", async () => {
      await setCap(world.ctx, CO, "company", 100, "owner-1");
      await setCap(world.ctx, CO, "agent_run", 0.5, "owner-1");
      await setCap(world.ctx, CO, agentLimitKey("creative-1"), 50, "owner-1");
      await expect(requestGeneration(world.ctx, CO, { ...REQUEST, batchSize: 4 }, CREATIVE, runtime)).resolves.toBeTruthy();
      await requestGeneration(world.ctx, CO, REQUEST, DEV, runtime);
      await expect(requestGeneration(world.ctx, CO, REQUEST, DEV, runtime)).rejects.toMatchObject({ code: "run_limit" });
    });

    it("refuses over the agent limit with nothing reserved, and says where to go", async () => {
      await setCap(world.ctx, CO, "company", 100, "owner-1");
      await setCap(world.ctx, CO, agentLimitKey("dev-1"), 0.1, "owner-1");
      const before = await reservedRows();
      const err = await requestGeneration(world.ctx, CO, REQUEST, DEV, runtime).catch((e) => e);
      expect(err).toMatchObject({ code: "run_limit" });
      expect(err.message).toContain("Nothing was started");
      expect(err.message).toContain("Creative Producer");
      expect(err.message).toContain("request-creative");
      expect(err.message).toContain("PiB");
      expect(err.message).not.toMatch(/ask a person/i);
      expect(await reservedRows()).toBe(before);
      expect(await runUsage(world.ctx, CO, "run-dev")).toBe(0);
    });

    it("the monthly cap still wins over a higher agent limit", async () => {
      await setCap(world.ctx, CO, "company", 1, "owner-1");
      await setCap(world.ctx, CO, agentLimitKey("creative-1"), 50, "owner-1");
      let refused: unknown = null;
      for (let i = 0; i < 6 && !refused; i++) refused = await requestGeneration(world.ctx, CO, REQUEST, CREATIVE, runtime).then(() => null, (e) => e);
      expect(refused).toMatchObject({ code: "cap_reached" });
      expect(await runUsage(world.ctx, CO, "run-creative")).toBeLessThanOrEqual(1);
    });

    it("a person (no run id) is not affected by any agent limit", async () => {
      await setCap(world.ctx, CO, "company", 100, "owner-1");
      await setCap(world.ctx, CO, "agent_run", 0, "owner-1");
      await setCap(world.ctx, CO, agentLimitKey("dev-1"), 0, "owner-1");
      await expect(requestGeneration(world.ctx, CO, { ...REQUEST, batchSize: 4 }, { userId: "user-1" } as never, runtime)).resolves.toBeTruthy();
    });

    it("an agent limit can be cleared, falling back to the company limit", async () => {
      await setCap(world.ctx, CO, "company", 100, "owner-1");
      await setCap(world.ctx, CO, agentLimitKey("dev-1"), 0, "owner-1");
      await expect(requestGeneration(world.ctx, CO, REQUEST, DEV, runtime)).rejects.toMatchObject({ code: "run_limit" });
      await setCap(world.ctx, CO, agentLimitKey("dev-1"), null, "owner-1");
      await expect(requestGeneration(world.ctx, CO, REQUEST, DEV, runtime)).resolves.toBeTruthy();
    });
  });

  describe("settable caps", () => {
    it("refuses until a cap is set, then applies a change to the very next generation", async () => {
      await expect(requestGeneration(world.ctx, CO, REQUEST, acmeWork(), runtime)).rejects.toMatchObject({ code: "cap_not_set" });
      await setCap(world.ctx, CO, "company", 1, "owner-1");
      await requestGeneration(world.ctx, CO, REQUEST, acmeWork(), runtime);
      await requestGeneration(world.ctx, CO, REQUEST, acmeWork(), runtime);
      await expect(requestGeneration(world.ctx, CO, REQUEST, acmeWork(), runtime)).rejects.toMatchObject({ code: "cap_reached" });
      await setCap(world.ctx, CO, "company", 2, "owner-1");
      await expect(requestGeneration(world.ctx, CO, REQUEST, acmeWork(), runtime)).resolves.toBeTruthy();
    });

    it("treats 0 as off and a cleared cap as falling through to the next level", async () => {
      await setCap(world.ctx, CO, "default", 10, "owner-1");
      await setCap(world.ctx, CO, "company", 0, "owner-1");
      await expect(requestGeneration(world.ctx, CO, REQUEST, acmeWork(), runtime)).rejects.toMatchObject({ code: "cap_reached" });
      await setCap(world.ctx, CO, "company", null, "owner-1");
      await expect(requestGeneration(world.ctx, CO, REQUEST, acmeWork(), runtime)).resolves.toBeTruthy();
    });

    it("measures a client's own cap on that client's use only", async () => {
      await setCap(world.ctx, CO, "company", 100, "owner-1");
      await setCap(world.ctx, CO, "company:acme", 0.5, "owner-1");
      await requestGeneration(world.ctx, CO, REQUEST, acmeWork(), runtime);
      await expect(requestGeneration(world.ctx, CO, REQUEST, acmeWork(), runtime)).rejects.toMatchObject({ code: "cap_reached" });
      await expect(requestGeneration(world.ctx, CO, REQUEST, work("issue-globex", "project-globex"), runtime)).resolves.toBeTruthy();
      expect(await usageView(world.ctx, CO, ACME)).toMatchObject({ capSource: "client", monthlyCap: 0.5, usedThisMonth: 0.5, remaining: 0 });
      expect(await usageView(world.ctx, CO, GLOBEX)).toMatchObject({ capSource: "company", usedThisMonth: 1 });
    });

    it("keeps queued work running when the cap is lowered, and blocks only new work", async () => {
      await setCap(world.ctx, CO, "company", 10, "owner-1");
      await requestGeneration(world.ctx, CO, REQUEST, acmeWork(), runtime);
      await setCap(world.ctx, CO, "company", 0.1, "owner-1");
      await expect(requestGeneration(world.ctx, CO, REQUEST, acmeWork(), runtime)).rejects.toMatchObject({ code: "cap_reached" });
      await processQueue(world.ctx, runtime);
      expect(provider.submits).toHaveLength(1);
    });

    it("logs every change with who, the old value and the new value, and ignores a no-op", async () => {
      await setCap(world.ctx, CO, "company", 5, "owner-1");
      await setCap(world.ctx, CO, "company", 5, "owner-1");
      await setCap(world.ctx, CO, "company", 9, "owner-2");
      await setCap(world.ctx, CO, "company", null, "owner-2");
      const history = await capHistory(world.ctx, CO);
      expect(history.map((h) => [h.oldCredits, h.newCredits, h.changedBy])).toEqual(
        expect.arrayContaining([[null, 5, "owner-1"], [5, 9, "owner-2"], [9, null, "owner-2"]]),
      );
      expect(history).toHaveLength(3);
    });

    it("refuses a nonsense cap or scope", async () => {
      await expect(setCap(world.ctx, CO, "company", -1, "o")).rejects.toMatchObject({ code: "bad_cap" });
      await expect(setCap(world.ctx, CO, "company", Number.NaN, "o")).rejects.toMatchObject({ code: "bad_cap" });
      await expect(setCap(world.ctx, CO, "everyone", 1, "o")).rejects.toMatchObject({ code: "bad_scope" });
    });

    it("keeps one company's caps and use apart from another's", async () => {
      await setCap(world.ctx, CO, "company", 5, "owner-1");
      await requestGeneration(world.ctx, CO, REQUEST, acmeWork(), runtime);
      await expect(requestGeneration(world.ctx, OTHER_CO, REQUEST, AGENT, runtime)).rejects.toMatchObject({ code: "cap_not_set" });
      expect(await usage(world.ctx, OTHER_CO, currentPeriod())).toBe(0);
    });

    it("lets only an active owner change caps", async () => {
      const ok = (actor: object) => isCompanyOwner(world.ctx, CO, actor as never);
      expect(await ok({ type: "user", userId: "owner-1" })).toBe(true);
      expect(await ok({ type: "user", userId: "local-board" })).toBe(true);
      expect(await ok({ type: "user", userId: "admin-1" })).toBe(false);
      expect(await ok({ type: "user", userId: "former-owner" })).toBe(false);
      expect(await ok({ type: "user", userId: "stranger" })).toBe(false);
      expect(await ok({ type: "agent", agentId: "agent-1", userId: "owner-1" })).toBe(false);
    });
  });

  describe("Seedance table price and per-job ceiling (PAR-8309)", () => {
    const V20 = "bytedance/seedance-2.0/text-to-video";
    const V25 = "bytedance/seedance-2.5/text-to-video";
    const PERSON = { userId: "user-1", issueId: "issue-acme", projectId: "project-acme" };
    const seedance = (model: string, duration: number, resolution: string) => ({ model, prompt: "waves at sunset", params: { duration, resolution, aspect_ratio: "16:9" } });
    const ledgerRows = async () => (await rows(world, `SELECT COUNT(*)::int AS n FROM ${T("credit_ledger")}`))[0].n as number;
    let warns: Array<Record<string, unknown>>;

    beforeEach(async () => {
      await setCap(world.ctx, CO, "company", 500, "owner-1");
      warns = [];
      (world.ctx.logger as unknown as { warn: (msg: string, meta?: Record<string, unknown>) => void }).warn = (msg, meta) => void warns.push({ msg, ...meta });
    });

    it("prices from the table, not the provider's /estimate", async () => {
      const out = await requestGeneration(world.ctx, CO, seedance(V20, 5, "480p"), PERSON, runtime);
      expect(out.creditsReserved).toBe(10.761);
      expect(await usage(world.ctx, CO, currentPeriod())).toBe(10.761);
      expect((await estimateGeneration(world.ctx, CO, seedance(V25, 5, "480p"), PERSON, runtime)).creditsEach).toBe(16.449);
    });

    it("refuses a job over the ceiling with no row and no reserve", async () => {
      await expect(requestGeneration(world.ctx, CO, seedance(V25, 15, "720p"), PERSON, runtime)).rejects.toMatchObject({ code: "over_job_ceiling" });
      await expect(estimateGeneration(world.ctx, CO, seedance(V20, 15, "1080p"), PERSON, runtime)).rejects.toMatchObject({ code: "over_job_ceiling" });
      expect(await rows(world, `SELECT id FROM ${T("generations")}`)).toHaveLength(0);
      expect(await ledgerRows()).toBe(0);
      expect(await usage(world.ctx, CO, currentPeriod())).toBe(0);
    });

    it("never sends a queued row priced over the ceiling, and refunds it", async () => {
      const out = await requestGeneration(world.ctx, CO, seedance(V20, 5, "480p"), PERSON, runtime);
      // A row from before the ceiling: priced 70, its reserve not yet written.
      await pg.client.query(`UPDATE ${T("generations")} SET estimated_credits = 70 WHERE id = $1`, [out.generationIds[0]]);
      await pg.client.query(`DELETE FROM ${T("credit_ledger")}`);
      await processQueue(world.ctx, runtime);
      expect(provider.submits).toHaveLength(0);
      expect((await rows(world, `SELECT status, error_code FROM ${T("generations")}`))[0]).toEqual({ status: "failed", error_code: "over_job_ceiling" });
      expect(await rows(world, `SELECT kind FROM ${T("credit_ledger")} ORDER BY kind`)).toEqual([{ kind: "refund" }, { kind: "reserve" }]);
      expect(await usage(world.ctx, CO, currentPeriod())).toBe(0);
    });

    it.each([
      [null, "no_actual", 10.761],
      [5, "unit_suspect", 10.761],
      [8, "under", 8],
      [10.761, null, 10.761],
      [11.5, null, 11.5],
      [12, "drift", 12],
    ] as const)("settles actual %s credits as %s, ledger total %s", async (actual, kind, total) => {
      provider.state = { state: "done", urls: ["https://cdn.example.com/out.png"], credits: actual };
      await requestGeneration(world.ctx, CO, seedance(V20, 5, "480p"), PERSON, runtime);
      await processQueue(world.ctx, runtime);
      await processQueue(world.ctx, runtime);
      expect((await rows(world, `SELECT status FROM ${T("generations")}`))[0].status).toBe("succeeded");
      expect(await usage(world.ctx, CO, currentPeriod())).toBe(total);
      const checks = warns.filter((w) => w.msg === "studio.seedance_price_check");
      expect(checks.map((w) => w.kind)).toEqual(kind ? [kind] : []);
    });

    it.each([0, -1, Number.NaN])("refuses a provider price of %s as no_price, for any model", async (price) => {
      provider.price = price;
      await expect(requestGeneration(world.ctx, CO, REQUEST, PERSON, runtime)).rejects.toMatchObject({ code: "no_price" });
      await expect(estimateGeneration(world.ctx, CO, REQUEST, PERSON, runtime)).rejects.toMatchObject({ code: "no_price" });
      expect(await ledgerRows()).toBe(0);
    });
  });

  describe("charging", () => {
    beforeEach(() => setCap(world.ctx, CO, "company", 100, "owner-1"));

    it("charges a batch per unit, not as one", async () => {
      const out = await requestGeneration(world.ctx, CO, { ...REQUEST, batchSize: 4 }, acmeWork(), runtime);
      expect(out.generationIds).toHaveLength(4);
      expect(out.creditsReserved).toBe(2);
      expect(await usage(world.ctx, CO, currentPeriod())).toBe(2);
    });

    it("refuses a whole batch that doesn't fit, and writes nothing", async () => {
      await setCap(world.ctx, CO, "company", 1, "owner-1");
      await expect(requestGeneration(world.ctx, CO, { ...REQUEST, batchSize: 3 }, acmeWork(), runtime)).rejects.toMatchObject({ code: "cap_reached" });
      expect(await rows(world, `SELECT id FROM ${T("generations")}`)).toHaveLength(0);
      expect(await usage(world.ctx, CO, currentPeriod())).toBe(0);
    });

    it("gives the last credits to only one of several runs at once", async () => {
      await setCap(world.ctx, CO, "company", 1, "owner-1");
      const results = await Promise.allSettled(Array.from({ length: 5 }, () => requestGeneration(world.ctx, CO, REQUEST, acmeWork(), runtime)));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
      expect(await usage(world.ctx, CO, currentPeriod())).toBe(1);
    });

    it("refuses a batch size out of range", async () => {
      await expect(requestGeneration(world.ctx, CO, { ...REQUEST, batchSize: 9 }, acmeWork(), runtime)).rejects.toMatchObject({ code: "bad_request" });
      await expect(requestGeneration(world.ctx, CO, { ...REQUEST, batchSize: 0 }, acmeWork(), runtime)).rejects.toMatchObject({ code: "bad_request" });
    });

    it("settles to the provider's real price when it differs", async () => {
      provider.state = { state: "done", urls: ["https://cdn.example.com/out.png"], credits: 0.8 };
      await requestGeneration(world.ctx, CO, REQUEST, acmeWork(), runtime);
      await processQueue(world.ctx, runtime);
      await processQueue(world.ctx, runtime);
      expect(await usage(world.ctx, CO, currentPeriod())).toBe(0.8);
    });

    it.each([
      ["refused", "rejected"],
      ["out of credits", "out_of_credits"],
    ] as const)("refunds when the provider %s", async (_label, code) => {
      provider.next = () => {
        throw new ProviderError("no", code);
      };
      await requestGeneration(world.ctx, CO, REQUEST, acmeWork(), runtime);
      await processQueue(world.ctx, runtime);
      expect(await usage(world.ctx, CO, currentPeriod())).toBe(0);
      expect((await rows(world, `SELECT status, error_code FROM ${T("generations")}`))[0]).toEqual({ status: "failed", error_code: code });
    });

    it("refunds when the provider reports a failed job", async () => {
      provider.state = { state: "failed", message: "nope" };
      await requestGeneration(world.ctx, CO, REQUEST, acmeWork(), runtime);
      await processQueue(world.ctx, runtime);
      await processQueue(world.ctx, runtime);
      expect(await usage(world.ctx, CO, currentPeriod())).toBe(0);
    });

    it("refunds once, however often it's asked", async () => {
      provider.state = { state: "failed", message: "nope" };
      await requestGeneration(world.ctx, CO, REQUEST, acmeWork(), runtime);
      await processQueue(world.ctx, runtime);
      await processQueue(world.ctx, runtime);
      await processQueue(world.ctx, runtime);
      expect(await rows(world, `SELECT kind FROM ${T("credit_ledger")} ORDER BY kind`)).toEqual([{ kind: "refund" }, { kind: "reserve" }]);
    });

    it("pauses the company's queue after out of credits, instead of hammering", async () => {
      provider.next = () => {
        throw new ProviderError("empty", "out_of_credits");
      };
      await requestGeneration(world.ctx, CO, { ...REQUEST, batchSize: 3 }, acmeWork(), runtime);
      await processQueue(world.ctx, runtime);
      expect(provider.submits).toHaveLength(1);
      const statuses = (await rows(world, `SELECT status FROM ${T("generations")}`)).map((r) => r.status).sort();
      expect(statuses).toEqual(["failed", "queued", "queued"]);
    });

    it("retries a provider outage without losing the request", async () => {
      let calls = 0;
      provider.next = () => {
        calls += 1;
        if (calls === 1) throw new ProviderError("down", "unavailable");
        return "job-ok";
      };
      await requestGeneration(world.ctx, CO, REQUEST, acmeWork(), runtime);
      await processQueue(world.ctx, runtime);
      expect((await rows(world, `SELECT status FROM ${T("generations")}`))[0].status).toBe("queued");
      await processQueue(world.ctx, runtime);
      expect((await rows(world, `SELECT status FROM ${T("generations")}`))[0].status).toMatch(/submitted|storing|succeeded/);
    });
  });

  describe("no double spend", () => {
    beforeEach(() => setCap(world.ctx, CO, "company", 100, "owner-1"));

    it("never resends a submission that got no answer, and keeps its credits", async () => {
      provider.next = () => {
        throw new ProviderError("timeout", "unknown");
      };
      await requestGeneration(world.ctx, CO, REQUEST, acmeWork(), runtime);
      await processQueue(world.ctx, runtime);
      await processQueue(world.ctx, runtime);
      expect(provider.submits).toHaveLength(1);
      expect((await rows(world, `SELECT status, error_code FROM ${T("generations")}`))[0]).toEqual({ status: "failed", error_code: "unknown_submission" });
      expect(await usage(world.ctx, CO, currentPeriod())).toBe(0.5);
    });

    it("after a restart mid-submission, fails the row, keeps the credits, and doesn't resend", async () => {
      await requestGeneration(world.ctx, CO, REQUEST, acmeWork(), runtime);
      await pg.client.query(`UPDATE ${T("generations")} SET status = 'submitting', updated_at = now() - interval '20 minutes'`);
      await processQueue(world.ctx, runtime);
      expect(provider.submits).toHaveLength(0);
      expect((await rows(world, `SELECT status, error_code FROM ${T("generations")}`))[0]).toEqual({ status: "failed", error_code: "lost_submission" });
      expect(await usage(world.ctx, CO, currentPeriod())).toBe(0.5);
    });

    it("leaves a fresh mid-submission row alone in case the send is still in progress", async () => {
      await requestGeneration(world.ctx, CO, REQUEST, acmeWork(), runtime);
      await pg.client.query(`UPDATE ${T("generations")} SET status = 'submitting', updated_at = now()`);
      await processQueue(world.ctx, runtime);
      expect((await rows(world, `SELECT status FROM ${T("generations")}`))[0].status).toBe("submitting");
    });

    it("restores a reservation lost in a restart before it spends", async () => {
      await requestGeneration(world.ctx, CO, REQUEST, acmeWork(), runtime);
      await pg.client.query(`DELETE FROM ${T("credit_ledger")}`);
      await processQueue(world.ctx, runtime);
      expect(await usage(world.ctx, CO, currentPeriod())).toBe(0.5);
    });

    it("picks a submitted job back up after a restart without resending", async () => {
      provider.state = { state: "pending" };
      await requestGeneration(world.ctx, CO, REQUEST, acmeWork(), runtime);
      await processQueue(world.ctx, runtime);
      resetQueueStateForTests();
      provider.state = { state: "done", urls: ["https://cdn.example.com/out.png"], credits: null };
      await processQueue(world.ctx, runtime);
      await processQueue(world.ctx, runtime);
      expect(provider.submits).toHaveLength(1);
      expect((await rows(world, `SELECT status FROM ${T("generations")}`))[0].status).toBe("succeeded");
    });

    it("repeats storing safely when a restart hits partway through", async () => {
      await requestGeneration(world.ctx, CO, REQUEST, acmeWork(), runtime);
      await processQueue(world.ctx, runtime);
      await processQueue(world.ctx, runtime);
      const [row] = await rows(world, `SELECT id FROM ${T("generations")}`);
      await pg.client.query(`UPDATE ${T("generations")} SET status = 'storing', output_url = 'https://cdn.example.com/out.png', asset_id = NULL`);
      await processQueue(world.ctx, runtime);
      expect(await rows(world, `SELECT id FROM ${T("assets")}`)).toEqual([{ id: row.id }]);
      expect(await rows(world, `SELECT version FROM ${T("asset_versions")}`)).toEqual([{ version: 1 }]);
      expect(await usage(world.ctx, CO, currentPeriod())).toBe(0.5);
    });

    it("keeps the provider's link and retries when saving fails, then gives up with credits spent", async () => {
      const failing = runtimeWith(provider, {
        download: async () => {
          throw new Error("CDN down");
        },
      });
      await requestGeneration(world.ctx, CO, REQUEST, acmeWork(), failing);
      await processQueue(world.ctx, failing);
      for (let i = 0; i < 12; i += 1) await processQueue(world.ctx, failing);
      const [row] = await rows(world, `SELECT status, error_code, output_url FROM ${T("generations")}`);
      expect(row).toEqual({ status: "failed", error_code: "store_failed", output_url: "https://cdn.example.com/out.png" });
      expect(await usage(world.ctx, CO, currentPeriod())).toBe(0.5);
    });

    it("sends at most 4 at a time per company", async () => {
      provider.state = { state: "pending" };
      await setCap(world.ctx, CO, "agent_run", 100, "owner-1");
      await requestGeneration(world.ctx, CO, { ...REQUEST, batchSize: 8 }, acmeWork(), runtime);
      await processQueue(world.ctx, runtime);
      await processQueue(world.ctx, runtime);
      expect(provider.submits).toHaveLength(4);
    });
  });

  describe("done when: an agent generates on a real issue", () => {
    it("lands in the Studio folder, linked to the issue and project, with cost in the ledger, and reports on the issue", async () => {
      await setCap(world.ctx, CO, "company", 100, "owner-1");
      const out = await requestGeneration(world.ctx, CO, { ...REQUEST, name: "Hero" }, acmeWork(), runtime);
      await processQueue(world.ctx, runtime);
      await processQueue(world.ctx, runtime);

      const id = out.generationIds[0]!;
      expect(world.puts).toEqual([`/pib-private/studio/${CO}/company-acme/${id}/v1.png`]);
      const links = await rows(world, `SELECT target_type, target_id FROM ${T("asset_links")} WHERE asset_id = $1 ORDER BY target_type`, [id]);
      expect(links).toEqual([{ target_type: "issue", target_id: "issue-acme" }, { target_type: "project", target_id: "project-acme" }]);
      expect(await usage(world.ctx, CO, currentPeriod(), ACME)).toBe(0.5);

      const asset = assetOut(await getAssetRow(world.ctx, CO, id));
      expect(asset).toMatchObject({ name: "Hero", kind: "image", mime: "image/png", source: "generated", status: "draft", client: { kind: "company", id: "acme", name: "Acme Ltd" }, projectId: "project-acme", generationId: id });

      const provenance = (await rows(world, `SELECT agent_id, run_id, issue_id, model, prompt FROM ${T("generations")} WHERE id = $1`, [id]))[0];
      expect(provenance).toEqual({ agent_id: "agent-1", run_id: "run-1", issue_id: "issue-acme", model: REQUEST.model, prompt: REQUEST.prompt });

      expect(world.comments).toHaveLength(1);
      expect(world.comments[0]).toMatchObject({ issueId: "issue-acme" });
      expect(world.comments[0]!.body).toContain(id);
      expect(world.wakes).toEqual([{ issueId: "issue-acme", idempotencyKey: expect.stringMatching(/^studio-finished:/) }]);
    });

    it("keeps the result and the comment when the wake is refused", async () => {
      await setCap(world.ctx, CO, "company", 100, "owner-1");
      world.refuseWake.on = true;
      const { generationIds } = await requestGeneration(world.ctx, CO, REQUEST, acmeWork(), runtime);
      await processQueue(world.ctx, runtime);
      await processQueue(world.ctx, runtime);
      const saved = await rows(world, `SELECT status FROM ${T("generations")} WHERE id = $1`, [generationIds[0]]);
      expect(saved).toEqual([{ status: "succeeded" }]);
      expect(world.comments).toHaveLength(1);
      expect(world.wakes).toHaveLength(0);
    });

    it("comments once for a batch, when all of it is settled", async () => {
      await setCap(world.ctx, CO, "company", 100, "owner-1");
      await requestGeneration(world.ctx, CO, { ...REQUEST, batchSize: 2 }, acmeWork(), runtime);
      await processQueue(world.ctx, runtime);
      await processQueue(world.ctx, runtime);
      expect(world.comments).toHaveLength(1);
      expect(world.comments[0]!.body).toContain("2 of 2");
      expect(world.wakes).toHaveLength(1);
    });
  });

  describe("reference images (PAR-7986)", () => {
    const GROK = "xai/grok-imagine-image-2.0";
    beforeEach(() => setCap(world.ctx, CO, "company", 100, "owner-1"));

    /** Records what reached the provider, so the test can check the field; real code never keeps bodies. */
    function recordingRuntime() {
      const bodies: Array<{ kind: "estimate" | "submit"; model: string; body: Record<string, unknown> }> = [];
      const inner = new FakeProvider();
      const spy: GenerationProvider = {
        key: inner.key,
        estimate: async (model, body) => (bodies.push({ kind: "estimate", model, body }), 0.5),
        submit: async (model, body) => (bodies.push({ kind: "submit", model, body }), inner.submit(REQUEST.model)),
        status: () => inner.status(),
      };
      return { bodies, runtime: runtimeWith(spy) };
    }

    async function libraryImage(issueId: string, projectId: string) {
      const out = await requestGeneration(world.ctx, CO, REQUEST, work(issueId, projectId), runtime);
      await processQueue(world.ctx, runtime);
      await processQueue(world.ctx, runtime);
      resetQueueStateForTests();
      return out.generationIds[0]!;
    }

    it("stores only asset ids and sends short-lived signed links in the model's field", async () => {
      const ref = await libraryImage("issue-acme", "project-acme");
      const { bodies, runtime: rec } = recordingRuntime();
      const out = await requestGeneration(world.ctx, CO, { model: GROK, prompt: "same chair, blue", referenceAssetIds: [ref] }, acmeWork(), rec);
      await processQueue(world.ctx, rec);

      const sent = bodies.find((b) => b.kind === "submit")!;
      const urls = sent.body.image_urls as string[];
      expect(urls).toHaveLength(1);
      expect(urls[0]).toMatch(/X-Amz-Expires=1800/);
      expect(urls[0]).toContain(`studio/${CO}/company-acme/${ref}/`);

      const stored = (await rows(world, `SELECT params, reference_asset_ids FROM ${T("generations")} WHERE id = $1`, [out.generationIds[0]]))[0]!;
      expect(stored.reference_asset_ids).toEqual([ref]);
      const seen = JSON.stringify([stored, out, await generationStatus(world.ctx, CO, { generationId: out.generationIds[0]! }, "project-acme"), world.comments]);
      expect(seen).not.toMatch(/X-Amz|r2\.cloudflarestorage|cdn\.example\.com/);
    });

    it("refuses a reference from another client or another company, before any cost", async () => {
      const acme = await libraryImage("issue-acme", "project-acme");
      const { bodies, runtime: rec } = recordingRuntime();
      await expect(requestGeneration(world.ctx, CO, { model: GROK, prompt: "x", referenceAssetIds: [acme] }, work("issue-globex", "project-globex"), rec)).rejects.toMatchObject({ code: "wrong_client" });
      await expect(requestGeneration(world.ctx, OTHER_CO, { model: GROK, prompt: "x", referenceAssetIds: [acme] }, AGENT, rec)).rejects.toMatchObject({ code: "unknown_asset" });
      expect(bodies).toHaveLength(0);
    });

    it("refuses references for a model that takes none, and a missing one for a model that needs one", async () => {
      const ref = await libraryImage("issue-acme", "project-acme");
      const { runtime: rec } = recordingRuntime();
      await expect(requestGeneration(world.ctx, CO, { ...REQUEST, referenceAssetIds: [ref] }, acmeWork(), rec)).rejects.toMatchObject({ code: "bad_request" });
      await expect(requestGeneration(world.ctx, CO, { model: "kling-video/v3.0-turbo/image-to-video", prompt: "x" }, acmeWork(), rec)).rejects.toMatchObject({ code: "bad_request" });
      await expect(requestGeneration(world.ctx, CO, { model: GROK, prompt: "x", referenceAssetIds: ["../etc"] }, acmeWork(), rec)).rejects.toMatchObject({ code: "bad_request" });
    });

    it("fails with a refund, without sending, when a reference is gone by send time", async () => {
      const ref = await libraryImage("issue-acme", "project-acme");
      const { bodies, runtime: rec } = recordingRuntime();
      const out = await requestGeneration(world.ctx, CO, { model: GROK, prompt: "x", referenceAssetIds: [ref] }, acmeWork(), rec);
      await pg.client.query(`UPDATE ${T("assets")} SET client_ref = 'globex' WHERE id = $1`, [ref]);
      await processQueue(world.ctx, rec);
      expect(bodies.filter((b) => b.kind === "submit")).toHaveLength(0);
      const row = (await rows(world, `SELECT status, error_code FROM ${T("generations")} WHERE id = $1`, [out.generationIds[0]]))[0];
      expect(row).toEqual({ status: "failed", error_code: "reference_unavailable" });
    });

    describe("audio references and lip-sync models (PAR-8435)", () => {
      const WAN3 = "alibaba/wan-3.0-prime/reference-to-video";
      const SD_REF = "bytedance/seedance-2.5/reference-to-video";
      const SD_I2V = "bytedance/seedance-2.5/image-to-video";
      const GROK15 = "xai/grok-imagine-video/v1.5/reference-to-video";
      const WAN27 = "wan/v2.7/image-to-video";
      const PERSON = { userId: "user-1", issueId: "issue-acme", projectId: "project-acme" };

      /** A library asset of kind audio (the kind is what Studio checks; T2a stores real MP3s as audio). */
      async function libraryAudio() {
        const id = await libraryImage("issue-acme", "project-acme");
        await pg.client.query(`UPDATE ${T("assets")} SET kind = 'audio' WHERE id = $1`, [id]);
        return id;
      }

      /** A sent body as JSON (key order kept), each signed link swapped for the asset id it points at. */
      function shape(body: Record<string, unknown>, ids: string[]): string {
        return JSON.stringify(body, (_key, v: unknown) => (typeof v === "string" && v.includes("X-Amz-") ? `<${ids.find((id) => v.includes(`/${id}/`)) ?? "?"}>` : v));
      }

      async function submitted(params: Record<string, unknown>) {
        const { bodies, runtime: rec } = recordingRuntime();
        const out = await requestGeneration(world.ctx, CO, params, PERSON, rec);
        await processQueue(world.ctx, rec);
        return { out, body: bodies.find((b) => b.kind === "submit")!.body, bodies };
      }

      it.each([
        [WAN3, "480p", (i: string, a: string) => `{"prompt":"She says hello","duration":5,"resolution":"480p","image_urls":["<${i}>"],"audio_urls":["<${a}>"]}`],
        [SD_REF, "480p", (i: string, a: string) => `{"prompt":"She says hello","duration":5,"resolution":"480p","image_urls":["<${i}>"],"audio_urls":["<${a}>"]}`],
        [GROK15, "480p", (i: string, a: string) => `{"prompt":"She says hello","duration":5,"resolution":"480p","image_urls":["<${i}>"],"audio_url":"<${a}>"}`],
        [WAN27, "720p", (i: string, a: string) => `{"prompt":"She says hello","duration":5,"resolution":"720p","image_url":"<${i}>","audio_url":"<${a}>"}`],
      ] as const)("%s sends the portrait and our audio in its own fields and shapes", async (model, resolution, expected) => {
        const image = await libraryImage("issue-acme", "project-acme");
        const audio = await libraryAudio();
        const { out, body } = await submitted({ model, prompt: "She says hello", params: { duration: 5, resolution }, referenceAssetIds: [image], audioAssetIds: [audio] });
        expect(shape(body, [image, audio])).toBe(expected(image, audio));
        const stored = (await rows(world, `SELECT params, reference_asset_ids FROM ${T("generations")} WHERE id = $1`, [out.generationIds[0]]))[0]!;
        expect(stored.reference_asset_ids).toEqual([image, audio]);
        expect(JSON.stringify(stored.params)).not.toMatch(/X-Amz|audio_url|image_url/);
      });

      it("prices Wan 3.0 Prime per second from the table", async () => {
        const image = await libraryImage("issue-acme", "project-acme");
        const audio = await libraryAudio();
        const { out } = await submitted({ model: WAN3, prompt: "hi", params: { duration: 5, resolution: "480p" }, referenceAssetIds: [image], audioAssetIds: [audio] });
        expect(out.creditsReserved).toBe(5.44);
      });

      it("refuses audio as an image, an image as audio, and a wrong count per field, before any cost", async () => {
        const image = await libraryImage("issue-acme", "project-acme");
        const audio = await libraryAudio();
        const audio2 = await libraryAudio();
        const { bodies, runtime: rec } = recordingRuntime();
        const ask = (model: string, referenceAssetIds: string[], audioAssetIds: string[]) =>
          expect(requestGeneration(world.ctx, CO, { model, prompt: "x", params: model === REQUEST.model ? {} : { duration: 5, resolution: "480p" }, referenceAssetIds, audioAssetIds }, PERSON, rec)).rejects.toMatchObject({ code: "bad_request" });
        await ask(WAN3, [audio], [audio2]);
        await ask(WAN3, [image], [image]);
        await ask(WAN3, [image], []);
        await ask(WAN27, [image], [audio, audio2]);
        await ask(GROK15, [image], [audio, audio2]);
        await ask(SD_I2V, [image], [audio]);
        await ask(REQUEST.model, [], [audio]);
        expect(bodies).toHaveLength(0);
        expect(await rows(world, `SELECT id FROM ${T("generations")} WHERE model <> $1`, [REQUEST.model])).toHaveLength(0);
      });

      it.each([
        ["xai/grok-imagine-image-2.0", (i: string) => `{"prompt":"x","image_urls":["<${i}>"]}`],
        ["kling-video/v3.0-turbo/image-to-video", (i: string) => `{"prompt":"x","duration":5,"image_url":"<${i}>"}`],
        [GROK15, (i: string) => `{"prompt":"x","duration":5,"image_urls":["<${i}>"]}`],
      ] as const)("keeps the image-only body of %s byte-identical at estimate, request and submit", async (model, expected) => {
        const image = await libraryImage("issue-acme", "project-acme");
        const { bodies, runtime: rec } = recordingRuntime();
        await estimateGeneration(world.ctx, CO, { model, prompt: "x", referenceAssetIds: [image] }, PERSON, rec);
        await requestGeneration(world.ctx, CO, { model, prompt: "x", referenceAssetIds: [image] }, PERSON, rec);
        await processQueue(world.ctx, rec);
        expect(bodies.map((b) => `${b.kind} ${shape(b.body, [image])}`)).toEqual(["estimate", "estimate", "submit"].map((kind) => `${kind} ${expected(image)}`));
      });

      it("refuses a lip-sync job over 30 credits before any row or reserve; audio puts Grok under the same ceiling", async () => {
        const image = await libraryImage("issue-acme", "project-acme");
        const audio = await libraryAudio();
        const before = (await rows(world, `SELECT COUNT(*)::int AS n FROM ${T("credit_ledger")}`))[0].n;
        await expect(requestGeneration(world.ctx, CO, { model: SD_I2V, prompt: "x", params: { duration: 10, resolution: "480p" }, referenceAssetIds: [image] }, PERSON, runtime)).rejects.toMatchObject({ code: "over_job_ceiling" });
        provider.price = 31;
        const grok = { model: GROK15, prompt: "x", params: { duration: 5, resolution: "480p" }, referenceAssetIds: [image] };
        await expect(requestGeneration(world.ctx, CO, { ...grok, audioAssetIds: [audio] }, PERSON, runtime)).rejects.toMatchObject({ code: "over_job_ceiling" });
        await expect(estimateGeneration(world.ctx, CO, { ...grok, audioAssetIds: [audio] }, PERSON, runtime)).rejects.toMatchObject({ code: "over_job_ceiling" });
        expect(await rows(world, `SELECT id FROM ${T("generations")} WHERE model <> $1`, [REQUEST.model])).toHaveLength(0);
        expect((await rows(world, `SELECT COUNT(*)::int AS n FROM ${T("credit_ledger")}`))[0].n).toBe(before);
        await expect(requestGeneration(world.ctx, CO, grok, PERSON, runtime)).resolves.toMatchObject({ creditsReserved: 31 });
      });

      it("never sends a queued audio row priced over 30, and refunds it", async () => {
        const image = await libraryImage("issue-acme", "project-acme");
        const audio = await libraryAudio();
        const { bodies, runtime: rec } = recordingRuntime();
        const out = await requestGeneration(world.ctx, CO, { model: GROK15, prompt: "x", referenceAssetIds: [image], audioAssetIds: [audio] }, PERSON, rec);
        await pg.client.query(`UPDATE ${T("generations")} SET estimated_credits = 31 WHERE id = $1`, [out.generationIds[0]]);
        await processQueue(world.ctx, rec);
        expect(bodies.filter((b) => b.kind === "submit")).toHaveLength(0);
        expect((await rows(world, `SELECT status, error_code FROM ${T("generations")} WHERE id = $1`, [out.generationIds[0]]))[0]).toEqual({ status: "failed", error_code: "over_job_ceiling" });
      });

      it("native dialogue sends generate_audio true and the line in the prompt, with no audio field", async () => {
        const image = await libraryImage("issue-acme", "project-acme");
        const line = 'She smiles and says: "Welcome to Acme."';
        const { out, body } = await submitted({ model: SD_I2V, prompt: line, params: { duration: 5, resolution: "480p" }, referenceAssetIds: [image] });
        expect(shape(body, [image])).toBe(`{"prompt":${JSON.stringify(line)},"duration":5,"resolution":"480p","generate_audio":true,"image_url":"<${image}>"}`);
        expect(out.creditsReserved).toBe(16.448);
        const { runtime: rec } = recordingRuntime();
        await expect(requestGeneration(world.ctx, CO, { model: SD_I2V, prompt: line, params: { duration: 5, resolution: "480p", generate_audio: false }, referenceAssetIds: [image] }, PERSON, rec)).rejects.toMatchObject({ code: "bad_request" });
      });

      it("signs links at submit, not at insert: a job queued 45 min still sends a fresh 30 min link", async () => {
        const image = await libraryImage("issue-acme", "project-acme");
        const audio = await libraryAudio();
        const { bodies, runtime: rec } = recordingRuntime();
        const insertedAt = Date.now();
        await requestGeneration(world.ctx, CO, { model: WAN3, prompt: "hi", params: { duration: 5, resolution: "480p" }, referenceAssetIds: [image], audioAssetIds: [audio] }, PERSON, rec);
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          vi.setSystemTime(insertedAt + 45 * 60_000);
          await processQueue(world.ctx, rec);
        } finally {
          vi.useRealTimers();
        }
        const link = (bodies.find((b) => b.kind === "submit")!.body.audio_urls as string[])[0]!;
        expect(link).toMatch(/X-Amz-Expires=1800/);
        const [, d] = /X-Amz-Date=(\d{8}T\d{6}Z)/.exec(link)!;
        const signedAt = Date.parse(`${d!.slice(0, 4)}-${d!.slice(4, 6)}-${d!.slice(6, 8)}T${d!.slice(9, 11)}:${d!.slice(11, 13)}:${d!.slice(13, 15)}Z`);
        expect(signedAt - insertedAt).toBeGreaterThanOrEqual(45 * 60_000 - 1_000);
      });
    });
  });

  describe("isolation", () => {
    beforeEach(() => setCap(world.ctx, CO, "company", 100, "owner-1"));

    async function makeAsset(issueId: string, projectId: string) {
      const out = await requestGeneration(world.ctx, CO, REQUEST, work(issueId, projectId), runtime);
      await processQueue(world.ctx, runtime);
      await processQueue(world.ctx, runtime);
      resetQueueStateForTests();
      return out.generationIds[0]!;
    }

    it("files work on a client's issue under that client without being told", async () => {
      const out = await requestGeneration(world.ctx, CO, REQUEST, acmeWork(), runtime);
      expect(out.client).toEqual({ kind: "company", id: "acme" });
    });

    it("files work with no client project as own work", async () => {
      const out = await requestGeneration(world.ctx, CO, REQUEST, work("issue-own", "project-own"), runtime);
      expect(out.client).toBeNull();
    });

    it("refuses generating for another client, or as own work, from a client's issue", async () => {
      await expect(requestGeneration(world.ctx, CO, { ...REQUEST, client: "company:globex" }, acmeWork(), runtime)).rejects.toMatchObject({ code: "wrong_client" });
      await expect(requestGeneration(world.ctx, CO, { ...REQUEST, client: "own" }, acmeWork(), runtime)).rejects.toMatchObject({ code: "wrong_client" });
    });

    it("refuses a client that doesn't exist and a malformed one", async () => {
      await expect(requestGeneration(world.ctx, CO, { ...REQUEST, client: "company:nobody" }, work("issue-own", "project-own"), runtime)).rejects.toMatchObject({ code: "unknown_client" });
      await expect(requestGeneration(world.ctx, CO, { ...REQUEST, client: "not a client" }, work("issue-own", "project-own"), runtime)).rejects.toMatchObject({ code: "bad_client" });
    });

    it("doesn't list one client's assets under another or under own work", async () => {
      const acme = await makeAsset("issue-acme", "project-acme");
      const globex = await makeAsset("issue-globex", "project-globex");
      expect((await listAssets(world.ctx, CO, { scope: ACME })).map((a) => a.id)).toEqual([acme]);
      expect((await listAssets(world.ctx, CO, { scope: GLOBEX })).map((a) => a.id)).toEqual([globex]);
      expect(await listAssets(world.ctx, CO, { scope: null })).toEqual([]);
      expect(await listAssets(world.ctx, OTHER_CO, {})).toEqual([]);
    });

    it("refuses opening or linking another client's asset from a client's work", async () => {
      const acme = await makeAsset("issue-acme", "project-acme");
      await expect(assetFileForAgent(world.ctx, CO, acme, "project-globex")).rejects.toMatchObject({ code: "wrong_client" });
      await expect(linkAsset(world.ctx, CO, { assetId: acme, targetType: "campaign", targetId: "c1" }, "project-globex")).rejects.toMatchObject({ code: "wrong_client" });
      await expect(linkAsset(world.ctx, CO, { assetId: acme, targetType: "issue", targetId: "issue-globex" }, "project-acme")).rejects.toMatchObject({ code: "wrong_client" });
    });

    it("can't reach another company's asset at all", async () => {
      const acme = await makeAsset("issue-acme", "project-acme");
      await expect(assetFileForAgent(world.ctx, OTHER_CO, acme, null)).rejects.toMatchObject({ code: "unknown_asset" });
      await expect(linkAsset(world.ctx, OTHER_CO, { assetId: acme, targetType: "campaign", targetId: "c1" }, null)).rejects.toMatchObject({ code: "unknown_asset" });
      await expect(generationStatus(world.ctx, OTHER_CO, { generationId: acme }, null)).rejects.toMatchObject({ code: "unknown_generation" });
    });

    it("refuses a generation status from another client's work", async () => {
      const acme = await makeAsset("issue-acme", "project-acme");
      await expect(generationStatus(world.ctx, CO, { generationId: acme }, "project-globex")).rejects.toMatchObject({ code: "wrong_client" });
    });

    it("gives agents a private local file, and no signed link or storage key anywhere", async () => {
      const id = await makeAsset("issue-acme", "project-acme");
      const file = await assetFileForAgent(world.ctx, CO, id, "project-acme");
      expect(file.path.startsWith(workdir)).toBe(true);
      expect(statSync(file.path).mode & 0o777).toBe(0o600);
      const seen = JSON.stringify([
        file,
        await listAssets(world.ctx, CO, { scope: ACME }),
        await generationStatus(world.ctx, CO, { generationId: id }, "project-acme"),
        world.comments,
      ]);
      expect(seen).not.toMatch(/X-Amz|r2\.cloudflarestorage|studio\/11111111|cdn\.example\.com/);
    });

    it("imports an agent's attachment under the issue's client, once", async () => {
      const first = await importFromAttachment(world.ctx, CO, { issueId: "issue-acme", attachmentId: "att-1" }, { agentId: "agent-1" });
      const second = await importFromAttachment(world.ctx, CO, { issueId: "issue-acme", attachmentId: "att-1" }, { agentId: "agent-1" });
      expect(first).toMatchObject({ reused: false, client: { id: "acme" }, name: "made.png", source: "attachment" });
      expect(second).toMatchObject({ reused: true, id: first.id });
      await expect(importFromAttachment(world.ctx, CO, { issueId: "issue-acme", attachmentId: "att-1", client: "company:globex" }, {})).rejects.toMatchObject({ code: "wrong_client" });
      await expect(importFromAttachment(world.ctx, CO, { issueId: "issue-acme", attachmentId: "missing" }, {})).rejects.toMatchObject({ code: "unknown_attachment" });
    });
  });
});
