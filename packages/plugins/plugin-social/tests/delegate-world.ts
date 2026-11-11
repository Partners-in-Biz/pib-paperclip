/** Shared world for the delegated approver's tool specs (PAR-9561). */
import { contentHashOf } from "../src/content-hash.js";
import { approvalWorld, postRow, T } from "./world.js";

const HOUR = 3_600_000;

export const BRAND_ID = "0b5c3a52-9a0f-4c8e-8a1e-1d2f3a4b5c6d";
export const BRAND = `company:${BRAND_ID}`;
export const RHEA = { companyId: "co", userId: "owner-1", agentId: "ag-rhea", runId: "run-3", isAgent: true } as const;
export const OTHER = { companyId: "co", userId: null, agentId: "ag-other", runId: "run-4", isAgent: true } as const;

interface Opts {
  policy?: Record<string, unknown>;
  allowlist?: string[];
  delegate?: string | null;
  setAt?: string;
}

/** A brand scope with Rhea as its delegate (named an hour before the post was created), and Vera (rev-1) as the Reviewer. */
export function delegateWorld(opts: Opts = {}) {
  const w = approvalWorld({ client: { kind: "company", id: BRAND_ID, name: "PiB Brand" }, reviewer: "rev-1", reviewIssue: "iss-9", policy: { require_reviewer: true, ...opts.policy }, config: { delegatableScopes: opts.allowlist ?? [BRAND] } });
  const delegate = opts.delegate === undefined ? "ag-rhea" : opts.delegate;
  const store = new Map<string, unknown>();
  if (delegate) store.set("delegates", { [BRAND]: { agentId: delegate, setBy: "owner-1", setAt: opts.setAt ?? new Date(Date.now() - HOUR).toISOString() } });
  const io = { stateThrows: false, policyThrows: false, outcomeInsert: "ok" as "ok" | "throws" | "lost", raceOnInsert: false };
  const ctx = w.ctx as unknown as { state: Record<string, unknown>; agents: Record<string, unknown>; db: Record<string, unknown> };
  const baseGet = ctx.state.get as (key: unknown) => Promise<unknown>;
  ctx.state.get = async (key: { namespace?: string; stateKey: string }) => {
    if (key.namespace === "social-approval") {
      if (io.stateThrows) throw new Error("state down");
      return store.get(key.stateKey) ?? null;
    }
    return baseGet(key);
  };
  const baseSet = ctx.state.set as (key: unknown, value: unknown) => Promise<unknown>;
  ctx.state.set = async (key: { namespace?: string; stateKey: string }, value: unknown) => {
    if (key.namespace === "social-approval") return void store.set(key.stateKey, value);
    return baseSet(key, value);
  };
  const agents = ["ag-rhea", "rev-1", "ag-social", "ag-other"].map((id) => ({ id, companyId: "co", name: id, status: "idle" }));
  ctx.agents = { ...ctx.agents, get: async (id: string) => agents.find((a) => a.id === id) ?? null, list: async () => agents };
  const baseQuery = ctx.db.query as (sql: string, params: unknown[]) => Promise<unknown[]>;
  const baseExecute = ctx.db.execute as (sql: string, params: unknown[]) => Promise<{ rowCount: number }>;
  ctx.db.query = async (sql: string, params: unknown[]) => {
    if (io.policyThrows && sql.includes(T("approval_policies"))) throw new Error("db down");
    return baseQuery(sql, params);
  };
  ctx.db.execute = async (sql: string, params: unknown[]) => {
    if (sql.startsWith(`INSERT INTO ${T("review_outcomes")}`) && params[3] === "owner") {
      if (io.outcomeInsert === "throws") throw new Error("disk full");
      if (io.outcomeInsert === "lost") return { rowCount: 0 };
      if (io.raceOnInsert) w.post.status = "draft";
    }
    return baseExecute(sql, params);
  };
  const hash = () => contentHashOf(postRow(w), w.destinations.map((d) => d.account_id));
  /** A Reviewer row written straight into the ledger (round 1 unless given). */
  const pass = (extra: Record<string, unknown> = {}) =>
    void w.outcomes.push({ id: `o${w.outcomes.length}`, post_id: "p1", stage: "reviewer", outcome: "approved", round: w.outcomes.length + 1, content_hash: hash(), via: "tool", actor_agent_id: "rev-1", created_at: new Date().toISOString(), ...extra });
  const ownerRows = () => w.outcomes.filter((o) => o.stage === "owner");
  return { ...w, store, io, pass, hash, ownerRows };
}
