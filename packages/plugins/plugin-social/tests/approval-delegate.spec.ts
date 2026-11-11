import { describe, expect, it } from "vitest";
import {
  activeDelegate,
  clearDelegate,
  delegateBlockers,
  delegateFacts,
  getDelegate,
  listDelegates,
  setDelegate,
  type DelegateFacts,
} from "../src/approval-delegate.js";
import { loadSocialConfig, parseDelegatableScopes, readDelegatableScopes } from "../src/config.js";
import manifest from "../src/manifest.js";
import { fakeCtx } from "./helpers.js";

const CO = "co";
const CLIENT = "0b5c3a52-9a0f-4c8e-8a1e-1d2f3a4b5c6d";
const CLIENT_SCOPE = { kind: "company" as const, id: CLIENT };
const DELEGATE = "ag-rhea";
const REVIEWER = "ag-vera";

interface HostOptions {
  allowlist?: unknown;
  configThrows?: boolean;
  policy?: { require_owner: boolean; require_client: boolean } | null;
  policyThrows?: boolean;
  agents?: Record<string, { id: string; companyId: string; status: string }>;
  agentThrows?: boolean;
  reviewerAgentId?: string | null;
  rolesThrow?: boolean;
  prefs?: Record<string, unknown>;
}

/** An in-memory host: state rows, settings form, agents, roles and the policy table. */
function host(opts: HostOptions = {}) {
  const rows = new Map<string, unknown>();
  const key = (k: { scopeId?: string; namespace?: string; stateKey?: string }) => `${k.scopeId}|${k.namespace}|${k.stateKey}`;
  const io = { readThrows: false, setCalls: 0, setOverride: null as null | ((v: unknown) => unknown) };
  const agents = opts.agents ?? { [DELEGATE]: { id: DELEGATE, companyId: CO, status: "idle" }, [REVIEWER]: { id: REVIEWER, companyId: CO, status: "active" } };
  if (opts.prefs) rows.set(`${CO}|preferences|v1`, { values: opts.prefs, updatedBy: "u1", updatedAt: "2026-11-01T00:00:00Z" });
  const ctx = fakeCtx(
    {
      config: {
        get: async () => {
          if (opts.configThrows) throw new Error("config down");
          return { delegatableScopes: opts.allowlist ?? ["own", `company:${CLIENT}`] };
        },
      },
      agents: {
        get: async (id: string) => {
          if (opts.agentThrows) throw new Error("agents down");
          return agents[id] ?? null;
        },
      },
      state: {
        get: async (k: { scopeId?: string; namespace?: string; stateKey?: string }) => {
          if (k.namespace === "pib-cockpit" && k.stateKey === "roles") {
            if (opts.rolesThrow) throw new Error("roles down");
            return { companyId: CO, operatorAgentId: null, reviewerAgentId: opts.reviewerAgentId === undefined ? REVIEWER : opts.reviewerAgentId, reviewerStatus: "paused", ownerUserId: "u1", reviewOutward: true, updatedAt: "2026-11-01T00:00:00Z" };
          }
          if (k.namespace === "social-approval" && io.readThrows) throw new Error("state down");
          return rows.get(key(k)) ?? null;
        },
        set: async (k: { scopeId?: string; namespace?: string; stateKey?: string }, v: unknown) => {
          io.setCalls++;
          rows.set(key(k), io.setOverride ? io.setOverride(v) : v);
        },
        delete: async () => undefined,
      },
    },
    {
      queryResult: (sql) => {
        if (!sql.includes("approval_policies")) return [];
        if (opts.policyThrows) throw new Error("db down");
        const p = opts.policy === undefined ? { require_owner: true, require_client: false } : opts.policy;
        return p ? [{ scope_key: "own", require_reviewer: true, link_expiry_days: 14, updated_by: "u1", updated_at: null, ...p }] : [];
      },
    },
  );
  return { ctx, rows, io };
}

const STORED = `${CO}|social-approval|delegates`;

