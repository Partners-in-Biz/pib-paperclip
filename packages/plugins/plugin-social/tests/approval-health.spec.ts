/**
 * 0.8.0: what the Cockpit and Setup say about client approvals. Said only when there is something to say: a link out while the
 * approval page is down, links nobody answered for a week, a policy that needs a Reviewer nobody staffs, and a post that waits for
 * the client rather than for a team member.
 */
import { describe, expect, it, vi } from "vitest";
import { approvalChecks, cockpitSnapshot } from "../src/cockpit.js";
import { approvalPageItem, socialSetupStatus } from "../src/setup-status.js";
import { clearApprovalHealthCache } from "../src/client-approval.js";
import { approvalWorld, T } from "./world.js";

const quiet = { pending: 0, unanswered: 0, waitingDelivery: 0, pageOk: null, reviewerPolicies: [], reviewerAvailable: true };

describe("approval health checks", () => {
  it("say nothing when nothing is wrong", () => {
    expect(approvalChecks(quiet)).toEqual([]);
    expect(approvalChecks({ ...quiet, pending: 3, pageOk: true })).toEqual([]);
    expect(approvalChecks({ ...quiet, reviewerPolicies: ["company:c1"], reviewerAvailable: true })).toEqual([]);
  });

  it("a link is out and the approval page does not answer: red, with the fix", () => {
    const [check] = approvalChecks({ ...quiet, pending: 2, pageOk: false, pageError: "the page answered 502" });
    expect(check).toMatchObject({ key: "approval-page", status: "bad", title: "Clients cannot open their approval links" });
    expect(check!.detail).toContain("2 client links are out");
    expect(check!.detail).toContain("the page answered 502");
    expect(check!.fix).toContain("pib-approval");
    // An answer waiting to be applied counts as a link in flight; a page that was not probed says nothing.
    expect(approvalChecks({ ...quiet, waitingDelivery: 1, pageOk: false })).toHaveLength(1);
    expect(approvalChecks({ ...quiet, pending: 2, pageOk: null })).toEqual([]);
  });

  it("links nobody answered for over a week are a warning with what to do", () => {
    const [check] = approvalChecks({ ...quiet, pending: 1, unanswered: 1, pageOk: true });
    expect(check).toMatchObject({ key: "approval-unanswered", status: "warn", title: "1 client approval unanswered for over a week" });
    expect(check!.fix).toContain("reminder");
    expect(approvalChecks({ ...quiet, unanswered: 3 })[0]!.title).toBe("3 client approvals unanswered for over a week");
  });

  it("a policy that needs the Reviewer when none is running is a warning that names the scopes", () => {
    const [check] = approvalChecks({ ...quiet, reviewerPolicies: ["company:c1", "own"], reviewerAvailable: false });
    expect(check).toMatchObject({ key: "approval-reviewer", status: "warn", href: "/setup?section=team" });
    expect(check!.detail).toContain("2 scopes (company:c1, own)");
  });
});

