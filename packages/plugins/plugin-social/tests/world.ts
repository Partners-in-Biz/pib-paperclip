/**
 * An in-memory world for the approval tests: the posts, destinations, accounts, approval policies, review outcomes and client
 * approval links that approval-flow.ts and client-approval.ts read and write, behind the host SQL guard copy (`fakeCtx`),
 * plus host issues, the Cockpit roles and the CRM projection. Statements are recognised by their text, like the other specs.
 */
import { vi } from "vitest";
import type { AccountRow, PostRow } from "../src/db.js";
import { NAMESPACE } from "../src/namespace.js";
import { fakeCtx } from "./helpers.js";

export const T = (name: string) => `${NAMESPACE}.${name}`;

export interface WorldOptions {
  /** Reviewer agent id in the Cockpit roles (null: none). */
  reviewer?: string | null;
  /** The Social agent (linked through the hire flow). */
  socialAgent?: string | null;
  policy?: { require_reviewer?: boolean; require_owner?: boolean; require_client?: boolean; link_expiry_days?: number } | null;
  client?: { kind: "company" | "contact"; id: string; name: string } | null;
  reviewIssue?: string | null;
  scheduledAt?: string | null;
  /** The approval page health answer (`/health`). */
  pageOk?: boolean;
  contacts?: Array<{ id: string; name: string; emails: string[]; account_ids: string[] }>;
  /** Paperclip projects the CRM linked to the client (`client.projects.updated`), newest list wins. */
  clientProjects?: string[];
  /** Projects the host reports as archived (needs the projects.read capability). */
  archivedProjects?: string[];
  /** The Account Manager agent in the Cockpit team roles (who drafts the client's email). */
  accountManager?: string | null;
  config?: Record<string, unknown>;
}

export function account(id: string, extra: Partial<AccountRow> = {}): AccountRow {
  return {
    id, company_id: "co", platform: "linkedin", scope: "org", owner_user_id: null, status: "connected", secret_ref: null, display_name: "Acme Page",
    external_id: "ext", handle: null, avatar_url: null, token_enc: "v1.x", refresh_token_enc: null, token_expires_at: null, scopes: [],
    client_kind: null, client_ref: null, client_name: null, last_error: null, meta: {}, key_version: 1, created_by_user_id: "user-1",
    reconnect_issue_id: null, last_refreshed_at: null, created_at: new Date(), updated_at: new Date(), ...extra,
  } as AccountRow;
}

