import { describe, expect, it, vi } from "vitest";
import { CREATIVE_FOLDER, CREATIVE_MAX_SECONDS, creativeClaimKey } from "../src/creative.js";
import { NAMESPACE } from "../src/namespace.js";
import { requestCreativeRecord, type Viewer } from "../src/service.js";
import { SOCIAL_TOOLS } from "../src/tools.js";
import { fakeCtx } from "./helpers.js";

const T = (name: string) => `${NAMESPACE}.${name}`;
const AGENT: Viewer = { companyId: "co", userId: null, agentId: "ag-social", runId: "run-1", isAgent: true };
const ACME = { client_kind: "company", client_ref: "c1", client_name: "Acme" };
const OWN = { client_kind: null, client_ref: null, client_name: null };

interface Team {
  creative?: string;
  social?: string;
  accountManager?: string;
}

/** Two posts in two scopes (own work and Acme), the handoffs table and host issues in memory. */
function world(team: Team = {}, opts: { status?: string; issueStatus?: string } = {}) {
  const post = (id: string, scope: Record<string, unknown>, accountId: string) => ({
    id, company_id: "co", body: "Spring sale starts Friday.", overrides: {}, media: [], status: opts.status ?? "draft", scheduled_at: null, scope: "org",
    owner_user_id: "owner-1", first_comment: null, source: "agent", source_ref: null, failure_issue_id: null, published_at: null, error: null,
    created_by_agent_id: "ag-social", review_issue_id: null, review_returns: 0, created_at: new Date(), updated_at: new Date(), experiment_id: null,
    experiment_arm: null, tags: [], ...scope, _account: accountId,
  });
  const posts = new Map([["p-own", post("p-own", OWN, "a-own")], ["p-acme", post("p-acme", ACME, "a-acme")]]);
  const accounts: Record<string, Record<string, unknown>> = {
    "a-own": { id: "a-own", company_id: "co", platform: "linkedin", display_name: "PiB", ...OWN },
    "a-acme": { id: "a-acme", company_id: "co", platform: "instagram", display_name: "Acme IG", ...ACME },
  };
  const handoffs = new Map<string, { issue_id: string | null }>();
  const created: Array<Record<string, unknown>> = [];
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const comments: Array<{ id: string; body: string }> = [];
  const wakeups: string[] = [];
  const members: Record<string, unknown> = {};
  if (team.creative) members["creative-producer"] = { agentId: team.creative, status: "idle" };
  if (team.social) members.social = { agentId: team.social, status: "idle" };
  if (team.accountManager) members["account-manager"] = { agentId: team.accountManager, status: "idle" };
  const ctx = fakeCtx(
    {
      state: {
        get: vi.fn(async (key: { namespace?: string; stateKey: string }) =>
          key.namespace === "pib-cockpit" && key.stateKey === "roles"
            ? { companyId: "co", operatorAgentId: null, reviewerAgentId: null, ownerUserId: "owner-1", reviewOutward: false, team: members, updatedAt: "2026-10-01T00:00:00Z" }
            : null,
        ),
        set: vi.fn(async () => undefined),
      },
      companies: { get: vi.fn(async () => ({ id: "co", issuePrefix: "PIB", defaultResponsibleUserId: "boss-1" })) },
      projects: { managed: { get: vi.fn(async () => ({ projectId: "proj-social" })) } },
      issues: {
        get: vi.fn(async (id: string) => ({ id, status: opts.issueStatus ?? "todo" })),
        create: vi.fn(async (input: Record<string, unknown>) => {
          created.push(input);
          return { id: `iss-${created.length}` };
        }),
        update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
          updates.push({ id, patch });
          return { id };
        }),
        createComment: vi.fn(async (id: string, body: string) => {
          comments.push({ id, body });
          return { id: "c" };
        }),
        requestWakeup: vi.fn(async (id: string) => {
          wakeups.push(id);
          return { queued: true };
        }),
      },
    },
    {
      queryResult: (sql, params) => {
        if (sql.includes(`FROM ${T("posts")} WHERE id = $1`)) return [posts.get(String(params[0]))].filter(Boolean) as unknown[];
        if (sql.includes(`FROM ${T("handoffs")} WHERE key = $1`)) return handoffs.has(String(params[0])) ? [handoffs.get(String(params[0]))] : [];
        if (sql.includes(`FROM ${T("destinations")} WHERE post_id = $1`)) {
          const account = posts.get(String(params[0]))?._account;
          return account ? [{ id: `d-${params[0]}`, company_id: "co", post_id: params[0], account_id: account, status: "pending", attempts: 0 }] : [];
        }
        if (sql.includes(`FROM ${T("accounts")} WHERE company_id = $1 AND id = ANY`)) return (JSON.parse(String(params[1])) as string[]).map((id) => accounts[id]).filter(Boolean);
        return [];
      },
      executeResult: (sql, params) => {
        if (sql.includes(`INSERT INTO ${T("handoffs")}`)) {
          if (handoffs.has(String(params[0]))) return 0;
          handoffs.set(String(params[0]), { issue_id: null });
          return 1;
        }
        if (sql.includes(`UPDATE ${T("handoffs")} SET issue_id`)) handoffs.set(String(params[0]), { issue_id: String(params[2]) });
        return 1;
      },
    },
  );
  return { ctx, created, updates, comments, wakeups, handoffs };
}