describe("the Cockpit snapshot", () => {
  const review = { id: "p1", body: "Spring sale", client_kind: "company", client_ref: "c1", client_name: "Acme", review_issue_id: "iss-1", updated_at: "2026-10-01T08:00:00Z" };

  function ctxFor(opts: { policy?: Record<string, unknown> | null; links?: { pending?: string; stale?: string; waiting?: string }; pageOk?: boolean; reviewer?: string | null }) {
    const w = approvalWorld({ policy: opts.policy ?? null, pageOk: opts.pageOk, reviewer: opts.reviewer ?? null });
    const base = w.ctx.fakeDb.queryResult;
    w.ctx.fakeDb.queryResult = (sql, params) => {
      if (sql.includes(`FROM ${T("posts")} WHERE company_id = $1 AND status = 'review'`)) return [review];
      if (sql.includes("count(*) FILTER (WHERE status = 'pending' AND expires_at >= now())")) return [{ pending: opts.links?.pending ?? "0", stale: opts.links?.stale ?? "0", waiting: opts.links?.waiting ?? "0" }];
      if (sql.includes(`FROM ${T("approval_policies")} WHERE company_id = $1 AND require_reviewer = true`)) return opts.policy?.require_reviewer ? [{ scope_key: "company:c1" }] : [];
      return base(sql, params);
    };
    return w;
  }

  it("a post that only the client approves is listed as waiting for the client, not as a team member's to approve", async () => {
    clearApprovalHealthCache();
    const snap = await cockpitSnapshot(ctxFor({ policy: { require_owner: false, require_client: true } }).ctx, "co");
    const item = snap.waiting.find((w) => w.key === "social:review:p1")!;
    expect(item).toMatchObject({ title: "[Acme] Waiting for the client: Spring sale", kind: "other", issueId: "iss-1" });
    expect(item.why).toContain("nobody on the team has to");
    // The default policy is unchanged: a person approves.
    const dflt = await cockpitSnapshot(ctxFor({}).ctx, "co");
    expect(dflt.waiting.find((w) => w.key === "social:review:p1")).toMatchObject({ title: "[Acme] Approve post: Spring sale", kind: "review" });
    // Both approve: the team member's click is still on the list.
    const both = await cockpitSnapshot(ctxFor({ policy: { require_client: true } }).ctx, "co");
    expect(both.waiting.find((w) => w.key === "social:review:p1")).toMatchObject({ kind: "review" });
  });

  it("shows the approval-page check only when links are out, and probes the page then", async () => {
    clearApprovalHealthCache();
    const none = ctxFor({ pageOk: false });
    expect((await cockpitSnapshot(none.ctx, "co")).health.map((h) => h.key)).not.toContain("approval-page");
    expect(none.ctx.http.fetch).not.toHaveBeenCalled();
    clearApprovalHealthCache();
    const down = ctxFor({ links: { pending: "2" }, pageOk: false });
    const health = (await cockpitSnapshot(down.ctx, "co")).health;
    expect(health.find((h) => h.key === "approval-page")).toMatchObject({ status: "bad" });
    expect(down.ctx.http.fetch).toHaveBeenCalledWith("https://preview.partnersinbiz.online/a/health", { method: "GET" });
    clearApprovalHealthCache();
    const up = ctxFor({ links: { pending: "2", stale: "1" }, pageOk: true });
    const upHealth = (await cockpitSnapshot(up.ctx, "co")).health;
    expect(upHealth.map((h) => h.key)).toContain("approval-unanswered");
    expect(upHealth.map((h) => h.key)).not.toContain("approval-page");
  });

  it("a bad saved address does not hide the approval checks: it is said as the reason clients cannot open their links", async () => {
    clearApprovalHealthCache();
    const w = approvalWorld({ policy: { require_owner: false, require_client: true }, config: { approvalBaseUrl: "preview.partnersinbiz.online/a" } });
    const base = w.ctx.fakeDb.queryResult;
    w.ctx.fakeDb.queryResult = (sql, params) => {
      if (sql.includes("count(*) FILTER (WHERE status = 'pending' AND expires_at >= now())")) return [{ pending: "2", stale: "1", waiting: "0" }];
      return base(sql, params);
    };
    const health = (await cockpitSnapshot(w.ctx, "co")).health;
    // The red check names the address problem, and the week-old links warning (a different check) is still there.
    expect(health.find((h) => h.key === "approval-page")).toMatchObject({ status: "bad" });
    expect(health.find((h) => h.key === "approval-page")!.detail).toContain("the address must start with https://");
    expect(health.map((h) => h.key)).toContain("approval-unanswered");
    // Nothing was fetched: a page at a made-up address is not probed.
    expect(w.ctx.http.fetch).not.toHaveBeenCalled();
  });

  it("warns when a policy needs the Reviewer and none is running", async () => {
    clearApprovalHealthCache();
    const w = ctxFor({ policy: { require_reviewer: true }, reviewer: null });
    expect((await cockpitSnapshot(w.ctx, "co")).health.find((h) => h.key === "approval-reviewer")).toMatchObject({ status: "warn" });
    const staffed = ctxFor({ policy: { require_reviewer: true }, reviewer: "rev-1" });
    expect((await cockpitSnapshot(staffed.ctx, "co")).health.map((h) => h.key)).not.toContain("approval-reviewer");
  });

  it("the new job is in the Cockpit's job health", async () => {
    const snap = await cockpitSnapshot(approvalWorld().ctx, "co");
    expect(snap.health.find((h) => h.key === "job:client-answers")).toMatchObject({ title: "Apply client approvals" });
  });
});