export function approvalWorld(opts: WorldOptions = {}) {
  const client = opts.client === undefined ? { kind: "company" as const, id: "c1", name: "Acme" } : opts.client;
  const post: Record<string, unknown> = {
    id: "p1", company_id: "co", body: "Spring sale starts Friday. Come and see.", overrides: {}, media: [], status: "review", scheduled_at: opts.scheduledAt ?? null, scope: "org",
    owner_user_id: "owner-1", client_kind: client?.kind ?? null, client_ref: client?.id ?? null, client_name: client?.name ?? null, first_comment: null, source: "agent",
    source_ref: null, failure_issue_id: null, published_at: null, error: null, created_by_agent_id: "ag-social", review_issue_id: opts.reviewIssue ?? null, review_returns: 0,
    created_at: new Date(), updated_at: new Date(),
  };
  const dest = { id: "d1", company_id: "co", post_id: "p1", account_id: "a1", status: "pending", attempts: 0 };
  const acct = account("a1", { client_kind: client?.kind ?? null, client_ref: client?.id ?? null, client_name: client?.name ?? null });
  let policy: Record<string, unknown> | null = opts.policy
    ? { scope_key: client ? `${client.kind}:${client.id}` : "own", require_reviewer: false, require_owner: true, require_client: false, link_expiry_days: 14, updated_by: "owner-1", updated_at: new Date(), ...opts.policy }
    : null;
  const outcomes: Array<Record<string, unknown>> = [];
  const links: Array<Record<string, unknown>> = [];
  const created: Array<Record<string, unknown>> = [];
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const comments: Array<{ id: string; body: string }> = [];
  const wakeups: string[] = [];
  const logs: string[] = [];
  const issueStatus: Record<string, string> = {};
  let reviewIssue = opts.reviewIssue ?? null;
  const socialAgent = opts.socialAgent === undefined ? "ag-social" : opts.socialAgent;

  const ctx = fakeCtx(
    {
      state: {
        get: vi.fn(async (key: { namespace?: string; stateKey: string }) => {
          if (key.namespace === "pib-cockpit" && key.stateKey === "roles") {
            return { companyId: "co", operatorAgentId: "ag-op", operatorStatus: "idle", reviewerAgentId: opts.reviewer ?? null, reviewerStatus: opts.reviewer ? "idle" : null, ownerUserId: "owner-1", reviewOutward: Boolean(opts.reviewer), team: opts.accountManager ? { "account-manager": { agentId: opts.accountManager, status: "idle" } } : {}, updatedAt: "2026-10-01T00:00:00Z" };
          }
          if (key.namespace === "pib-hire") return socialAgent ? { agentId: socialAgent } : null;
          if (key.namespace === "pib-kit" && key.stateKey === "client-projects:company:c1" && opts.clientProjects) return { projectIds: opts.clientProjects, updatedAt: "2026-10-03T00:00:00Z" };
          if (key.stateKey === "plugin-ui-base") return "/_plugins/e588ce00-a14b-49fc-b62d-54b0208daafa/ui/";
          return null;
        }),
        set: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
      },
      config: { get: vi.fn(async () => ({ publicBaseUrl: "https://paperclip.partnersinbiz.online", ...(opts.config ?? {}) })) },
      companies: { get: vi.fn(async () => ({ id: "co", name: "Partners in Biz", issuePrefix: "PIB", defaultResponsibleUserId: "boss-1" })) },
      agents: { get: vi.fn(async (id: string) => ({ id, status: "idle" })), managed: { get: vi.fn(async () => ({ agentId: null })) } },
      projects: {
        managed: { get: vi.fn(async () => ({ projectId: "proj-social" })) },
        get: vi.fn(async (id: string) => ({ id, archivedAt: opts.archivedProjects?.includes(id) ? "2026-09-01T00:00:00Z" : null })),
      },
      http: { fetch: vi.fn(async () => (opts.pageOk === false ? new Response("down", { status: 502 }) : new Response("ok", { status: 200 }))) },
      issues: {
        get: vi.fn(async (id: string) => ({ id, status: issueStatus[id] ?? "todo", assigneeAgentId: null, assigneeUserId: null })),
        create: vi.fn(async (input: Record<string, unknown>) => {
          created.push(input);
          return { id: `iss-${created.length}` };
        }),
        update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
          updates.push({ id, patch });
          if (typeof patch.status === "string") issueStatus[id] = patch.status;
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
      logger: { info: (message: string) => void logs.push(message), warn: () => undefined, error: () => undefined, debug: () => undefined },
    },
    {
      queryResult: (sql, params) => {
        if (sql.startsWith("SELECT review_issue_id")) return [{ review_issue_id: reviewIssue }];
        if (sql.includes(`FROM ${T("posts")} WHERE id = $1`)) return [{ ...post, review_issue_id: reviewIssue }];
        if (sql.includes(`FROM ${T("posts")} WHERE company_id = $1 AND status = $2`)) return post.status === params[1] ? [{ ...post, review_issue_id: reviewIssue }] : [];
        if (sql.includes(`FROM ${T("destinations")} WHERE post_id = $1`)) return [dest];
        if (sql.includes(`FROM ${T("accounts")} WHERE company_id = $1 AND id = ANY`)) return [acct];
        if (sql.includes(`FROM ${T("accounts")} WHERE id = $1`)) return [acct];
        if (sql.includes(`FROM ${T("approval_policies")}`)) return policy && policy.scope_key === params[1] ? [policy] : [];
        if (sql.includes("SELECT COALESCE(MAX(round), 0)")) {
          const rounds = outcomes.filter((o) => o.post_id === params[0] && o.stage === params[2]).map((o) => Number(o.round));
          return [{ n: rounds.length ? Math.max(...rounds) : 0 }];
        }
        if (sql.includes(`FROM ${T("review_outcomes")}`) && sql.includes("WHERE post_id = $1")) {
          return outcomes.filter((o) => o.post_id === params[0]).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || Number(b.round) - Number(a.round));
        }
        if (sql.includes(`FROM ${T("crm_contacts")}`)) return (opts.contacts ?? []).filter((c) => (sql.includes("= ANY(account_ids)") ? c.account_ids.includes(String(params[1])) : sql.includes("id = ANY") ? params[1] != null && String(params[1]).includes(c.id) : true));
        if (sql.includes(`FROM ${T("crm_companies")}`)) return client?.kind === "company" ? [{ id: client.id, name: client.name, domain: "acme.test", lifecycle: "customer" }] : [];
        if (sql.includes(`FROM ${T("client_approvals")}`) && sql.includes("status = 'pending' AND content_hash = $3")) {
          return [{ n: String(links.filter((l) => l.post_id === params[0] && l.status === "pending" && l.content_hash === params[2] && Date.parse(String(l.expires_at)) > Date.now()).length) }];
        }
        if (sql.includes(`SELECT DISTINCT company_id FROM ${T("client_approvals")}`)) return links.length ? [{ company_id: "co" }] : [];
        if (sql.includes(`FROM ${T("client_approvals")}`) && sql.includes("WHERE post_id = $1 AND company_id = $2 ORDER BY created_at DESC")) {
          return links.filter((l) => l.post_id === params[0]).map((l) => ({ ...l })).reverse();
        }
        if (sql.includes(`FROM ${T("client_approvals")}`) && sql.includes("answered_at IS NOT NULL AND notified_at IS NULL AND status IN")) {
          return links.filter((l) => l.answered_at && !l.notified_at && ["approved", "changes_requested"].includes(String(l.status))).map((l) => ({ ...l }));
        }
        if (sql.includes(`FROM ${T("client_approvals")}`) && sql.includes("status = 'pending' AND expires_at < now()")) {
          return links.filter((l) => l.status === "pending" && Date.parse(String(l.expires_at)) < Date.now()).map((l) => ({ ...l }));
        }
        return [];
      },
      executeResult: (sql, params) => {
        if (sql.startsWith(`UPDATE ${T("posts")}`) && sql.includes("status = ANY(")) {
          const from = JSON.parse(String(params[5])) as string[];
          if (!from.includes(String(post.status))) return 0;
          post.status = params[2];
          if (params[3] === true) post.scheduled_at = params[4];
          return 1;
        }
        if (sql.includes("SET schedule_issue_id = $3")) {
          post.schedule_issue_id = params[2];
          return 1;
        }
        if (sql.includes("SET review_issue_id = $3")) {
          reviewIssue = String(params[2]);
          return 1;
        }
        if (sql.includes("SET review_issue_id = NULL")) {
          reviewIssue = null;
          return 1;
        }
        if (sql.includes("review_returns = review_returns + 1")) {
          post.review_returns = Number(post.review_returns) + 1;
          return 1;
        }
        if (sql.startsWith(`INSERT INTO ${T("review_outcomes")}`)) {
          const row = { id: params[0], post_id: params[2], stage: params[3], outcome: params[4], round: params[5], content_hash: params[6], post_type: params[7], format: params[8], source: params[9], platforms: params[10], via: params[13], actor_user_id: params[14], actor_agent_id: params[15], actor_name: params[16], note: params[17], created_at: new Date(Date.now() + outcomes.length).toISOString() };
          if (outcomes.some((o) => o.post_id === row.post_id && o.stage === row.stage && o.round === row.round)) return 0;
          outcomes.push(row);
          return 1;
        }
        if (sql.startsWith(`INSERT INTO ${T("approval_policies")}`)) {
          policy = { scope_key: params[1], require_reviewer: params[5], require_owner: params[6], require_client: params[7], link_expiry_days: params[8], updated_by: params[9], updated_at: new Date() };
          return 1;
        }
        if (sql.startsWith(`INSERT INTO ${T("client_approvals")}`)) {
          links.push({ id: params[0], company_id: params[1], post_id: params[2], token_hash: params[3], client_kind: params[4], client_ref: params[5], client_name: params[6], recipient_email: params[7], content_hash: params[8], snapshot: JSON.parse(String(params[9])), expires_at: params[10], created_by: params[11], issue_id: params[12], status: "pending", created_at: new Date().toISOString(), answered_at: null, notified_at: null, applied: null, answered_by_name: null, answer_note: null });
          return 1;
        }
        if (sql.includes(`UPDATE ${T("client_approvals")} SET status = 'superseded'`)) {
          let n = 0;
          for (const l of links) if (l.post_id === params[0] && l.status === "pending") (l.status = "superseded", (n += 1));
          return n;
        }
        if (sql.includes(`UPDATE ${T("client_approvals")} SET notified_at = now()`)) {
          const l = links.find((x) => x.id === params[0] && !x.notified_at);
          if (!l) return 0;
          l.notified_at = new Date().toISOString();
          return 1;
        }
        if (sql.includes(`UPDATE ${T("client_approvals")} SET notified_at = NULL`)) {
          const l = links.find((x) => x.id === params[0]);
          if (l) l.notified_at = null;
          return l ? 1 : 0;
        }
        if (sql.includes(`UPDATE ${T("client_approvals")} SET applied = $3`)) {
          const l = links.find((x) => x.id === params[0]);
          if (l) l.applied = params[2];
          return l ? 1 : 0;
        }
        if (sql.includes(`UPDATE ${T("client_approvals")} SET status = 'expired'`)) {
          const l = links.find((x) => x.id === params[0] && x.status === "pending");
          if (!l) return 0;
          l.status = "expired";
          return 1;
        }
        return 1;
      },
    },
  );
  /** What the public approval service does when a client answers (writes only the answer columns). */
  const answer = (id: string, status: "approved" | "changes_requested", name: string | null, note: string | null) => {
    const l = links.find((x) => x.id === id)!;
    l.status = status;
    l.answered_by_name = name;
    l.answer_note = note;
    l.answered_at = new Date().toISOString();
    l.notified_at = null;
  };
  return { ctx, post, outcomes, links, created, updates, comments, wakeups, logs, answer, reviewIssueId: () => reviewIssue, policy: () => policy, setIssueStatus: (id: string, status: string) => void (issueStatus[id] = status), dest };
}

export const PERSON = { companyId: "co", userId: "owner-1", agentId: null, runId: null, isAgent: false } as const;
export const SOCIAL_AGENT = { companyId: "co", userId: "owner-1", agentId: "ag-social", runId: "run-1", isAgent: true } as const;
export const REVIEWER_AGENT = { companyId: "co", userId: null, agentId: "rev-1", runId: "run-2", isAgent: true } as const;

export type World = ReturnType<typeof approvalWorld>;
export const postRow = (w: World) => w.post as unknown as PostRow;
