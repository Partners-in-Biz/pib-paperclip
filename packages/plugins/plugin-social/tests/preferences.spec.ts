import { describe, expect, it } from "vitest";
import { loadSocialConfig } from "../src/config.js";
import manifest from "../src/manifest.js";
import { approvalIssueDescription, programLabel } from "../src/growth/copy.js";
import { loadPreferencesAction, ownSocialName, savePreferencesAction } from "../src/preferences.js";
import plugin from "../src/worker.js";
import { fakeCtx } from "./helpers.js";

const PAR = "co-par";
const ACME = "co-acme";
const NAMES: Record<string, string> = { [PAR]: "Partners in Biz", [ACME]: "Acme Ltd" };

/** An in-memory host: per-company saved settings, the state table, company names and members. */
function host(settings: Record<string, Record<string, unknown>> = {}, members: Array<Record<string, unknown>> = []) {
  const rows = new Map<string, unknown>();
  const key = (k: { scopeId?: string; namespace?: string; stateKey?: string }) => `${k.scopeId}|${k.namespace}|${k.stateKey}`;
  const ctx = fakeCtx({
    config: { get: async (companyId: string) => settings[companyId] ?? {} },
    companies: { get: async (id: string) => (NAMES[id] ? { id, name: NAMES[id], issuePrefix: id === PAR ? "PAR" : "ACM" } : null) },
    access: { members: { list: async () => members } },
    state: {
      get: async (k: { scopeId?: string; namespace?: string; stateKey?: string }) => (k.stateKey === "plugin-ui-base" ? null : rows.get(key(k)) ?? null),
      set: async (k: { scopeId?: string; namespace?: string; stateKey?: string }, v: unknown) => void rows.set(key(k), v),
      delete: async () => undefined,
    },
  });
  return { ctx, rows };
}