describe("delegate store", () => {
  it("set, list and clear round-trip", async () => {
    const { ctx } = host();
    await setDelegate(ctx, CO, null, DELEGATE, "u1", new Date("2026-11-11T10:00:00Z"));
    await setDelegate(ctx, CO, CLIENT_SCOPE, "ag-2", "u2", new Date("2026-11-11T11:00:00Z"));
    expect(await getDelegate(ctx, CO, null)).toEqual({ agentId: DELEGATE, setBy: "u1", setAt: "2026-11-11T10:00:00.000Z" });
    expect(Object.keys(await listDelegates(ctx, CO)).sort()).toEqual(["company:" + CLIENT, "own"]);
    const after = await clearDelegate(ctx, CO, null, "u1");
    expect(after).toEqual({ [`company:${CLIENT}`]: { agentId: "ag-2", setBy: "u2", setAt: "2026-11-11T11:00:00.000Z" } });
    expect(await getDelegate(ctx, CO, null)).toBeNull();
  });

  it("a read error on set refuses and writes nothing; other scopes stay", async () => {
    const { ctx, rows, io } = host();
    await setDelegate(ctx, CO, CLIENT_SCOPE, "ag-2", "u2");
    const before = structuredClone(rows.get(STORED));
    io.readThrows = true;
    io.setCalls = 0;
    await expect(setDelegate(ctx, CO, null, DELEGATE, "u1")).rejects.toThrow(/could not be read, so nothing was changed/);
    expect(io.setCalls).toBe(0);
    expect(rows.get(STORED)).toEqual(before);
  });

  it("a read error on clear refuses and writes nothing; other scopes stay", async () => {
    const { ctx, rows, io } = host();
    await setDelegate(ctx, CO, null, DELEGATE, "u1");
    await setDelegate(ctx, CO, CLIENT_SCOPE, "ag-2", "u2");
    const before = structuredClone(rows.get(STORED));
    io.readThrows = true;
    io.setCalls = 0;
    await expect(clearDelegate(ctx, CO, null, "u1")).rejects.toThrow(/nothing was changed/);
    expect(io.setCalls).toBe(0);
    expect(rows.get(STORED)).toEqual(before);
  });

  it("a write that lands but reads back different is refused (set and clear)", async () => {
    const { ctx, io } = host();
    io.setOverride = (v) => ({ ...(v as object), own: { agentId: "someone-else", setBy: "u9", setAt: "2026-01-01T00:00:00Z" } });
    await expect(setDelegate(ctx, CO, null, DELEGATE, "u1")).rejects.toThrow(/did not save/);
    await expect(clearDelegate(ctx, CO, null, "u1")).rejects.toThrow(/still set/);
  });

  it("a read-back that throws is refused", async () => {
    const { ctx, io } = host();
    io.setOverride = (v) => {
      io.readThrows = true;
      return v;
    };
    await expect(setDelegate(ctx, CO, null, DELEGATE, "u1")).rejects.toThrow(/could not be read back/);
  });

  it("an unreadable store means no delegate, and reads never throw", async () => {
    const { ctx, io } = host();
    await setDelegate(ctx, CO, null, DELEGATE, "u1");
    io.readThrows = true;
    expect(await getDelegate(ctx, CO, null)).toBeNull();
    expect(await listDelegates(ctx, CO)).toEqual({});
    expect(await activeDelegate(ctx, CO, null)).toBeNull();
  });

  it("drops malformed stored entries", async () => {
    const { ctx, rows } = host();
    rows.set(STORED, { own: { agentId: DELEGATE }, "company:x": "nope", [`company:${CLIENT}`]: { agentId: "ag-2", setBy: "u2", setAt: "2026-11-11T00:00:00Z" } });
    expect(Object.keys(await listDelegates(ctx, CO))).toEqual([`company:${CLIENT}`]);
  });
});

const OK: DelegateFacts = {
  companyId: CO,
  scope: null,
  policy: { requireOwner: true, requireClient: false },
  agent: { id: DELEGATE, companyId: CO, status: "idle" },
  configuredReviewerId: REVIEWER,
  allowlist: ["own"],
};

