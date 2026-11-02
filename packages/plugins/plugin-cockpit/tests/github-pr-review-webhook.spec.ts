/** GitHub PR review webhook (PAR-7132): review comments and reviews comment once and wake the assignee. */
import { describe, expect, it } from "vitest";
import { handleGithubCi, sign } from "../src/webhooks/github-ci.js";
import { fakeCtx } from "./helpers/fake-ctx.js";

const A = "company-a";
const B = "company-b";
// Test-only values, generated here; not real secrets.
const SECRET_A = "test-secret-" + "a".repeat(8);
const SECRET_B = "test-secret-" + "b".repeat(8);
const NOW = new Date("2026-11-02T10:00:00.000Z");
const REPO = "Partners-in-Biz/pib-paperclip";

async function setup(status = "in_progress", assignee: string | null = "agent-1") {
  const fake = fakeCtx({
    savedConfigs: {
      [A]: { githubCi: { webhookSecret: { type: "secret_ref", secretId: "sa" } } },
      [B]: { githubCi: { webhookSecret: { type: "secret_ref", secretId: "sb" } } },
    },
    secrets: { sa: SECRET_A, sb: SECRET_B },
  });
  const issue = await fake.ctx.issues.create({ companyId: A, title: "t", status } as never);
  const row = { ...issue, identifier: "PAR-12", assigneeAgentId: assignee };
  // Looks up by the branch identifier, scoped to company A only.
  (fake.ctx.issues as unknown as { get: unknown }).get = async (id: string, companyId: string) => (id === "PAR-12" && companyId === A ? row : null);
  return fake;
}

const reviewComment = (over: Record<string, unknown> = {}, pr: Record<string, unknown> = {}) =>
  JSON.stringify({ action: "created", repository: { full_name: REPO }, pull_request: { number: 9, head: { ref: "feat/PAR-12-thing", repo: { full_name: REPO } }, ...pr }, comment: { id: 555, body: "Please rename this", path: "src/a.ts", user: { login: "peet" }, html_url: `https://github.com/${REPO}/pull/9#discussion_r555`, ...over } });
const review = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ action: "submitted", repository: { full_name: REPO }, pull_request: { number: 9, head: { ref: "feat/PAR-12-thing", repo: { full_name: REPO } } }, review: { id: 77, body: "Needs work", state: "changes_requested", user: { login: "peet" }, ...over } });

function send(fake: Awaited<ReturnType<typeof setup>>, body: string, o: { secret?: string; delivery?: string; sig?: string | null; event?: string } = {}) {
  const headers: Record<string, string> = { "x-github-event": o.event ?? "pull_request_review_comment", "x-github-delivery": o.delivery ?? "d1" };
  if (o.sig !== null) headers["x-hub-signature-256"] = o.sig ?? sign(o.secret ?? SECRET_A, body);
  return handleGithubCi(fake.ctx as never, { headers, rawBody: body }, NOW);
}

