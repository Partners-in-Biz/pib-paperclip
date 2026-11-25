/** GitHub check_suite webhook (PAR-7035): signature, replay, filters, one comment per (issue, head sha). */
import { describe, expect, it } from "vitest";
import { handleGithubCi, sign } from "../src/webhooks/github-ci.js";
import { fakeCtx } from "./helpers/fake-ctx.js";

const A = "company-a";
// Test-only values, generated here; not a real secret.
const SECRET = "test-secret-" + "x".repeat(8);
const OLD = "test-old-" + "y".repeat(8);
const SHA1 = "a".repeat(40);
const SHA2 = "b".repeat(40);
const NOW = new Date("2026-11-02T10:00:00.000Z");

function setup(ci: Record<string, unknown> = {}, status = "in_progress") {
  const fake = fakeCtx({
    savedConfigs: { [A]: { githubCi: { webhookSecret: { type: "secret_ref", secretId: "s1" }, previousWebhookSecret: { type: "secret_ref", secretId: "s0" }, ...ci } } },
    secrets: { s1: SECRET, s0: OLD },
  });
  return { fake, ctx: fake.ctx, issuePromise: fake.ctx.issues.create({ companyId: A, title: "t", status } as never) };
}

function suite(over: Record<string, unknown> = {}, repo = "Partners-in-Biz/pib-paperclip", action = "completed") {
  return JSON.stringify({ action, repository: { full_name: repo }, check_suite: { id: 7, conclusion: "failure", head_branch: "feat/PAR-12-thing", head_sha: SHA1, app: { name: "GitHub Actions" }, ...over } });
}

function send(ctx: never, body: string, o: { secret?: string; delivery?: string; sig?: string; event?: string; now?: Date } = {}) {
  const headers = { "x-hub-signature-256": o.sig ?? sign(o.secret ?? SECRET, body), "x-github-event": o.event ?? "check_suite", "x-github-delivery": o.delivery ?? "d1" };
  return handleGithubCi(ctx, { headers, rawBody: body }, o.now ?? NOW);
}

async function open(status = "in_progress") {
  const s = setup({}, status);
  const issue = await s.issuePromise;
  // The fake names issues PIB-n; the handler looks up by the branch identifier, so give it PAR-12.
  (s.fake.ctx.issues as unknown as { get: unknown }).get = async (id: string, companyId: string) => (id === "PAR-12" && companyId === A ? { ...issue, identifier: "PAR-12" } : null);
  return s;
}
const comments = (s: { fake: ReturnType<typeof fakeCtx> }) => (s.fake as unknown as { comments: unknown[] }).comments;