describe("the setup item", () => {
  const base = "https://preview.partnersinbiz.online/a";

  it("is green when the page answers", () => {
    const item = approvalPageItem({ base, baseSet: false, probe: { ok: true }, uiBase: null });
    expect(item).toMatchObject({ key: "client_approval", status: "done", required: false });
    expect(item.detail).toContain(`${base}/<link>`);
    expect(item.steps).toBeUndefined();
  });

  it("is optional, with the exact steps, when it does not answer, and unknown when it could not be checked", () => {
    const down = approvalPageItem({ base, baseSet: false, probe: { ok: false, error: "the page answered 502" }, uiBase: null });
    expect(down).toMatchObject({ status: "optional", required: false });
    expect(down.detail).toContain("the page answered 502");
    expect(down.steps!.join(" ")).toContain("plugin-social/ops/approval-server/README.md");
    expect(down.steps!.join(" ")).toContain("turns green by itself");
    expect(down.agentNext).toContain("the Social agent makes their link");
    expect(approvalPageItem({ base, baseSet: true, probe: { ok: false }, uiBase: null }).steps!.join(" ")).toContain("address under Client approval page");
    expect(approvalPageItem({ base, baseSet: false, probe: null, uiBase: null }).status).toBe("unknown");
  });

  it("a saved address that is not https is a mistake to fix, with the exact steps, and no page is probed", () => {
    const item = approvalPageItem({ base: "preview.partnersinbiz.online/a", baseSet: true, probe: { ok: false, error: "the address must start with https://" }, uiBase: null, addressError: "the address must start with https://" });
    expect(item).toMatchObject({ key: "client_approval", status: "missing", required: false });
    expect(item.detail).toContain("cannot be used: the address must start with https://");
    expect(item.detail).toContain('"preview.partnersinbiz.online/a"');
    expect(item.steps!.join(" ")).toContain("https://preview.partnersinbiz.online/a");
    expect(item.steps!.join(" ")).toContain("Click Save Configuration");
  });

  it("a typo in the optional address leaves the rest of the checklist intact (it used to throw and drop the whole company)", async () => {
    clearApprovalHealthCache();
    const w = approvalWorld({ config: { approvalBaseUrl: "preview.partnersinbiz.online/a" } });
    (w.ctx as unknown as { routines: unknown }).routines = { managed: { get: vi.fn(async () => ({ status: "missing", routineId: null, routine: null })) } };
    const status = await socialSetupStatus(w.ctx, "co");
    const keys = status.items.map((i) => i.key);
    expect(keys).toEqual(expect.arrayContaining(["settings", "base_url_key", "r2", "own_accounts", "agent", "routine", "client_approval"]));
    expect(status.items.find((i) => i.key === "client_approval")).toMatchObject({ status: "missing", required: false });
    expect(w.ctx.http.fetch).not.toHaveBeenCalled();
  });

  it("is part of the company's setup status, probing the configured address", async () => {
    clearApprovalHealthCache();
    const w = approvalWorld({ config: { approvalBaseUrl: "https://approve.example.com/a" } });
    (w.ctx as unknown as { routines: unknown }).routines = { managed: { get: vi.fn(async () => ({ status: "missing", routineId: null, routine: null })) } };
    const status = await socialSetupStatus(w.ctx, "co");
    const item = status.items.find((i) => i.key === "client_approval")!;
    expect(item).toMatchObject({ status: "done", required: false });
    expect(item.detail).toContain("https://approve.example.com/a/<link>");
    expect(w.ctx.http.fetch).toHaveBeenCalledWith("https://approve.example.com/a/health", { method: "GET" });
  });
});
