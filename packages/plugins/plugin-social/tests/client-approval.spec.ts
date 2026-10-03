/**
 * 0.8.0 (Q1a-2): the client's approval link. A tokenised page (the SEO preview-service pattern) shows the client the post exactly
 * as it will appear; their answer is applied once by a 5-minute job and is the approval record. The link goes out only as a
 * Mailbox draft; nothing here sends mail.
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSocialConfig } from "../src/config.js";
import {
  applyClientAnswer,
  approvalBase,
  approvalEmailDraft,
  approvalServiceHealth,
  approvalUrl,
  clearApprovalHealthCache,
  clientAnswersJob,
  deliverClientAnswers,
  hashToken,
  listClientApprovals,
  newToken,
  requestClientApproval,
  snapshotOf,
} from "../src/client-approval.js";
import { contentHashOf } from "../src/content-hash.js";
import { attachDestination, detachDestination, transitionPost, updatePostRecord } from "../src/service.js";
import { approvalWorld, postRow, T, type World } from "./world.js";

beforeEach(() => clearApprovalHealthCache());

const CLIENT_ONLY = { require_owner: false, require_client: true };

async function config(w: World) {
  return loadSocialConfig(w.ctx, "co");
}

async function link(w: World, extra: Partial<Parameters<typeof requestClientApproval>[4]> = {}) {
  return requestClientApproval(w.ctx, "co", postRow(w), await config(w), { createdBy: "ag-social", byAgent: true, ...extra });
}

describe("tokens and addresses", () => {
  it("a token is 43 URL-safe characters, never repeats, and is stored only as its SHA-256", () => {
    const a = newToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(a);
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hashToken(a)).toBe(createHash("sha256").update(a).digest("hex"));
  });

  it("the page address defaults to the preview domain under /a and must be https", () => {
    expect(approvalBase({ approvalBaseUrl: "https://preview.partnersinbiz.online/a/" })).toBe("https://preview.partnersinbiz.online/a");
    expect(() => approvalBase({ approvalBaseUrl: "http://preview.example.com/a" })).toThrow(/https/);
    expect(approvalUrl("https://x.test/a/", "TOKEN")).toBe("https://x.test/a/TOKEN");
  });

  it("the settings address overrides the default", async () => {
    const w = approvalWorld({ config: { approvalBaseUrl: "https://approve.example.com/a/" } });
    expect((await config(w)).approvalBaseUrl).toBe("https://approve.example.com/a");
    expect(approvalBase(await config(approvalWorld()))).toBe("https://preview.partnersinbiz.online/a");
  });
});

describe("what the client sees", () => {
  const post = { body: "Spring sale starts Friday.", first_comment: " More at the shop ", overrides: { x: { text: "Sale Friday" }, linkedin: { title: "Spring sale", link: "https://acme.test/sale" } }, scheduled_at: "2026-10-09T07:30:00Z", media: [{ url: "https://m.test/a.png", kind: "image", altText: "A shop front" }, { url: "http://insecure.test/b.png", kind: "image" }, { url: "javascript:alert(1)", kind: "image" }] };

  it("freezes the text each account will publish, the media over https only, and the time", () => {
    const snap = snapshotOf({ post: post as never, accounts: [{ platform: "x", display_name: "@acme" }, { platform: "linkedin", display_name: "Acme" }, { platform: "nonsense", display_name: "?" }], poster: "Partners in Biz", clientName: "Acme", timezone: "Africa/Johannesburg" });
    expect(snap).toMatchObject({ version: 1, poster: "Partners in Biz", clientName: "Acme", scheduledAt: "2026-10-09T07:30:00.000Z", firstComment: "More at the shop" });
    expect(snap.media).toEqual([{ url: "https://m.test/a.png", kind: "image", altText: "A shop front" }]);
    expect(snap.destinations).toEqual([
      { platform: "x", label: "X", account: "@acme", text: "Sale Friday", title: null, link: null },
      { platform: "linkedin", label: "LinkedIn", account: "Acme", text: "Spring sale starts Friday.", title: "Spring sale", link: "https://acme.test/sale" },
    ]);
  });

  it("the email is plain, carries the link and the last day, and escapes the post text", () => {
    const draft = approvalEmailDraft({ poster: "Partners in Biz", clientName: "Acme", recipientName: "Sam Jones", url: "https://p.test/a/TOK", expiresAt: "2026-10-17T10:00:00Z", snippet: "Sale <b>Friday</b>", timezone: "Africa/Johannesburg" });
    expect(draft.subject).toBe("Please approve your social media post for Acme");
    expect(draft.text).toContain("Hi Sam,");
    expect(draft.text).toContain("https://p.test/a/TOK");
    expect(draft.text).toContain("17 October 2026");
    expect(draft.text).toContain("Nothing is posted until you approve");
    expect(draft.html).toContain("Sale &lt;b&gt;Friday&lt;/b&gt;");
    expect(draft.html).not.toContain("<b>Friday</b>");
    expect(approvalEmailDraft({ poster: "P", clientName: null, recipientName: null, url: "u", expiresAt: "2026-10-17T10:00:00Z", snippet: "s", timezone: "UTC" }).text).toContain("Hi there,");
  });
});

describe("the approval page's health", () => {
  it("answers ok only on a 200 saying ok, and caches the answer for a minute", async () => {
    const w = approvalWorld();
    expect(await approvalServiceHealth(w.ctx, "https://p.test/a", 1000)).toEqual({ ok: true });
    expect(await approvalServiceHealth(w.ctx, "https://p.test/a", 30_000)).toEqual({ ok: true });
    expect(w.ctx.http.fetch).toHaveBeenCalledTimes(1);
    expect(w.ctx.http.fetch).toHaveBeenCalledWith("https://p.test/a/health", { method: "GET" });
    const down = approvalWorld({ pageOk: false });
    expect(await approvalServiceHealth(down.ctx, "https://down.test/a", 1000)).toEqual({ ok: false, error: "the page answered 502" });
    const dead = approvalWorld();
    (dead.ctx.http.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await approvalServiceHealth(dead.ctx, "https://dead.test/a", 1000)).toEqual({ ok: false, error: "ECONNREFUSED" });
  });
});

describe("making the client's link", () => {
  it("refuses what cannot work, with a message the agent can act on", async () => {
    const own = approvalWorld({ client: null, policy: CLIENT_ONLY });
    await expect(link(own)).rejects.toThrow("own post");
    const draft = approvalWorld({ policy: CLIENT_ONLY });
    draft.post.status = "draft";
    await expect(link(draft)).rejects.toThrow("Send it for review first");
    const dflt = approvalWorld({ policy: null });
    await expect(link(dflt)).rejects.toThrow("does not ask for their approval");
    const reviewer = approvalWorld({ reviewer: "rev-1", policy: { ...CLIENT_ONLY, require_reviewer: true } });
    await expect(link(reviewer)).rejects.toThrow("Reviewer has not passed this version yet");
    const broken = approvalWorld({ policy: CLIENT_ONLY });
    broken.ctx.fakeDb.queryResult = ((orig) => (sql: string, params: unknown[]) => (sql.includes(`FROM ${T("accounts")}`) ? [{ ...((orig(sql, params) as unknown[])[0] as object), status: "needs_reconnect" }] : orig(sql, params)))(broken.ctx.fakeDb.queryResult);
    await expect(link(broken)).rejects.toThrow("Fix these before the client sees the post");
    const down = approvalWorld({ policy: CLIENT_ONLY, pageOk: false });
    await expect(link(down)).rejects.toThrow(/approval page is not reachable.*one-time setup for the owner/);
    expect(down.links).toEqual([]);
  });

  it("stores the token's hash and the frozen snapshot, never the token, and returns the link, the people and the email", async () => {
    const w = approvalWorld({ policy: CLIENT_ONLY, reviewIssue: "iss-9", contacts: [{ id: "k1", name: "Sam Jones", emails: ["sam@acme.test"], account_ids: ["c1"] }, { id: "k2", name: "No Email", emails: [], account_ids: ["c1"] }] });
    const result = await link(w, { recipientEmail: " Sam@Acme.test " });
    expect(result.url).toMatch(/^https:\/\/preview\.partnersinbiz\.online\/a\/[A-Za-z0-9_-]{43}$/);
    const token = result.url.split("/").pop()!;
    expect(w.links).toHaveLength(1);
    expect(w.links[0]).toMatchObject({ post_id: "p1", token_hash: hashToken(token), status: "pending", client_kind: "company", client_ref: "c1", client_name: "Acme", recipient_email: "sam@acme.test", created_by: "ag-social", issue_id: "iss-9" });
    // The raw token is in no statement the plugin ran.
    expect(JSON.stringify(w.ctx.fakeDb.executes)).not.toContain(token);
    expect(w.links[0]!.content_hash).toBe(contentHashOf(postRow(w), ["a1"]));
    expect(w.links[0]!.snapshot).toMatchObject({ clientName: "Acme", poster: "Partners in Biz", destinations: [{ platform: "linkedin", account: "Acme Page", text: "Spring sale starts Friday. Come and see." }] });
    const days = (Date.parse(String(w.links[0]!.expires_at)) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
    expect(result.recipients).toEqual([{ name: "Sam Jones", email: "sam@acme.test" }]);
    expect(result.email.text).toContain(result.url);
    expect(result.email.text).toContain("Hi Sam,");
    expect(result.next).toContain("Mailbox DRAFT");
    expect(result.next).toContain("NEVER send it");
    expect(result.draftIssueId).toBeNull();
  });

  it("the link stays open as long as the policy says, and a new link replaces the old one", async () => {
    const w = approvalWorld({ policy: { ...CLIENT_ONLY, link_expiry_days: 3 } });
    const first = await link(w);
    const second = await link(w);
    expect(first.url).not.toBe(second.url);
    expect(w.links.map((l) => l.status)).toEqual(["superseded", "pending"]);
    const days = (Date.parse(String(w.links[1]!.expires_at)) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(2.9);
    expect(days).toBeLessThan(3.1);
  });

  it("can open a drafting task for the Account Manager, under the review issue, and never sends anything", async () => {
    const w = approvalWorld({ policy: CLIENT_ONLY, reviewIssue: "iss-9", accountManager: "ag-am", contacts: [{ id: "k1", name: "Sam Jones", emails: ["sam@acme.test"], account_ids: ["c1"] }] });
    const result = await link(w, { draft: "account-manager" });
    expect(result.draftIssueId).toBe("iss-1");
    expect(w.created).toHaveLength(1);
    expect(w.created[0]).toMatchObject({ parentId: "iss-9", assigneeAgentId: "ag-am", originId: "client-link-email:p1", title: "[Acme] Draft the approval email for a social post" });
    const text = String(w.created[0]!.description);
    expect(text).toContain("Mailbox DRAFT");
    expect(text).toContain("never send it");
    expect(text).toContain("Sam Jones <sam@acme.test>");
    expect(result.next).toContain("Do not email the link yourself");
    // Mail goes out through the Mailbox, which a person drives: this plugin emits nothing.
    expect(w.ctx.events?.emit).toBeUndefined();
  });

  it("by default the Account Manager drafts the email when the company has one: the Social agent has no mailbox delegation, so drafting itself would only fail", async () => {
    const w = approvalWorld({ policy: CLIENT_ONLY, reviewIssue: "iss-9", accountManager: "ag-am", contacts: [{ id: "k1", name: "Sam Jones", emails: ["sam@acme.test"], account_ids: ["c1"] }] });
    const result = await link(w);
    expect(result.draftIssueId).toBe("iss-1");
    expect(w.created).toHaveLength(1);
    expect(w.created[0]).toMatchObject({ assigneeAgentId: "ag-am", originId: "client-link-email:p1" });
    expect(result.next).toContain("Do not email the link yourself and do not draft it too");
    // One link only: the agent is not sent round again to make a second after a failed draft.
    expect(w.links).toHaveLength(1);
  });

  it("with no Account Manager the agent drafts it itself, and `draft: me` keeps it that way even when one exists", async () => {
    const none = approvalWorld({ policy: CLIENT_ONLY });
    const without = await link(none);
    expect(without.draftIssueId).toBeNull();
    expect(none.created).toEqual([]);
    expect(without.next).toContain("Create a Mailbox DRAFT");
    const staffed = approvalWorld({ policy: CLIENT_ONLY, accountManager: "ag-am" });
    const mine = await link(staffed, { draft: "me" });
    expect(mine.draftIssueId).toBeNull();
    expect(staffed.created).toEqual([]);
    expect(mine.next).toContain("Create a Mailbox DRAFT");
  });

  it("asking for the Account Manager by name with none staffed goes to the Operator, and with nobody at all is refused BEFORE a link is made", async () => {
    const op = approvalWorld({ policy: CLIENT_ONLY });
    const routed = await link(op, { draft: "account-manager" });
    expect(routed.draftIssueId).toBe("iss-1");
    expect(op.created[0]).toMatchObject({ assigneeAgentId: "ag-op" });
    const nobody = approvalWorld({ policy: CLIENT_ONLY });
    const base = (nobody.ctx.state.get as unknown as (k: { namespace?: string; stateKey: string }) => Promise<unknown>);
    (nobody.ctx.state as { get: unknown }).get = async (k: { namespace?: string; stateKey: string }) => {
      if (k.namespace === "pib-cockpit" && k.stateKey === "roles") return { companyId: "co", operatorAgentId: null, reviewerAgentId: null, ownerUserId: null, team: {}, updatedAt: "2026-10-01T00:00:00Z" };
      return base(k);
    };
    (nobody.ctx.companies as { get: unknown }).get = async () => ({ id: "co", name: "Partners in Biz" });
    await expect(link(nobody, { draft: "account-manager" })).rejects.toThrow("There is no Account Manager");
    // Nothing was left behind: no link row, no issue.
    expect(nobody.links).toEqual([]);
    expect(nobody.created).toEqual([]);
  });

  it("people making the link from the page get the text, not agent instructions, and no drafting task", async () => {
    const w = approvalWorld({ policy: CLIENT_ONLY, accountManager: "ag-am" });
    const result = await link(w, { byAgent: false, draft: "account-manager", createdBy: "owner-1" });
    expect(result.draftIssueId).toBeNull();
    expect(result.next).toBe("Send the link to the client with the email text. Nothing is posted until they approve.");
  });

  it("lists a post's links without ever showing the link, and says whether each still matches the post", async () => {
    const w = approvalWorld({ policy: CLIENT_ONLY });
    const made = await link(w);
    const listed = await listClientApprovals(w.ctx, "co", postRow(w));
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ approvalId: made.approvalId, status: "pending", current: true, sentTo: null });
    expect(JSON.stringify(listed)).not.toContain(made.url.split("/").pop()!);
    expect(JSON.stringify(listed)).not.toContain("token_hash");
    w.post.body = "Changed after the link was made.";
    expect((await listClientApprovals(w.ctx, "co", postRow(w)))[0]!.current).toBe(false);
  });
});

describe("a link only lives while it can count", () => {
  const PERSON = { companyId: "co", userId: "owner-1", agentId: null, runId: null, isAgent: false };
  const AGENT = { companyId: "co", userId: "owner-1", agentId: "ag-social", runId: "r", isAgent: true };

  it("editing the post voids the client's open link: the page then says it is no longer current", async () => {
    const w = approvalWorld({ policy: CLIENT_ONLY });
    await link(w);
    await updatePostRecord(w.ctx, AGENT, { postId: "p1", body: "A different caption." });
    expect(w.links[0]!.status).toBe("superseded");
  });

  it("attaching or detaching a destination voids the link too: the accounts are part of what the client approved", async () => {
    const attached = approvalWorld({ policy: CLIENT_ONLY });
    await link(attached);
    expect(attached.links[0]!.status).toBe("pending");
    await attachDestination(attached.ctx, AGENT, { postId: "p1", accountId: "a1" });
    expect(attached.links[0]!.status).toBe("superseded");
    const detached = approvalWorld({ policy: CLIENT_ONLY });
    await link(detached);
    await detachDestination(detached.ctx, AGENT, { postId: "p1", accountId: "a1" });
    expect(detached.links[0]!.status).toBe("superseded");
  });

  it("a detach that is refused leaves the client's link alone", async () => {
    const w = approvalWorld({ policy: CLIENT_ONLY });
    await link(w);
    const real = w.ctx.db.execute;
    (w.ctx.db as { execute: typeof real }).execute = async (sql: string, params?: unknown[]) => (sql.startsWith(`DELETE FROM ${T("destinations")}`) ? { rowCount: 0 } : real(sql, params));
    await expect(detachDestination(w.ctx, AGENT, { postId: "p1", accountId: "a1" })).rejects.toThrow("Only pending or failed destinations can be removed");
    expect(w.links[0]!.status).toBe("pending");
  });

  it("sending the post back to draft, or approving it, voids the link too", async () => {
    const back = approvalWorld({ policy: CLIENT_ONLY });
    await link(back);
    await transitionPost(back.ctx, PERSON, "p1", "draft");
    expect(back.links[0]!.status).toBe("superseded");
    const approved = approvalWorld({ policy: { require_client: true } });
    await link(approved);
    await transitionPost(approved.ctx, PERSON, "p1", "approved");
    // Still waiting for the client: the link they hold is the one that counts.
    expect(approved.links[0]!.status).toBe("pending");
    const { recordClientApprovalRecord } = await import("../src/service.js");
    await recordClientApprovalRecord(approved.ctx, PERSON, { postId: "p1", note: "Sam at Acme said yes on the phone, 3 Oct" });
    expect(approved.post.status).toBe("approved");
    expect(approved.links[0]!.status).toBe("superseded");
  });

  it("an answered link is never touched: the answer is the record", async () => {
    const w = approvalWorld({ policy: CLIENT_ONLY });
    const made = await link(w);
    w.answer(made.approvalId, "approved", "Sam", null);
    await updatePostRecord(w.ctx, AGENT, { postId: "p1", body: "Edited after the client answered." });
    expect(w.links[0]!.status).toBe("approved");
  });
});

describe("applying the client's answer (the 5-minute job)", () => {
  async function answered(policy: Record<string, unknown>, status: "approved" | "changes_requested", note: string | null = null, extra: Parameters<typeof approvalWorld>[0] = {}) {
    const w = approvalWorld({ policy, reviewIssue: "iss-9", ...extra });
    const made = await link(w);
    w.answer(made.approvalId, status, "Sam Jones", note);
    return { w, made };
  }

  it("an approval of the current version is the client's sign-off: the post is approved and scheduled, once", async () => {
    const { w } = await answered(CLIENT_ONLY, "approved", "Looks great");
    const summary = await deliverClientAnswers(w.ctx, "co", "Africa/Johannesburg");
    expect(summary).toMatchObject({ delivered: 1, approved: 1, failed: 0 });
    expect(w.post.status).toBe("approved");
    expect(w.outcomes).toMatchObject([{ stage: "client", outcome: "approved", via: "link", actor_name: "Sam Jones", note: "Looks great" }]);
    expect(w.comments.at(-1)!.body).toContain("The client (Sam Jones) approved the post");
    expect(w.comments.at(-1)!.body).toContain("Looks great");
    expect(w.updates.at(-1)).toEqual({ id: "iss-9", patch: { status: "done" } });
    expect(w.links[0]).toMatchObject({ notified_at: expect.any(String), applied: "approved" });
    // A second run finds nothing to do.
    expect(await deliverClientAnswers(w.ctx, "co", "UTC")).toMatchObject({ delivered: 0 });
    expect(w.outcomes).toHaveLength(1);
  });

  it("with a team member also required, the approval is recorded and the issue goes to the person who still has to approve", async () => {
    const { w } = await answered({ require_client: true }, "approved");
    const summary = await deliverClientAnswers(w.ctx, "co", "UTC");
    expect(summary).toMatchObject({ delivered: 1, approved: 1 });
    expect(w.post.status).toBe("review");
    expect(w.links[0]!.applied).toBe("approved_waiting_owner");
    expect(w.updates.at(-1)).toEqual({ id: "iss-9", patch: { status: "todo", assigneeAgentId: null, assigneeUserId: "owner-1" } });
    expect(w.comments.at(-1)!.body).toContain("approved the post");
    expect(w.comments.at(-1)!.body).toContain("Next: a team member's approval");
  });

  it("a request for changes sends the post back to draft with the client's note, and wakes the Social agent", async () => {
    const { w } = await answered(CLIENT_ONLY, "changes_requested", "Please use the new logo.");
    expect(await deliverClientAnswers(w.ctx, "co", "UTC")).toMatchObject({ delivered: 1, changes: 1 });
    expect(w.post.status).toBe("draft");
    expect(w.post.review_returns).toBe(1);
    expect(w.outcomes).toMatchObject([{ stage: "client", outcome: "changes", via: "link", note: "Please use the new logo." }]);
    expect(w.updates.at(-1)).toEqual({ id: "iss-9", patch: { status: "todo", assigneeAgentId: "ag-social", assigneeUserId: null } });
    expect(w.comments.at(-1)!.body).toContain("The client (Sam Jones) asked for changes");
    expect(w.comments.at(-1)!.body).toContain("> Please use the new logo.");
    expect(w.wakeups).toContain("iss-9");
    expect(w.links[0]!.applied).toBe("changes");
  });

  it("an answer for a version that has since changed does not count, and says so", async () => {
    const { w } = await answered(CLIENT_ONLY, "approved");
    w.post.body = "Edited after the link went out.";
    expect(await deliverClientAnswers(w.ctx, "co", "UTC")).toMatchObject({ delivered: 1, stale: 1, approved: 0 });
    expect(w.post.status).toBe("review");
    expect(w.outcomes).toEqual([]);
    expect(w.links[0]!.applied).toBe("stale");
    expect(w.comments.at(-1)!.body).toContain("changed after the link was made");
    expect(w.comments.at(-1)!.body).toContain("request-client-approval");
    expect(w.wakeups).toContain("iss-9");
  });

  it("an answer for a post that is no longer in review is kept on record and applied to nothing", async () => {
    const { w } = await answered(CLIENT_ONLY, "approved");
    w.post.status = "draft";
    expect(await deliverClientAnswers(w.ctx, "co", "UTC")).toMatchObject({ delivered: 1, approved: 0 });
    expect(w.links[0]!.applied).toBe("not_in_review");
    expect(w.post.status).toBe("draft");
    expect(w.comments.at(-1)!.body).toContain("not in review, so the answer was not applied");
  });

  it("an answer another run already claimed is left to that run: nothing is applied twice", async () => {
    const { w } = await answered(CLIENT_ONLY, "approved");
    const real = w.ctx.db.execute;
    (w.ctx.db as { execute: typeof real }).execute = async (sql: string, params?: unknown[]) => (sql.includes("SET notified_at = now()") ? { rowCount: 0 } : real(sql, params));
    expect(await deliverClientAnswers(w.ctx, "co", "UTC")).toMatchObject({ delivered: 0, approved: 0, failed: 0 });
    expect(w.post.status).toBe("review");
    expect(w.outcomes).toEqual([]);
    expect(w.comments).toEqual([]);
  });

  it("a failure releases the claim so the next run retries, and nothing is half-applied twice", async () => {
    const { w } = await answered(CLIENT_ONLY, "approved");
    let fail = true;
    const real = w.ctx.db.query;
    (w.ctx.db as { query: typeof real }).query = async (sql: string, params?: unknown[]) => {
      if (fail && sql.includes(`FROM ${T("posts")} WHERE id = $1`)) throw new Error("db blip");
      return real(sql, params);
    };
    expect(await deliverClientAnswers(w.ctx, "co", "UTC")).toMatchObject({ delivered: 0, failed: 1 });
    expect(w.links[0]!.notified_at).toBeNull();
    fail = false;
    expect(await deliverClientAnswers(w.ctx, "co", "UTC")).toMatchObject({ delivered: 1, approved: 1 });
    expect(w.outcomes).toHaveLength(1);
  });

  it("links that ran out unanswered are closed, and the Social agent is told once", async () => {
    const w = approvalWorld({ policy: CLIENT_ONLY, reviewIssue: "iss-9" });
    await link(w);
    w.links[0]!.expires_at = new Date(Date.now() - 60_000).toISOString();
    expect(await deliverClientAnswers(w.ctx, "co", "UTC")).toMatchObject({ expired: 1 });
    expect(w.links[0]!.status).toBe("expired");
    expect(w.comments.at(-1)!.body).toContain("ran out with no answer");
    expect(w.wakeups).toContain("iss-9");
    expect(await deliverClientAnswers(w.ctx, "co", "UTC")).toMatchObject({ expired: 0 });
  });

  it("applyClientAnswer reports a deleted post without failing", async () => {
    const w = approvalWorld({ policy: CLIENT_ONLY });
    const real = w.ctx.db.query;
    (w.ctx.db as { query: typeof real }).query = async (sql: string, params?: unknown[]) => (sql.includes(`FROM ${T("posts")} WHERE id = $1`) ? [] : real(sql, params));
    expect(await applyClientAnswer(w.ctx, { id: "x", company_id: "co", post_id: "gone", status: "approved", content_hash: "h", answered_by_name: "Sam", answer_note: null, answered_at: new Date().toISOString() }, "UTC")).toBe("post_removed");
  });
});

describe("the job", () => {
  it("applies answers for each company with links, skipping one whose Social module is off or whose settings were never saved", async () => {
    const { w } = await (async () => {
      const w = approvalWorld({ policy: CLIENT_ONLY, reviewIssue: "iss-9" });
      const made = await link(w);
      w.answer(made.approvalId, "approved", "Sam", null);
      return { w };
    })();
    const ensured: string[] = [];
    expect(await clientAnswersJob(w.ctx, async (id) => void ensured.push(id))).toMatchObject({ companies: 1, delivered: 1, approved: 1 });
    expect(ensured).toEqual(["co"]);
    // Settings never saved: the host would refuse the company calls, so the job leaves it alone.
    const unsaved = approvalWorld({ policy: CLIENT_ONLY });
    const made = await link(unsaved);
    unsaved.answer(made.approvalId, "approved", "Sam", null);
    (unsaved.ctx.config.get as ReturnType<typeof vi.fn>).mockResolvedValue({});
    expect(await clientAnswersJob(unsaved.ctx, async () => undefined)).toMatchObject({ companies: 0, delivered: 0 });
    // Switched off in Setup.
    const off = approvalWorld({ policy: CLIENT_ONLY });
    const madeOff = await link(off);
    off.answer(madeOff.approvalId, "approved", "Sam", null);
    const state = off.ctx.state.get as ReturnType<typeof vi.fn>;
    const base = state.getMockImplementation()! as (key: { namespace?: string; stateKey: string }) => Promise<unknown>;
    state.mockImplementation(async (key: { namespace?: string; stateKey: string }) => (key.namespace === "pib-setup" ? { modules: { social: false } } : base(key)));
    expect(await clientAnswersJob(off.ctx, async () => undefined)).toMatchObject({ companies: 0, delivered: 0 });
  });
});