describe("delegateBlockers", () => {
  it("none for an allowlisted own scope, an owner policy and an active agent", () => {
    expect(delegateBlockers(OK)).toEqual([]);
  });

  const cases: Array<[string, Partial<DelegateFacts>, RegExp]> = [
    ["off the allowlist", { allowlist: [`company:${CLIENT}`] }, /not on the delegatable scopes list/],
    ["a contact scope", { scope: { kind: "contact", id: "c1" }, allowlist: ["own", "contact:c1"] }, /contact's scope/],
    ["a personal scope", { scope: "personal" }, /personal post/],
    ["a client policy", { policy: { requireOwner: true, requireClient: true } }, /asks the client/],
    ["owner not required", { policy: { requireOwner: false, requireClient: false } }, /nothing to delegate/],
    ["an unreadable policy", { policy: null }, /policy could not be read/],
    ["an agent of another company", { agent: { id: DELEGATE, companyId: "other", status: "idle" } }, /another company/],
    ["an agent not found", { agent: null }, /not found/],
    ["a paused agent", { agent: { id: DELEGATE, companyId: CO, status: "paused" } }, /is paused/],
    ["a terminated agent", { agent: { id: DELEGATE, companyId: CO, status: "terminated" } }, /is terminated/],
    ["an archived agent", { agent: { id: DELEGATE, companyId: CO, status: "archived" } }, /is archived/],
    ["the configured Reviewer", { agent: { id: REVIEWER, companyId: CO, status: "active" } }, /Reviewer checks the post/],
    ["unreadable roles", { configuredReviewerId: undefined }, /roles could not be read/],
  ];
  for (const [name, patch, reason] of cases) {
    it(`blocks ${name}`, () => {
      const reasons = delegateBlockers({ ...OK, ...patch });
      expect(reasons.length).toBeGreaterThan(0);
      expect(reasons.join(" ")).toMatch(reason);
    });
  }

  it("the configured Reviewer is blocked while it is paused (roles say paused; the running Reviewer would be null)", async () => {
    const { ctx } = host({ agents: { [REVIEWER]: { id: REVIEWER, companyId: CO, status: "active" } } });
    const facts = await delegateFacts(ctx, CO, null, REVIEWER);
    expect(facts.configuredReviewerId).toBe(REVIEWER);
    expect(delegateBlockers(facts).join(" ")).toMatch(/Reviewer checks the post/);
  });

  it("each failed read becomes a reason", async () => {
    const { ctx } = host({ policyThrows: true, agentThrows: true, rolesThrow: true, configThrows: true });
    const reasons = delegateBlockers(await delegateFacts(ctx, CO, null, DELEGATE)).join(" ");
    for (const r of [/policy could not be read/, /not found/, /roles could not be read/, /not on the delegatable scopes list/]) expect(reasons).toMatch(r);
  });
});

describe("activeDelegate", () => {
  it("is the stored agent when nothing blocks it", async () => {
    const { ctx } = host();
    await setDelegate(ctx, CO, null, DELEGATE, "u1");
    expect(await activeDelegate(ctx, CO, null)).toBe(DELEGATE);
  });

  it("is null once the scope leaves the allowlist", async () => {
    const opts: HostOptions = { allowlist: ["own"] };
    const { ctx } = host(opts);
    await setDelegate(ctx, CO, null, DELEGATE, "u1");
    expect(await activeDelegate(ctx, CO, null)).toBe(DELEGATE);
    opts.allowlist = [];
    expect(await activeDelegate(ctx, CO, null)).toBeNull();
  });

  it("is null while the agent is paused, or the policy is unreadable", async () => {
    const paused = host({ agents: { [DELEGATE]: { id: DELEGATE, companyId: CO, status: "paused" } } });
    await setDelegate(paused.ctx, CO, null, DELEGATE, "u1");
    expect(await activeDelegate(paused.ctx, CO, null)).toBeNull();
    const noPolicy = host({ policyThrows: true });
    await setDelegate(noPolicy.ctx, CO, null, DELEGATE, "u1");
    expect(await activeDelegate(noPolicy.ctx, CO, null)).toBeNull();
  });
});

describe("delegatableScopes allowlist", () => {
  it("keeps own and company:<uuid> only, lower case, once", () => {
    expect(parseDelegatableScopes(["own", " OWN ", `company:${CLIENT.toUpperCase()}`, "contact:c1", "company:not-a-uuid", "personal", 7, null])).toEqual(["own", `company:${CLIENT}`]);
    expect(parseDelegatableScopes("own")).toEqual([]);
    expect(parseDelegatableScopes(undefined)).toEqual([]);
  });

  it("an empty list and a config read that throws both make every scope non-delegatable", async () => {
    for (const opts of [{ allowlist: [] }, { configThrows: true }] as HostOptions[]) {
      const { ctx } = host(opts);
      expect(await readDelegatableScopes(ctx, CO)).toEqual([]);
      for (const scope of [null, CLIENT_SCOPE]) {
        expect(delegateBlockers(await delegateFacts(ctx, CO, scope, DELEGATE)).join(" ")).toMatch(/not on the delegatable scopes list/);
      }
    }
  });

  it("a saved company preference named delegatableScopes cannot widen the list", async () => {
    const { ctx } = host({ allowlist: [], prefs: { delegatableScopes: ["own", `company:${CLIENT}`] } });
    expect(await readDelegatableScopes(ctx, CO)).toEqual([]);
    expect((await loadSocialConfig(ctx, CO)).delegatableScopes).toEqual([]);
    await setDelegate(ctx, CO, null, DELEGATE, "u1");
    expect(await activeDelegate(ctx, CO, null)).toBeNull();
  });

  it("is a host settings field with the admin-only description", () => {
    const schema = manifest.instanceConfigSchema as { properties: Record<string, { type?: string; description?: string }> };
    expect(schema.properties.delegatableScopes).toMatchObject({ type: "array" });
    expect(schema.properties.delegatableScopes!.description).toContain("Scopes where a person may name a delegated approver. Only an instance admin saves this. Own brands only.");
  });
});