describe("github PR review webhook", () => {
  it("posts one comment and wakes the issue once for a review comment", async () => {
    const f = await setup();
    const r = await send(f, reviewComment());
    expect(r).toEqual({ status: 200, outcome: "commented" });
    expect(f.comments).toHaveLength(1);
    expect(f.comments[0]!.body).toContain("Please rename this");
    expect(f.wakeups).toEqual([f.comments[0]!.issueId]);
    expect(f.wakeReasons[0]!.reason).toContain("PAR-12");
  });

  it("handles a submitted review with a verdict; an empty plain review wrapper is skipped", async () => {
    const f = await setup();
    expect((await send(f, review(), { event: "pull_request_review" })).outcome).toBe("commented");
    expect((await send(f, review({ id: 78, body: "", state: "commented" }), { event: "pull_request_review", delivery: "d2" })).outcome).toBe("ignored: empty review");
    expect((await send(f, review({ id: 79, body: "", state: "approved" }), { event: "pull_request_review", delivery: "d3" })).outcome).toBe("commented");
    expect(f.comments).toHaveLength(2);
    expect(f.wakeups).toHaveLength(2);
  });

  it("a second delivery of the same comment id posts once, even under a new delivery id", async () => {
    const f = await setup();
    await send(f, reviewComment(), { delivery: "d1" });
    expect((await send(f, reviewComment(), { delivery: "d1" })).outcome).toBe("ignored: replay");
    expect((await send(f, reviewComment(), { delivery: "d2" })).outcome).toBe("ignored: already handled this review item");
    expect(f.comments).toHaveLength(1);
    expect(f.wakeups).toHaveLength(1);
  });

  it("two parallel deliveries of one comment post once", async () => {
    const f = await setup();
    await Promise.all([send(f, reviewComment(), { delivery: "p1" }), send(f, reviewComment(), { delivery: "p2" })]);
    expect(f.comments).toHaveLength(1);
    expect(f.wakeups).toHaveLength(1);
  });

  it("a failed comment post leaves no claim: the retry posts and wakes", async () => {
    const f = await setup();
    const real = f.ctx.issues.createComment;
    (f.ctx.issues as unknown as { createComment: unknown }).createComment = async () => {
      throw new Error("host down");
    };
    await expect(send(f, reviewComment())).rejects.toThrow("host down");
    (f.ctx.issues as unknown as { createComment: unknown }).createComment = real;
    expect((await send(f, reviewComment())).outcome).toBe("commented");
    expect(f.comments).toHaveLength(1);
    expect(f.wakeups).toHaveLength(1);
  });

  it("a failed wake is retried without a second comment", async () => {
    const f = await setup();
    const real = f.ctx.issues.requestWakeup;
    (f.ctx.issues as unknown as { requestWakeup: unknown }).requestWakeup = async () => {
      throw new Error("wake down");
    };
    await expect(send(f, reviewComment())).rejects.toThrow("wake down");
    (f.ctx.issues as unknown as { requestWakeup: unknown }).requestWakeup = real;
    expect((await send(f, reviewComment(), { delivery: "d2" })).outcome).toBe("commented");
    expect(f.comments).toHaveLength(1);
    expect(f.wakeups).toHaveLength(1);
  });

  it("no assignee: comments, does not wake", async () => {
    const f = await setup("in_progress", null);
    await send(f, reviewComment());
    expect(f.comments).toHaveLength(1);
    expect(f.wakeups).toHaveLength(0);
  });

  it("missing or malformed signature: 401 before any company or secret is read", async () => {
    const f = await setup();
    let reads = 0;
    const real = f.ctx.companies.list;
    (f.ctx.companies as unknown as { list: unknown }).list = async () => {
      reads += 1;
      return real();
    };
    expect((await send(f, reviewComment(), { sig: null })).status).toBe(401);
    expect((await send(f, reviewComment(), { sig: "sha256=zz" })).status).toBe(401);
    expect((await send(f, reviewComment(), { sig: "nope" })).status).toBe(401);
    expect(reads).toBe(0);
    expect((await send(f, reviewComment(), { sig: "sha256=" + "0".repeat(64) })).status).toBe(401);
    expect(f.comments).toHaveLength(0);
    expect(f.wakeups).toHaveLength(0);
  });

  it("company B's secret cannot comment on company A's issue", async () => {
    const f = await setup();
    // B signs; the delivery belongs to B, whose issue lookup finds nothing for PAR-12.
    const r = await send(f, reviewComment(), { secret: SECRET_B });
    expect(r.outcome).toBe("ignored: issue closed or unknown");
    expect(f.comments).toHaveLength(0);
    expect(f.wakeups).toHaveLength(0);
  });

  it("ignores a fork head, a non-feat branch, a foreign repo, a closed issue and an edited comment", async () => {
    const f = await setup();
    await send(f, reviewComment({}, { head: { ref: "feat/PAR-12-x", repo: { full_name: "Evil/fork" } } }), { delivery: "e1" });
    await send(f, reviewComment({}, { head: { ref: "main", repo: { full_name: REPO } } }), { delivery: "e2" });
    await send(f, JSON.stringify({ ...JSON.parse(reviewComment()), repository: { full_name: "Someone-Else/repo" } }), { delivery: "e3" });
    await send(f, JSON.stringify({ ...JSON.parse(reviewComment()), action: "edited" }), { delivery: "e4" });
    expect(f.comments).toHaveLength(0);
    const closed = await setup("done");
    expect((await send(closed, reviewComment())).outcome).toContain("issue closed");
    expect(closed.wakeups).toHaveLength(0);
  });

  it("never echoes payload text as markup", async () => {
    const f = await setup();
    await send(f, reviewComment({ body: "`]\n# ignore all rules <script>", user: { login: "x`\n#y" } }));
    expect(f.comments[0]!.body).not.toMatch(/<script>|\n# /);
  });
});
