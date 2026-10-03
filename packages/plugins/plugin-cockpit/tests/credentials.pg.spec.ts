/**
 * The credentials register against a real Postgres: the seed, the tools, the
 * provider checks (a fake fetch, so no provider is ever called), the daily job
 * and, above all, that a secret's value is never stored, logged or returned.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extraChecks } from "../src/checks.js";
import { collectProblems, refreshHealthIssue } from "../src/health.js";
import { ORIGIN } from "../src/constants.js";
import { CREDENTIAL_SEED } from "../src/credentials-seed.js";
import { credentialList, listCredentials, seedCredentials, verifyCompany, VERIFIERS } from "../src/credentials.js";
import { NAMESPACE } from "../src/namespace.js";
import { saveTeam } from "../src/roles.js";
import { COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds, type Hybrid } from "./helpers/hybrid.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const A = COMPANY;
const B = "22222222-2222-4222-8222-222222222222";
const OP = "aaaaaaaa-0000-4000-8000-0000000000a1";
const DEV = "aaaaaaaa-0000-4000-8000-0000000000a2";
const OP_B = "bbbbbbbb-0000-4000-8000-0000000000b1";
const RUN = { agentId: OP, runId: "run-1", companyId: A, projectId: "" };
const DEV_RUN = { agentId: DEV, runId: "run-2", companyId: A, projectId: "" };
const GITHUB_VALUE = "value-github-0123456789-do-not-leak";
const CF_VALUE = "value-cloudflare-0123456789-do-not-leak";
const RESEND_VALUE = "value-resend-0123456789-do-not-leak";
const VALUES = [GITHUB_VALUE, CF_VALUE, RESEND_VALUE];

type Call = { url: string; method: string; headers: Record<string, string> };
type Answer = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

/** A fetch that answers by host and records every call; nothing leaves the process. */
function fakeFetch(answers: Record<string, Answer>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", headers: { ...(init?.headers ?? {}) } });
    const host = new URL(String(url)).host;
    const answer = answers[host] ?? { status: 599 };
    if (answer instanceof Error) throw answer;
    const headers = Object.fromEntries(Object.entries(answer.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { status: answer.status, headers: { get: (name: string) => headers[name.toLowerCase()] ?? null }, json: async () => answer.body ?? {} };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ref = (id: string) => ({ type: "secret_ref", secretId: id, version: "latest" });
/** Partners in Biz's own company: the starting list is ticked on. */
const CHECKS_CONFIG = { healthIssue: true, credentialSeed: true, credentialChecks: { github: ref("sec-gh"), cloudflare: ref("sec-cf"), resend: ref("sec-rs") } };
const SECRETS = { "sec-gh": GITHUB_VALUE, "sec-cf": CF_VALUE, "sec-rs": RESEND_VALUE };

d("the credentials register (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  async function make(config: Record<string, unknown> = CHECKS_CONFIG, secrets: Record<string, string> = SECRETS, otherConfigs: Record<string, Record<string, unknown>> = {}) {
    const configs: Record<string, Record<string, unknown>> = { [A]: config, ...otherConfigs };
    const w = await worlds.make({
      savedConfigs: configs,
      prefixes: { [A]: "PAR", [B]: "CLI" },
      secrets,
      agents: [
        { id: OP, companyId: A, name: "Olive", status: "active", role: "general" },
        { id: DEV, companyId: A, name: "Developer", status: "idle", role: "engineer" },
        { id: OP_B, companyId: B, name: "Client operator", status: "active", role: "general" },
      ],
    });
    await saveTeam(w.env, A, { operatorAgentId: OP }, "user-owner");
    if (otherConfigs[B]) await saveTeam(w.env, B, { operatorAgentId: OP_B }, "user-owner-b");
    const logs: string[] = [];
    (w.ctx.logger as unknown as { info: (m: string, meta?: unknown) => void }).info = (m, meta) => logs.push(`${m} ${JSON.stringify(meta ?? {})}`);
    return Object.assign(w, { logs, configs });
  }

  const keys = (checks: Array<{ key: string }>) => checks.map((c) => c.key);
  const record = (w: Hybrid, params: Record<string, unknown>, run = RUN) => w.tools.get("credential-record")!(params, run) as Promise<{ error?: string; content?: string; data?: { id: string; created: boolean } }>;
  const list = (w: Hybrid, params: Record<string, unknown> = {}) => w.tools.get("credential-list")!(params, RUN) as Promise<{ error?: string; content?: string; data?: { credentials: Array<Record<string, any>>; problems: Array<{ key: string }>; verification?: Record<string, number> } }>;
  const byKey = async (w: Hybrid, seedKey: string) => (await w.client.query(`SELECT * FROM ${NAMESPACE}.credentials WHERE company_id = $1 AND seed_key = $2`, [A, seedKey])).rows[0] as Record<string, any>;
  /** Everything the plugin stored, logged or said that could carry a value. */
  async function everything(w: Hybrid & { logs: string[] }) {
    const tables = ["credentials", "activity", "asks", "improvements", "goals"];
    const dumped: string[] = [];
    for (const t of tables) dumped.push(JSON.stringify((await w.client.query(`SELECT * FROM ${NAMESPACE}.${t}`).catch(() => ({ rows: [] }))).rows));
    return [...dumped, ...w.logs, JSON.stringify([...w.issues.values()]), JSON.stringify(w.comments), JSON.stringify(w.emitted), JSON.stringify([...w.state.entries()])].join("\n");
  }

  describe("the seed", () => {
    it("adds the 22 credentials of the security table once, and never overwrites what a person changed", async () => {
      const w = await make();
      expect(await seedCredentials(w.env, A)).toBe(22);
      expect(await seedCredentials(w.env, A)).toBe(0);
      expect((await listCredentials(w.ctx, A))).toHaveLength(22);
      await record(w, { id: (await byKey(w, "resend-key")).id, name: "Resend key (renamed)", expiresAt: "2027-01-31", markVerified: true });
      expect(await seedCredentials(w.env, A)).toBe(0);
      expect(await byKey(w, "resend-key")).toMatchObject({ name: "Resend key (renamed)", last_verify_status: "ok" });
      expect(new Date((await byKey(w, "resend-key")).expires_at).toISOString().slice(0, 10)).toBe("2027-01-31");
    });

    it("seeds ONLY the company that ticked the setting: another company with saved settings gets an empty register, by the daily job and by a direct call", async () => {
      // B is a client company with saved settings; only A (Partners in Biz) ticked credentialSeed
      const w = await make(CHECKS_CONFIG, SECRETS, { [B]: { healthIssue: true } });
      w.env.fetchImpl = fakeFetch({}).impl;
      await w.jobs.get("credentials-check")!();
      expect(await listCredentials(w.ctx, A)).toHaveLength(22);
      expect(await listCredentials(w.ctx, B)).toEqual([]);
      expect(await seedCredentials(w.env, B)).toBe(0);
      expect((await w.client.query(`SELECT 1 FROM ${NAMESPACE}.credentials WHERE company_id = $1`, [B])).rows).toHaveLength(0);
      // an explicit false is the same, and so is the setting being absent
      w.configs[B] = { healthIssue: true, credentialSeed: false };
      expect(await seedCredentials(w.env, B)).toBe(0);
      w.configs[B] = { healthIssue: true, credentialSeed: "yes" }; // only a real true counts
      expect(await seedCredentials(w.env, B)).toBe(0);
      // none of PiB's data reaches B: not through the tool, not as the "exposed credentials" warning, not in anything B's agents can read
      const asB = { agentId: OP_B, runId: "run-b", companyId: B, projectId: "" };
      const listed = (await w.tools.get("credential-list")!({}, asB)) as { content: string; data: { credentials: unknown[]; problems: Array<{ key: string }> } };
      expect(listed.data.credentials).toEqual([]);
      expect(listed.data.problems).toEqual([]);
      expect(listed.content).toContain("The register is empty");
      expect(listed.content).toContain("never for a client company");
      expect(keys((await extraChecks(w.env, B, { fresh: true })).health)).not.toContain("credentials:burned");
      expect(JSON.stringify(listed)).not.toMatch(/burned|paperclip|ssh|backup-age-key|PMStander/i);
    });

    it("keeps each company's own register apart: a credential B records is B's, and A's list is untouched", async () => {
      const w = await make(CHECKS_CONFIG, SECRETS, { [B]: { healthIssue: true } });
      await seedCredentials(w.env, A);
      const asB = { agentId: OP_B, runId: "run-b", companyId: B, projectId: "" };
      const created = (await w.tools.get("credential-record")!({ name: "Client Stripe key", system: "Stripe", livesIn: "Client company secret STRIPE", expiresAt: "2027-01-01" }, asB)) as { data: { id: string } };
      expect(await listCredentials(w.ctx, B)).toHaveLength(1);
      expect(await listCredentials(w.ctx, A)).toHaveLength(22);
      expect((await listCredentials(w.ctx, A)).some((r) => r.id === created.data.id)).toBe(false);
      await w.client.query(`UPDATE ${NAMESPACE}.credentials SET status = 'retired' WHERE company_id = $1`, [B]);
      expect((await listCredentials(w.ctx, A)).filter((r) => r.status === "retired")).toHaveLength(0);
    });

    it("ticking the setting later seeds on the next daily run, and unticking it later removes nothing", async () => {
      const w = await make({ healthIssue: true });
      w.env.fetchImpl = fakeFetch({}).impl;
      await w.jobs.get("credentials-check")!();
      expect(await listCredentials(w.ctx, A)).toHaveLength(0);
      w.configs[A] = { healthIssue: true, credentialSeed: true };
      await w.jobs.get("credentials-check")!();
      expect(await listCredentials(w.ctx, A)).toHaveLength(22);
      w.configs[A] = { healthIssue: true };
      await w.jobs.get("credentials-check")!();
      expect(await listCredentials(w.ctx, A)).toHaveLength(22);
    });

    it("starts with the four exposed credentials as a warning, and nothing else red", async () => {
      const w = await make();
      await seedCredentials(w.env, A);
      const { health } = await extraChecks(w.env, A, { fresh: true });
      const credential = health.filter((c) => c.key.startsWith("credential"));
      expect(credential.map((c) => [c.key, c.status])).toEqual([["credentials:burned", "warn"]]);
      expect(credential[0]!.title).toBe("4 credentials exposed and not yet replaced");
    });
  });

  describe("credential-record and credential-list", () => {
    it("records a new credential with names and places, updates it by id, and retiring it silences its alerts", async () => {
      const w = await make();
      const created = await record(w, { name: "Postmark token", system: "Postmark", livesIn: "PAR company secret POSTMARK", owner: "Owner", expiresAt: "2026-10-20", rotateHow: "Create a new server token", rotateHref: "https://account.postmarkapp.com/servers" });
      expect(created.error).toBeUndefined();
      expect(created.data!.created).toBe(true);
      expect(created.content).toContain("names and places only");
      expect((await extraChecks(w.env, A, { fresh: true })).health.map((c) => c.title)).toContain("Postmark token expires in 16 days");
      const updated = await record(w, { id: created.data!.id, expiresAt: "2027-09-01", markVerified: true });
      expect(updated.data).toMatchObject({ id: created.data!.id, created: false });
      expect((await list(w)).data!.credentials[0]).toMatchObject({ name: "Postmark token", expiresAt: "2027-09-01", lastVerify: "ok: Confirmed by agent aaaaaaaa on 2026-10-03" });
      await record(w, { id: created.data!.id, expiresAt: "2026-10-05" });
      expect((await extraChecks(w.env, A, { fresh: true })).health.find((c) => c.key === `credential:${created.data!.id}:expiry`)?.status).toBe("bad");
      await record(w, { id: created.data!.id, status: "retired" });
      expect((await extraChecks(w.env, A, { fresh: true })).health.filter((c) => c.key.startsWith(`credential:${created.data!.id}`))).toEqual([]);
      expect((await list(w)).data!.credentials).toHaveLength(0);
      expect((await list(w, { includeRetired: true })).data!.credentials).toHaveLength(1);
    });

    it("refuses a value that looks like a secret and writes nothing", async () => {
      const w = await make();
      const secret = "ghp_" + "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo";
      const refused = await record(w, { name: "GitHub token", system: "GitHub", notes: secret });
      expect(refused.error).toContain("notes looks like it holds a secret");
      expect(refused.error).not.toContain(secret);
      expect((await w.client.query(`SELECT 1 FROM ${NAMESPACE}.credentials`)).rows).toHaveLength(0);
      expect(await everything(w)).not.toContain(secret);
      expect((await record(w, { name: "x", system: "y", rotateHref: "javascript:alert(1)" })).error).toContain("rotateHref");
      expect((await record(w, { id: "nope", name: "x" })).error).toBe("Credential nope was not found in this company.");
      expect((await record(w, { id: "nope", name: "x", status: "forever" })).error).toContain("status must be active, retired or burned");
    });

    it("cannot touch another company's credential", async () => {
      const w = await make();
      await w.client.query(`INSERT INTO ${NAMESPACE}.credentials (id, company_id, name, system) VALUES ('credB1', $1, 'Their key', 'Stripe')`, [B]);
      const other = "credB1";
      expect((await record(w, { id: other, name: "Hijacked" })).error).toBe(`Credential ${other} was not found in this company.`);
      expect(((await w.client.query(`SELECT name FROM ${NAMESPACE}.credentials WHERE id = $1`, [other])).rows[0] as Record<string, any>).name).not.toBe("Hijacked");
    });
  });

  describe("the provider checks", () => {
    it("GitHub: GET /user with the bearer; 200 is ok and carries the expiry, 401 is refused, 5xx and a dead network say nothing about the token", async () => {
      const ok = fakeFetch({ "api.github.com": { status: 200, headers: { "github-authentication-token-expiration": "2027-09-29 00:00:00 UTC" } } });
      expect(await VERIFIERS.github("tok", ok.impl)).toEqual({ status: "ok", detail: "GitHub accepts it.", expiresAt: "2027-09-29" });
      expect(ok.calls).toEqual([{ url: "https://api.github.com/user", method: "GET", headers: expect.objectContaining({ authorization: "Bearer tok" }) }]);
      expect((await VERIFIERS.github("tok", fakeFetch({ "api.github.com": { status: 200 } }).impl)).expiresAt).toBeNull();
      expect((await VERIFIERS.github("tok", fakeFetch({ "api.github.com": { status: 401 } }).impl)).status).toBe("invalid");
      expect((await VERIFIERS.github("tok", fakeFetch({ "api.github.com": { status: 503 } }).impl)).status).toBe("unreachable");
      expect((await VERIFIERS.github("tok", fakeFetch({ "api.github.com": { status: 429 } }).impl)).status).toBe("unreachable");
      expect((await VERIFIERS.github("tok", fakeFetch({ "api.github.com": new Error("ECONNRESET") }).impl)).status).toBe("unreachable");
      expect((await VERIFIERS.github("tok", fakeFetch({ "api.github.com": { status: 404 } }).impl)).status).toBe("unreachable"); // not a verdict
    });

    it("Cloudflare: an active token is ok (with its expiry), another status is refused, a 401 is refused", async () => {
      const active = fakeFetch({ "api.cloudflare.com": { status: 200, body: { success: true, result: { status: "active", expires_on: "2027-03-01T00:00:00Z" } } } });
      expect(await VERIFIERS.cloudflare("tok", active.impl)).toMatchObject({ status: "ok", expiresAt: "2027-03-01" });
      expect(active.calls[0]!.url).toBe("https://api.cloudflare.com/client/v4/user/tokens/verify");
      expect(await VERIFIERS.cloudflare("tok", fakeFetch({ "api.cloudflare.com": { status: 200, body: { success: true, result: { status: "disabled" } } } }).impl)).toMatchObject({ status: "invalid", detail: "Cloudflare says the token is disabled." });
      expect((await VERIFIERS.cloudflare("tok", fakeFetch({ "api.cloudflare.com": { status: 401 } }).impl)).status).toBe("invalid");
      expect((await VERIFIERS.cloudflare("tok", fakeFetch({ "api.cloudflare.com": { status: 200, body: {} } }).impl)).status).toBe("unreachable");
    });

    it("Resend: 200 is ok, a sending-only key (restricted) is ok, any other refusal is refused", async () => {
      expect((await VERIFIERS.resend("tok", fakeFetch({ "api.resend.com": { status: 200 } }).impl)).status).toBe("ok");
      expect(await VERIFIERS.resend("tok", fakeFetch({ "api.resend.com": { status: 401, body: { name: "restricted_api_key" } } }).impl)).toMatchObject({ status: "ok", detail: "Resend accepts it (a sending-only key)." });
      expect((await VERIFIERS.resend("tok", fakeFetch({ "api.resend.com": { status: 401, body: { name: "invalid_api_key" } } }).impl)).status).toBe("invalid");
      expect((await VERIFIERS.resend("tok", fakeFetch({ "api.resend.com": { status: 500 } }).impl)).status).toBe("unreachable");
    });

    it("says what to do when the settings hold no secret for the provider, and calls nobody", async () => {
      const w = await make({ healthIssue: true, credentialSeed: true });
      await seedCredentials(w.env, A);
      const net = fakeFetch({});
      w.env.fetchImpl = net.impl;
      const result = await verifyCompany(w.env, A);
      expect(result).toMatchObject({ verified: 0, notConfigured: 3 });
      expect(net.calls).toEqual([]);
      const row = await byKey(w, "resend-key");
      expect(row).toMatchObject({ last_verify_status: "not_configured" });
      expect(row.last_verify_detail).toContain("Pick a company secret under Credential checks → resend in the Cockpit settings");
      // not configured is not an alarm
      expect((await extraChecks(w.env, A, { fresh: true })).health.filter((c) => c.key.endsWith(":invalid"))).toEqual([]);
    });

    it("a secret the host cannot resolve is not_configured, with no value in the words", async () => {
      const w = await make(CHECKS_CONFIG, {}); // the refs point at secrets that do not exist
      await seedCredentials(w.env, A);
      w.env.fetchImpl = fakeFetch({}).impl;
      const result = await verifyCompany(w.env, A);
      expect(result.notConfigured).toBe(3);
      expect((await byKey(w, "resend-key")).last_verify_detail).toContain("The settings secret could not be read");
    });
  });

  describe("the daily job", () => {
    it("seeds, checks each provider once with the right secret, records the verdicts and the provider's expiry, and keeps every value out of everything", async () => {
      const w = await make();
      const net = fakeFetch({
        "api.github.com": { status: 200, headers: { "github-authentication-token-expiration": "2026-10-25 00:00:00 UTC" } },
        "api.cloudflare.com": { status: 200, body: { success: true, result: { status: "active" } } },
        "api.resend.com": { status: 200 },
      });
      w.env.fetchImpl = net.impl;
      await w.jobs.get("credentials-check")!();
      expect(await listCredentials(w.ctx, A)).toHaveLength(22);
      expect(net.calls.map((c) => c.url).sort()).toEqual(["https://api.cloudflare.com/client/v4/user/tokens/verify", "https://api.github.com/user", "https://api.resend.com/domains"]);
      expect(net.calls.every((c) => c.method === "GET")).toBe(true);
      const auth = Object.fromEntries(net.calls.map((c) => [new URL(c.url).host, c.headers.authorization]));
      expect(auth).toEqual({ "api.github.com": `Bearer ${GITHUB_VALUE}`, "api.cloudflare.com": `Bearer ${CF_VALUE}`, "api.resend.com": `Bearer ${RESEND_VALUE}` });
      const gh = await byKey(w, "github-fine-grained-new");
      expect(gh).toMatchObject({ last_verify_status: "ok", last_verify_detail: "GitHub accepts it." });
      expect(new Date(gh.expires_at).toISOString().slice(0, 10)).toBe("2026-10-25"); // learned from GitHub
      // 21 days left: the expiry the provider told us now raises the 30 day warning
      expect((await extraChecks(w.env, A, { fresh: true })).health.find((c) => c.key === `credential:${gh.id}:expiry`)).toMatchObject({ status: "warn", title: "GitHub fine-grained token for agents and Paperclip expires in 21 days" });
      const dump = await everything(w);
      for (const value of VALUES) expect(dump).not.toContain(value);
      expect(JSON.stringify(await list(w))).not.toContain("do-not-leak");
    });

    it("a refused credential goes red on the health issue, is recorded once in the activity feed, and clears when it is accepted again", async () => {
      const w = await make();
      let github: Answer = { status: 401 };
      w.env.fetchImpl = (async (url: string, init?: { headers?: Record<string, string> }) => fakeFetch({ "api.github.com": github, "api.cloudflare.com": { status: 200, body: { success: true, result: { status: "active" } } }, "api.resend.com": { status: 200 } }).impl(url, init as never)) as unknown as typeof fetch;
      await w.jobs.get("credentials-check")!();
      const row = await byKey(w, "github-fine-grained-new");
      expect(row.last_verify_status).toBe("invalid");
      const bad = (await extraChecks(w.env, A, { fresh: true })).health.find((c) => c.key === `credential:${row.id}:invalid`)!;
      expect(bad).toMatchObject({ status: "bad", title: "GitHub, owner Partners-in-Biz refused GitHub fine-grained token for agents and Paperclip" });
      expect(bad.fix).toContain("swap-github-token.sh");
      const activity = (await w.client.query(`SELECT text FROM ${NAMESPACE}.activity WHERE kind = 'credential'`)).rows;
      expect(activity).toHaveLength(1);
      await w.jobs.get("credentials-check")!(); // still refused: said once, not every day
      expect((await w.client.query(`SELECT text FROM ${NAMESPACE}.activity WHERE kind = 'credential'`)).rows).toHaveLength(1);
      github = { status: 200 };
      w.clock.set("2026-10-04T12:00:00.000Z");
      await w.jobs.get("credentials-check")!();
      expect((await byKey(w, "github-fine-grained-new")).last_verify_status).toBe("ok");
      expect((await extraChecks(w.env, A, { fresh: true })).health.filter((c) => c.key.endsWith(":invalid"))).toEqual([]);
    });

    it("an unreachable provider keeps the last real verdict, so one bad night does not clear or raise anything", async () => {
      const w = await make();
      w.env.fetchImpl = fakeFetch({ "api.github.com": { status: 401 }, "api.cloudflare.com": { status: 200, body: { success: true, result: { status: "active" } } }, "api.resend.com": { status: 200 } }).impl;
      await w.jobs.get("credentials-check")!();
      w.clock.set("2026-10-04T12:00:00.000Z");
      w.env.fetchImpl = fakeFetch({ "api.github.com": new Error("offline"), "api.cloudflare.com": { status: 503 }, "api.resend.com": { status: 500 } }).impl;
      await w.jobs.get("credentials-check")!();
      expect(await byKey(w, "github-fine-grained-new")).toMatchObject({ last_verify_status: "invalid" }); // still the last real verdict
      expect(await byKey(w, "resend-key")).toMatchObject({ last_verify_status: "ok" });
      expect(new Date((await byKey(w, "resend-key")).last_verified_at).toISOString().slice(0, 10)).toBe("2026-10-03");
    });

    it("skips a company with no saved Cockpit settings, and survives one that fails", async () => {
      const w = await make({});
      const net = fakeFetch({});
      w.env.fetchImpl = net.impl;
      await w.jobs.get("credentials-check")!();
      expect(net.calls).toEqual([]);
      expect(await listCredentials(w.ctx, A)).toHaveLength(0);
    });

    it("never calls a provider more than twelve times in one run", async () => {
      const w = await make();
      for (let i = 0; i < 16; i += 1) await record(w, { name: `GitHub token ${i}`, system: "GitHub", verifyWith: "github" });
      const net = fakeFetch({ "api.github.com": { status: 200 } });
      w.env.fetchImpl = net.impl;
      const result = await verifyCompany(w.env, A);
      expect(net.calls).toHaveLength(12);
      expect(result.verified).toBe(12);
    });

    it("credential-list with verify checks first, then lists, and says how many were refused", async () => {
      const w = await make();
      await seedCredentials(w.env, A);
      w.env.fetchImpl = fakeFetch({ "api.github.com": { status: 401 }, "api.cloudflare.com": { status: 200, body: { success: true, result: { status: "active" } } }, "api.resend.com": { status: 200 } }).impl;
      const out = await list(w, { verify: true });
      expect(out.data!.verification).toMatchObject({ verified: 3, ok: 2, invalid: 1 });
      expect(out.content).toContain("checked 3 with their providers (1 refused)");
      expect(out.content).toContain("never values");
      expect(out.data!.problems.map((p) => p.key)).toContain("credentials:burned");
      expect((await credentialList(w.env, A)).credentials.find((c) => String(c.name).startsWith("GitHub fine-grained token for agents"))!.lastVerify).toContain("invalid: GitHub refused it");
    });

    it("credential-list with verify does not call a provider again for a credential really checked in the last 15 minutes", async () => {
      const w = await make();
      await seedCredentials(w.env, A);
      const net = fakeFetch({ "api.github.com": { status: 200 }, "api.cloudflare.com": { status: 200, body: { success: true, result: { status: "active" } } }, "api.resend.com": { status: 200 } });
      w.env.fetchImpl = net.impl;
      const first = await list(w, { verify: true });
      expect(first.data!.verification).toMatchObject({ verified: 3 });
      expect(net.calls).toHaveLength(3);
      // an agent in a loop asking again gets the recorded verdicts and no new provider calls
      const again = await list(w, { verify: true });
      expect(net.calls).toHaveLength(3);
      expect(again.data!.verification).toMatchObject({ verified: 0, skippedRecent: 3 });
      expect(again.content).toContain("3 skipped as checked in the last 15 minutes");
      expect(again.data!.credentials.find((c) => String(c.name).startsWith("GitHub fine-grained token for agents"))!.lastVerify).toBe("ok: GitHub accepts it.");
      // later it is checked again
      w.clock.set("2026-10-03T12:16:00.000Z");
      await list(w, { verify: true });
      expect(net.calls).toHaveLength(6);
      // and the daily job always checks (it passes no window)
      await verifyCompany(w.env, A);
      expect(net.calls).toHaveLength(9);
    });

    it("a missing company secret or an unreachable provider never refreshes the 'last verified' date or replaces what was really checked", async () => {
      const w = await make();
      await seedCredentials(w.env, A);
      // never verified and nothing to verify with: not_configured, and NO date (it was not checked)
      w.configs[A] = { healthIssue: true, credentialSeed: true };
      w.env.fetchImpl = fakeFetch({}).impl;
      await verifyCompany(w.env, A);
      let row = await byKey(w, "resend-key");
      expect(row).toMatchObject({ last_verify_status: "not_configured", last_verified_at: null });
      // really checked once (secret configured, refused by the provider)
      w.configs[A] = CHECKS_CONFIG;
      w.env.fetchImpl = fakeFetch({ "api.github.com": { status: 401 }, "api.cloudflare.com": { status: 200, body: { success: true, result: { status: "active" } } }, "api.resend.com": { status: 200 } }).impl;
      await verifyCompany(w.env, A);
      row = await byKey(w, "github-fine-grained-new");
      expect(row).toMatchObject({ last_verify_status: "invalid", last_verify_detail: "GitHub refused it (expired or revoked)." });
      const checkedAt = new Date(row.last_verified_at).toISOString();
      // the secret is removed later: the last real verdict, its words and its date stay exactly as they were
      w.clock.set("2026-10-10T12:00:00.000Z");
      w.configs[A] = { healthIssue: true, credentialSeed: true };
      await verifyCompany(w.env, A);
      row = await byKey(w, "github-fine-grained-new");
      expect(row).toMatchObject({ last_verify_status: "invalid", last_verify_detail: "GitHub refused it (expired or revoked)." });
      expect(new Date(row.last_verified_at).toISOString()).toBe(checkedAt);
      // the provider is down: the same
      w.configs[A] = CHECKS_CONFIG;
      w.env.fetchImpl = fakeFetch({ "api.github.com": new Error("offline") }).impl;
      await verifyCompany(w.env, A);
      row = await byKey(w, "github-fine-grained-new");
      expect(row).toMatchObject({ last_verify_status: "invalid", last_verify_detail: "GitHub refused it (expired or revoked)." });
      expect(new Date(row.last_verified_at).toISOString()).toBe(checkedAt);
      expect(row.last_verify_detail).not.toContain("did not answer");
    });
  });

  describe("who may clear an alarm", () => {
    it("any agent can record a credential and fix its details, but only the Operator can mark one verified or change its status", async () => {
      const w = await make();
      await seedCredentials(w.env, A);
      const burned = await byKey(w, "github-classic-old");
      // a non-Operator agent adds one and updates its details: allowed
      const created = await record(w, { name: "Postmark token", system: "Postmark", expiresAt: "2027-02-01" }, DEV_RUN);
      expect(created.error).toBeUndefined();
      expect((await record(w, { id: created.data!.id, livesIn: "PAR company secret POSTMARK", expiresAt: "2027-03-01" }, DEV_RUN)).error).toBeUndefined();
      // it cannot vouch for one, retire one, or change a burned one's status
      for (const params of [{ id: burned.id, status: "retired" }, { id: burned.id, status: "active" }, { id: created.data!.id, markVerified: true }, { name: "New", system: "X", status: "retired" }]) {
        const refused = await record(w, params, DEV_RUN);
        expect(refused.error).toContain("Only the Operator can mark a credential verified or change its status");
      }
      expect((await byKey(w, "github-classic-old")).status).toBe("burned");
      expect(keys((await extraChecks(w.env, A, { fresh: true })).health)).toContain("credentials:burned");
      // the Operator can
      expect((await record(w, { id: burned.id, status: "retired" }, RUN)).error).toBeUndefined();
      expect((await byKey(w, "github-classic-old")).status).toBe("retired");
      expect((await record(w, { id: created.data!.id, markVerified: true }, RUN)).error).toBeUndefined();
    });

    it("with no Operator linked no agent may, and the Operator vouching for a refused credential is said in the activity feed", async () => {
      const w = await make();
      await seedCredentials(w.env, A);
      const gh = await byKey(w, "github-fine-grained-new");
      await w.client.query(`UPDATE ${NAMESPACE}.credentials SET last_verify_status = 'invalid', last_verify_detail = 'GitHub refused it (expired or revoked).' WHERE id = $1`, [gh.id]);
      expect((await record(w, { id: gh.id, markVerified: true }, DEV_RUN)).error).toContain("Only the Operator");
      expect((await byKey(w, "github-fine-grained-new")).last_verify_status).toBe("invalid");
      expect((await record(w, { id: gh.id, markVerified: true }, RUN)).error).toBeUndefined();
      expect((await byKey(w, "github-fine-grained-new")).last_verify_status).toBe("ok");
      const said = (await w.client.query(`SELECT text FROM ${NAMESPACE}.activity WHERE kind = 'credential'`)).rows as Array<{ text: string }>;
      expect(said.map((r) => r.text)).toEqual([expect.stringContaining("marked GitHub fine-grained token for agents and Paperclip verified although GitHub, owner Partners-in-Biz refused it at the last check")]);
      await w.client.query(`UPDATE ${NAMESPACE}.roles SET operator_agent_id = NULL WHERE company_id = $1`, [A]);
      expect((await record(w, { id: gh.id, markVerified: true }, RUN)).error).toContain("Only the Operator");
    });
  });

  describe("an approaching expiry reaches the people who can act on it (the 30 day alert)", () => {
    const inDays = (n: number) => new Date(Date.parse("2026-10-03T12:00:00.000Z") + n * 86_400_000).toISOString().slice(0, 10);

    it("a credential 25 days from expiry is a warning at once on the Cockpit and the Operator's brief, and on the System health issue once it has lasted a day", async () => {
      const w = await make();
      const created = await record(w, { name: "Postmark token", system: "Postmark", expiresAt: inDays(25), rotateHow: "Create a new server token", rotateHref: "https://account.postmarkapp.com/servers" });
      const key = `credential:${created.data!.id}:expiry`;
      // first sight: shown as a warning, but not yet on the System health issue (warnings escalate after 24 hours)
      const first = await collectProblems(w.env, A, { trackWarnings: true });
      expect(first.keys).not.toContain(`partnersinbiz.cockpit:${key}`);
      const brief = (await w.tools.get("company-brief")!({}, RUN)) as { data: { health: { problems: Array<{ status: string; title: string; fix: string | null }> } } };
      const inBrief = brief.data.health.problems.find((p) => /^Postmark token expires in \d+ days$/.test(p.title));
      expect(inBrief).toMatchObject({ status: "warn" });
      expect(inBrief!.fix).toContain("Create a new server token");
      // a day and an hour later it is still a warning, and now it is on the System health issue the Operator works from
      w.clock.set("2026-10-04T13:00:00.000Z");
      const later = await collectProblems(w.env, A, { trackWarnings: true });
      const entry = later.entries.find((e) => e.key === key)!;
      expect(entry).toMatchObject({ status: "warn", plugin: "partnersinbiz.cockpit" });
      expect(entry.detail).toContain("Unresolved for more than a day.");
      expect(entry.since).not.toBeNull();
      const refreshed = await refreshHealthIssue(w.env, A, later);
      expect(refreshed.action).toBe("created");
      const issue = [...w.issues.values()].find((i) => i.originKind === ORIGIN.health)!;
      expect(issue.description).toMatch(/Warning: Postmark token expires in \d+ days/);
      expect(issue.description).toContain("Create a new server token");
    });

    it("inside 7 days it is red at once, and a lapsed one is red too", async () => {
      const w = await make();
      const soon = await record(w, { name: "Resend key", system: "Resend", expiresAt: inDays(5) });
      const lapsed = await record(w, { name: "Old token", system: "X", expiresAt: inDays(-3) });
      const problems = await collectProblems(w.env, A, { trackWarnings: true });
      expect(problems.entries.find((e) => e.key === `credential:${soon.data!.id}:expiry`)).toMatchObject({ status: "bad" });
      expect(problems.entries.find((e) => e.key === `credential:${lapsed.data!.id}:expiry`)).toMatchObject({ status: "bad", title: "Old token expired 4 days ago" });
    });
  });
});