const owner = (userId: string) => ({ principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
const viewer = (userId: string) => ({ principalType: "user", principalId: userId, membershipRole: "viewer", status: "active" });
const asUser = (companyId: string, userId: string) => ({ companyId, actor: { type: "user", userId, companyId } }) as never;
const asAgent = (companyId: string) => ({ companyId, actor: { type: "agent", agentId: "ag-1", companyId } }) as never;

describe("Social preferences: precedence", () => {
  it("saved preference beats the old host-form value, which beats the default", async () => {
    const { ctx } = host({ [ACME]: { timezone: "Europe/London", allowAgentReplies: true } }, [owner("u1")]);
    let config = await loadSocialConfig(ctx, ACME);
    expect(config.timezone).toBe("Europe/London");
    expect(config.allowAgentReplies).toBe(true);

    const saved = (await savePreferencesAction(ctx, asUser(ACME, "u1"), { patch: { timezone: "UTC", allowAgentReplies: false } })) as { ok: boolean };
    expect(saved.ok).toBe(true);
    config = await loadSocialConfig(ctx, ACME);
    expect(config.timezone).toBe("UTC");
    expect(config.allowAgentReplies).toBe(false);
  });

  it("a company with nothing saved gets the neutral defaults", async () => {
    const { ctx } = host();
    const config = await loadSocialConfig(ctx, ACME);
    expect(config.timezone).toBe("Africa/Johannesburg");
    expect(config.allowAgentReplies).toBe(false);
  });

  it("ignores a stored time zone Intl does not know, so dates keep formatting", async () => {
    const { ctx, rows } = host();
    rows.set(`${ACME}|preferences|v1`, { values: { timezone: "Mars/Olympus" }, updatedBy: "u1", updatedAt: "2026-10-24T00:00:00Z" });
    expect((await loadSocialConfig(ctx, ACME)).timezone).toBe("Africa/Johannesburg");
  });
});

describe("Social preferences: PAR stays unchanged", () => {
  const parSettings = { [PAR]: { ownerCompany: true, timezone: "Africa/Johannesburg", allowAgentReplies: true } };

  it("keeps PAR's values and the PiB wording", async () => {
    const { ctx, rows } = host(parSettings);
    const config = await loadSocialConfig(ctx, PAR);
    expect(config.timezone).toBe("Africa/Johannesburg");
    expect(config.allowAgentReplies).toBe(true);
    expect(await ownSocialName(ctx, PAR)).toBe("PiB");
    // Seeded once from the saved host values plus the pin.
    expect((rows.get(`${PAR}|preferences|v1`) as { values: Record<string, unknown> }).values).toEqual({ ownSocialName: "PiB", timezone: "Africa/Johannesburg", allowAgentReplies: true });
  });

  it("renders the same Growth Lab text as before for PAR", async () => {
    const { ctx } = host(parSettings);
    const name = await ownSocialName(ctx, PAR);
    expect(programLabel({ clientRef: null, clientName: null }, name)).toBe("PiB's own social");
    const body = approvalIssueDescription({ clientRef: null, clientName: null, autopilot: "safe" } as never, [], null, name);
    expect(body).toContain("**PiB's own social**");
  });

  it("an older PAR with no saved values and no flag still reads the defaults it had", async () => {
    const { ctx } = host({ [PAR]: {} });
    const config = await loadSocialConfig(ctx, PAR);
    expect(config.timezone).toBe("Africa/Johannesburg");
    expect(config.allowAgentReplies).toBe(false);
  });
});

describe("Social preferences: no PiB leaks to other companies", () => {
  it("names a client company after itself and writes no seed row", async () => {
    const { ctx, rows } = host({ [ACME]: {} });
    expect(await ownSocialName(ctx, ACME)).toBe("Acme Ltd");
    expect(programLabel({ clientRef: null, clientName: null }, "Acme Ltd")).toBe("Acme Ltd's own social");
    expect(rows.size).toBe(0);
  });

  it("falls back to a neutral name when the host gives none", async () => {
    const { ctx } = host();
    expect(await ownSocialName(ctx, "co-unknown")).toBe("Your company");
    expect(programLabel({ clientRef: null, clientName: null })).toBe("Your company's own social");
  });

  it("a client's workspace label is unchanged", () => {
    expect(programLabel({ clientRef: "company:1", clientName: "Bravo" }, "PiB")).toBe("Bravo");
  });
});

describe("Social preferences: actions", () => {
  it("load returns the fields and the effective values", async () => {
    const { ctx } = host();
    const out = await loadPreferencesAction(ctx, asUser(ACME, "u1"));
    expect(out.fields.map((f) => f.id)).toEqual(["timezone", "allowAgentReplies", "ownSocialName"]);
    expect(out.values.ownSocialName).toBe("Acme Ltd");
  });

  it("refuses a viewer, an agent and a bad time zone, and writes nothing", async () => {
    const { ctx, rows } = host({}, [viewer("u2"), owner("u1")]);
    expect(await savePreferencesAction(ctx, asUser(ACME, "u2"), { patch: { timezone: "UTC" } })).toMatchObject({ ok: false });
    expect(await savePreferencesAction(ctx, asAgent(ACME), { patch: { timezone: "UTC" } })).toMatchObject({ ok: false });
    expect(await savePreferencesAction(ctx, asUser(ACME, "u1"), { patch: { timezone: "Mars/Olympus" } })).toMatchObject({ ok: false });
    expect(await savePreferencesAction(ctx, asUser(ACME, "u1"), {})).toMatchObject({ ok: false });
    expect(rows.size).toBe(0);
  });

  it("refuses when the role check cannot run (missing capability)", async () => {
    const { ctx, rows } = host();
    (ctx as never as { access: unknown }).access = { members: { list: async () => { throw new Error('missing required capability "access.members.read"'); } } };
    expect(await savePreferencesAction(ctx, asUser(ACME, "u1"), { patch: { timezone: "UTC" } })).toMatchObject({ ok: false });
    expect(rows.size).toBe(0);
  });
});

describe("Social preferences: release gate", () => {
  it("the manifest declares access.members.read whenever the worker registers preferences-save", async () => {
    const registered = new Set<string>();
    const ctx = fakeCtx({
      tools: { register: () => undefined },
      actions: { register: (key: string) => void registered.add(key) },
      jobs: { register: () => undefined },
      events: { on: () => undefined, emit: async () => undefined },
    });
    await plugin.definition.setup(ctx);
    expect(registered.has("social.preferences-save")).toBe(true);
    expect(registered.has("social.preferences-load")).toBe(true);
    expect(manifest.capabilities).toContain("access.members.read");
    expect(manifest.capabilities).toContain("plugin.state.write");
  });
});