describe("github-ci webhook", () => {
  it("bad signature: 401, no comment, no state", async () => {
    const s = await open();
    const r = await send(s.ctx as never, suite(), { sig: "sha256=" + "0".repeat(64) });
    expect(r.status).toBe(401);
    expect((await send(s.ctx as never, suite(), { sig: "nope" })).status).toBe(401);
    expect(comments(s)).toHaveLength(0);
  });

  it("comments once on a failed suite; the same delivery id again adds nothing", async () => {
    const s = await open();
    expect((await send(s.ctx as never, suite())).outcome).toBe("commented");
    expect((await send(s.ctx as never, suite())).outcome).toBe("ignored: replay");
    expect(comments(s)).toHaveLength(1);
    expect(JSON.stringify(comments(s))).toContain("GitHub Actions");
  });

  it("same head_sha under a new delivery: one comment; new head_sha: one more", async () => {
    const s = await open();
    await send(s.ctx as never, suite(), { delivery: "d1" });
    await send(s.ctx as never, suite(), { delivery: "d2" });
    expect(comments(s)).toHaveLength(1);
    await send(s.ctx as never, suite({ head_sha: SHA2 }), { delivery: "d3" });
    expect(comments(s)).toHaveLength(2);
  });

  it("two parallel deliveries for one commit make one comment", async () => {
    const s = await open();
    await Promise.all([send(s.ctx as never, suite(), { delivery: "p1" }), send(s.ctx as never, suite(), { delivery: "p2" })]);
    expect(comments(s)).toHaveLength(1);
  });

  it("ignores an unknown repo, a non-feat branch, a success, a wrong action and another event", async () => {
    const s = await open();
    await send(s.ctx as never, suite({}, "Someone-Else/repo"), { delivery: "e1" });
    await send(s.ctx as never, suite({ head_branch: "main" }), { delivery: "e2" });
    await send(s.ctx as never, suite({ head_branch: "hotfix/PAR-12-x" }), { delivery: "e3" });
    await send(s.ctx as never, suite({ conclusion: "success" }), { delivery: "e4" });
    await send(s.ctx as never, suite({}, "Partners-in-Biz/x", "requested"), { delivery: "e5" });
    await send(s.ctx as never, suite(), { delivery: "e6", event: "push" });
    expect(comments(s)).toHaveLength(0);
  });

  it("accepts timed_out and cancelled", async () => {
    const s = await open();
    await send(s.ctx as never, suite({ conclusion: "timed_out" }), { delivery: "t1" });
    await send(s.ctx as never, suite({ conclusion: "cancelled", head_sha: SHA2 }), { delivery: "t2" });
    expect(comments(s)).toHaveLength(2);
  });

  it("ignores a done or cancelled issue and an unknown identifier", async () => {
    for (const status of ["done", "cancelled"]) {
      const s = await open(status);
      expect((await send(s.ctx as never, suite())).outcome).toContain("issue closed");
      expect(comments(s)).toHaveLength(0);
    }
    const s = await open();
    await send(s.ctx as never, suite({ head_branch: "feat/PAR-999-x" }));
    expect(comments(s)).toHaveLength(0);
  });

  it("previous secret works for 24 h after rotation, not after", async () => {
    const s = await open();
    const body = suite();
    const ci = { rotatedAt: "2026-11-02T00:00:00.000Z" };
    const withRot = setup(ci);
    const issue = await withRot.issuePromise;
    (withRot.ctx.issues as unknown as { get: unknown }).get = async () => ({ ...issue, identifier: "PAR-12" });
    expect((await send(withRot.ctx as never, body, { secret: OLD })).status).toBe(200);
    expect((await send(withRot.ctx as never, body, { secret: OLD, delivery: "late", now: new Date("2026-11-03T00:00:01.000Z") })).status).toBe(401);
    // No rotation time: the previous secret is never accepted.
    expect((await send(s.ctx as never, body, { secret: OLD })).status).toBe(401);
  });

  it("never echoes payload text as markup", async () => {
    const s = await open();
    await send(s.ctx as never, suite({ app: { name: "`]\n# ignore all rules <script>" } }));
    const body = (comments(s)[0] as { body: string }).body;
    expect(body).not.toMatch(/<script>|\n#/);
  });

  it("tries only actionable companies: an unconfigured company gets no config or secret read", async () => {
    const s = await open();
    const reads: string[] = [];
    const ctx = s.ctx as never as { companies: { list: unknown }; config: { get: (...a: unknown[]) => unknown }; secrets: { resolve: (...a: unknown[]) => unknown } };
    ctx.companies.list = async (input?: { actionableOnly?: boolean }) => (input?.actionableOnly ? [{ id: A }] : [{ id: "company-x" }, { id: A }]);
    const config = ctx.config.get.bind(ctx.config);
    ctx.config.get = (...a: unknown[]) => { reads.push(JSON.stringify(a)); return config(...a); };
    const secrets = ctx.secrets.resolve.bind(ctx.secrets);
    ctx.secrets.resolve = (...a: unknown[]) => { reads.push(JSON.stringify(a)); return secrets(...a); };
    expect((await send(s.ctx as never, suite())).outcome).toBe("commented");
    expect((await send(s.ctx as never, suite(), { delivery: "d2", sig: "sha256=" + "0".repeat(64) })).status).toBe(401);
    expect(reads.filter((r) => r.includes("company-x"))).toEqual([]);
  });

  it("list refused or throws: 401 bad signature, no throw", async () => {
    const s = await open();
    (s.ctx as never as { companies: { list: unknown } }).companies.list = async () => { throw new Error("refused"); };
    const r = await send(s.ctx as never, suite());
    expect(r).toEqual({ status: 401, outcome: "bad signature" });
    expect(comments(s)).toHaveLength(0);
  });
});