describe("request-creative", () => {
  it("is a registered tool that takes a post id", () => {
    const tool = SOCIAL_TOOLS.find((t) => t.name === "request-creative");
    expect(tool?.parametersSchema).toMatchObject({ required: ["postId"] });
  });

  it("opens one issue with the origin, brief, platform spec, 30 s cap, alt-text rule and Drive folder", async () => {
    const w = world({ social: "ag-social" });
    const out = await requestCreativeRecord(w.ctx, AGENT, { postId: "p-acme", brief: "Bold sale banner", format: "video" });
    expect(out).toMatchObject({ issueId: "iss-1", created: true, assignedTo: "social" });
    expect(w.created).toHaveLength(1);
    const issue = w.created[0] as { originKind: string; originId: string; description: string; title: string; projectId: string };
    expect(issue.originKind).toBe("plugin:partnersinbiz.social");
    expect(issue.originId).toBe("creative:p-acme");
    expect(issue.title).toContain("Acme");
    expect(issue.description).toContain("Bold sale banner");
    expect(issue.description).toContain("Instagram");
    expect(issue.description).toContain("9:16");
    expect(issue.description).toContain(`${CREATIVE_MAX_SECONDS} seconds at most`);
    expect(issue.description).toMatch(/Alt text is required/);
    expect(issue.description).toContain(CREATIVE_FOLDER);
    expect(issue.description).toContain('clientRef: "c1"');
    expect(w.wakeups).toEqual(["iss-1"]);
  });

  it("is idempotent: a second call returns the same issue and opens nothing new", async () => {
    const w = world({ social: "ag-social" });
    const first = await requestCreativeRecord(w.ctx, AGENT, { postId: "p-own" });
    const second = await requestCreativeRecord(w.ctx, AGENT, { postId: "p-own", brief: "Warmer colours" });
    expect(second).toMatchObject({ issueId: first.issueId, created: false });
    expect(w.created).toHaveLength(1);
    expect(w.comments).toEqual([{ id: first.issueId, body: expect.stringContaining("Warmer colours") }]);
    expect(w.handoffs.get(creativeClaimKey("co", "p-own"))).toEqual({ issue_id: first.issueId });
  });

  it("reopens a finished request instead of opening a second issue", async () => {
    const w = world({ social: "ag-social" }, { issueStatus: "done" });
    const first = await requestCreativeRecord(w.ctx, AGENT, { postId: "p-own" });
    const again = await requestCreativeRecord(w.ctx, AGENT, { postId: "p-own", brief: "New angle" });
    expect(again.issueId).toBe(first.issueId);
    expect(w.created).toHaveLength(1);
    expect(w.updates[0]).toMatchObject({ id: first.issueId, patch: { status: "todo", assigneeAgentId: "ag-social" } });
  });

  it("routes to the Creative Producer, then the Social agent, the Account Manager, the owner", async () => {
    const producer = world({ creative: "ag-creative", social: "ag-social", accountManager: "ag-am" });
    await requestCreativeRecord(producer.ctx, AGENT, { postId: "p-own" });
    expect(producer.created[0]).toMatchObject({ assigneeAgentId: "ag-creative" });

    const social = world({ social: "ag-social", accountManager: "ag-am" });
    expect((await requestCreativeRecord(social.ctx, AGENT, { postId: "p-own" })).assignedTo).toBe("social");
    expect(social.created[0]).toMatchObject({ assigneeAgentId: "ag-social" });

    const am = world({ accountManager: "ag-am" });
    expect((await requestCreativeRecord(am.ctx, AGENT, { postId: "p-own" })).assignedTo).toBe("account-manager");
    expect(am.created[0]).toMatchObject({ assigneeAgentId: "ag-am" });

    const nobody = world();
    expect((await requestCreativeRecord(nobody.ctx, AGENT, { postId: "p-own" })).assignedTo).toBe("person");
    expect(nobody.created[0]).toMatchObject({ assigneeUserId: "owner-1" });
  });

  it("keeps two scopes apart: each post gets its own issue, project text and claim", async () => {
    const w = world({ social: "ag-social" });
    const own = await requestCreativeRecord(w.ctx, AGENT, { postId: "p-own" });
    const acme = await requestCreativeRecord(w.ctx, AGENT, { postId: "p-acme" });
    expect(own.issueId).not.toBe(acme.issueId);
    const [ownIssue, acmeIssue] = w.created as Array<{ originId: string; description: string; title: string }>;
    expect(ownIssue.originId).toBe("creative:p-own");
    expect(ownIssue.description).toContain("own work");
    expect(ownIssue.description).not.toContain("Acme");
    expect(ownIssue.description).toContain("LinkedIn");
    expect(acmeIssue.originId).toBe("creative:p-acme");
    expect(acmeIssue.description).not.toContain("LinkedIn");
    expect([...w.handoffs.keys()].sort()).toEqual([creativeClaimKey("co", "p-acme"), creativeClaimKey("co", "p-own")].sort());
  });

  it("refuses a post of another company, a published post, a bad format and a video over 30 s", async () => {
    const w = world({ social: "ag-social" });
    await expect(requestCreativeRecord(w.ctx, { ...AGENT, companyId: "other" }, { postId: "p-acme" })).rejects.toThrow(/not visible/);
    await expect(requestCreativeRecord(w.ctx, AGENT, { postId: "p-acme", format: "gif" })).rejects.toThrow(/format/);
    await expect(requestCreativeRecord(w.ctx, AGENT, { postId: "p-acme", format: "video", durationS: 45 })).rejects.toThrow(/1 to 30/);
    const published = world({}, { status: "published" });
    await expect(requestCreativeRecord(published.ctx, AGENT, { postId: "p-own" })).rejects.toThrow(/published/);
    expect(w.created).toHaveLength(0);
  });
});
