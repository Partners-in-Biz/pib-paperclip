import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds } from "./helpers/hybrid.js";
import { saveRoles, type RolesRow } from "../src/db.js";
import { evaluate, type PolicyAsk } from "../src/owner-defaults-model.js";
import { readOwnerDefaults } from "../src/owner-defaults-store.js";
import { listRepairs, recordRepair } from "../src/repairs.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const OWNER = "user-owner";
const ROOT_ID = "00000000-0000-4000-8000-0000000039e3";
type Context = { companyId?: string; actor?: unknown };
const as = (actor: unknown): Context => ({ companyId: COMPANY, actor });

d("owner policy (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  async function make() {
    const w = await worlds.make();
    const now = new Date().toISOString();
    await saveRoles(w.ctx, { companyId: COMPANY, operatorAgentId: null, reviewerAgentId: null, ownerUserId: OWNER, reviewOutward: false, createdAt: now, updatedAt: now, updatedBy: null } as RolesRow);
    await w.pg.addIssueToDb({ id: ROOT_ID, companyId: COMPANY, identifier: "PAR-3983", title: "Program W1c", status: "in_progress", description: "" });
    const save = (params: Record<string, unknown>, context: Context) => w.actions.get("ownerDefaults.save")!(params, context) as Promise<{ changed: boolean; enabled: boolean }>;
    const load = (context: Context) => w.actions.get("ownerDefaults.load")!({}, context) as Promise<any>;
    const ledger = () => listRepairs(w.ctx, COMPANY, { kind: "owner_defaults" });
    return { w, save, load, ledger };
  }

  it("rejects an agent actor, even one holding the owner's id", async () => {
    const { w, save, ledger } = await make();
    await expect(save({ enabled: true }, as({ type: "agent", agentId: "op", userId: OWNER }))).rejects.toThrow(/owner/);
    expect((await readOwnerDefaults(w.ctx, COMPANY)).enabled).toBe(false);
    expect(await ledger()).toHaveLength(0);
  });

  it("rejects a board user who is not the owner", async () => {
    const { w, save, ledger } = await make();
    await expect(save({ enabled: true }, as({ type: "user", userId: "user-other" }))).rejects.toThrow(/Only the owner/);
    expect((await readOwnerDefaults(w.ctx, COMPANY)).enabled).toBe(false);
    expect(await ledger()).toHaveLength(0);
  });

  it("rejects a missing, empty, system or userless actor", async () => {
    const { w, save, ledger } = await make();
    for (const actor of [undefined, null, {}, { type: "system" }, { type: "user" }, { type: "user", userId: null }, { type: "user", userId: "" }]) {
      await expect(save({ enabled: true }, as(actor))).rejects.toThrow();
    }
    await expect(save({ enabled: true }, { actor: { type: "user", userId: OWNER } })).rejects.toThrow(/Company/);
    expect((await readOwnerDefaults(w.ctx, COMPANY)).enabled).toBe(false);
    expect(await ledger()).toHaveLength(0);
  });

  it("rejects everyone when the company has no owner", async () => {
    const { w, save } = await make();
    await saveRoles(w.ctx, { companyId: COMPANY, operatorAgentId: null, reviewerAgentId: null, ownerUserId: null, reviewOutward: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), updatedBy: null } as RolesRow);
    await expect(save({ enabled: true }, as({ type: "user", userId: "local-board" }))).rejects.toThrow(/owner/);
    await expect(save({ enabled: true }, as({ type: "user", userId: "user-other" }))).rejects.toThrow(/owner/);
  });

  it("rejects a value that is not a boolean", async () => {
    const { save } = await make();
    await expect(save({ enabled: "true" }, as({ type: "user", userId: OWNER }))).rejects.toThrow(/true or false/);
    await expect(save({}, as({ type: "user", userId: OWNER }))).rejects.toThrow(/true or false/);
  });

  it("owner enables: state saved and one ledger row", async () => {
    const { w, save, ledger } = await make();
    expect(await save({ enabled: true }, as({ type: "user", userId: OWNER }))).toEqual({ changed: true, enabled: true });
    const policy = await readOwnerDefaults(w.ctx, COMPANY);
    expect(policy).toMatchObject({ enabled: true, name: "Peet standing approval 2026-10-19", rootIssueIds: [ROOT_ID], minHours: 4 });
    expect(policy.classes).toHaveLength(4);
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "enable", targetId: "ownerDefaults", actor: `owner:${OWNER}` });
  });

  it("a repeat tap changes nothing and adds no ledger row", async () => {
    const { save, ledger } = await make();
    await save({ enabled: true }, as({ type: "user", userId: OWNER }));
    expect(await save({ enabled: true }, as({ type: "user", userId: OWNER }))).toEqual({ changed: false, enabled: true });
    expect(await ledger()).toHaveLength(1);
  });

  it("will not switch on when no issue tree of the policy exists", async () => {
    const { w, save, ledger } = await make();
    await w.client.query(`DELETE FROM public.issues WHERE id::text = $1`, [ROOT_ID]);
    await expect(save({ enabled: true }, as({ type: "user", userId: OWNER }))).rejects.toThrow(/cannot be switched on/);
    expect((await readOwnerDefaults(w.ctx, COMPANY)).enabled).toBe(false);
    expect(await ledger()).toHaveLength(0);
  });

  it("disable stops the policy from applying and writes a ledger row", async () => {
    const { w, save, ledger } = await make();
    const ask: PolicyAsk = { key: "k", issueId: "i", kind: "decision", question: "Which colour?", options: ["red", "blue"], recommended: "red", policyClass: "engineering-decision", defaultAfterHours: 4, effect: null, askedAt: "2026-10-01T00:00:00.000Z", deadlineAt: null };
    const decide = async () => evaluate({ ask, policy: await readOwnerDefaults(w.ctx, COMPANY), now: new Date("2026-10-03T00:00:00.000Z"), rootsOfIssue: [ROOT_ID] });
    await save({ enabled: true }, as({ type: "user", userId: OWNER }));
    expect((await decide()).action).toBe("apply");
    expect(await save({ enabled: false }, as({ type: "user", userId: OWNER }))).toEqual({ changed: true, enabled: false });
    expect(await decide()).toEqual({ action: "escalate", reason: "Policy not enabled" });
    expect((await ledger()).map((r) => r.action).sort()).toEqual(["disable", "enable"]);
  });

  it("an agent cannot write the policy through the load action's reply or any tool", async () => {
    const { w, load } = await make();
    await expect(load(as({ type: "agent", agentId: "op" }))).rejects.toThrow();
    expect([...w.tools.keys()].filter((name) => /owner-?defaults|policy/i.test(name))).toEqual([]);
  });

  it("load: the owner can change it, another board user only reads; applied answers list", async () => {
    const { w, load } = await make();
    await recordRepair(w.ctx, COMPANY, { kind: "ask_deadline", targetKind: "ask", targetId: "ask-1", action: "apply_default", outcome: "applied", detail: "Applied by policy: red", actor: "cockpit-ask-deadlines" });
    const owner = await load(as({ type: "user", userId: OWNER }));
    expect(owner.canChange).toBe(true);
    expect(owner.enabled).toBe(false);
    expect(owner.proposal.roots).toEqual([{ identifier: "PAR-3983", issueId: ROOT_ID }]);
    expect(owner.proposal.exclusions.length).toBeGreaterThan(3);
    expect(owner.applied).toHaveLength(1);
    expect(owner.applied[0]).toMatchObject({ askId: "ask-1", answer: "Applied by policy: red" });
    expect((await load(as({ type: "user", userId: "user-other" }))).canChange).toBe(false);
  });
});
