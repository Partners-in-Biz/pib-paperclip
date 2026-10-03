/**
 * A company created after the plugins were installed (Q2-8): the Cockpit syncs
 * its skills and opens ONE "Set up <company>" issue for the owner, for a
 * company whose Cockpit settings were never saved, without staffing or
 * configuring anything, and without doubling an issue another plugin opened.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { knownCompanyIds } from "@partnersinbiz/pib-plugin-kit";
import { ensureSetupIssue, SETUP_ISSUE_DELAY_MS, SETUP_ISSUE_ORIGIN_ID } from "../src/bootstrap.js";
import { ORIGIN } from "../src/constants.js";
import { NAMESPACE } from "../src/namespace.js";
import { saveTeam } from "../src/roles.js";
import { embeddedAvailable } from "./helpers/pg.js";
import { startWorlds, type Hybrid } from "./helpers/hybrid.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const NEW = "33333333-3333-4333-8333-333333333333";
const OP = "aaaaaaaa-0000-4000-8000-0000000000a1";
const SETUP_ORIGIN = "plugin:partnersinbiz.setup:setup";

d("a new company (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  /** A world where NEW has no saved Cockpit settings and no roles: the case that used to be invisible. */
  async function make() {
    const w = await worlds.make({ savedConfigs: {}, prefixes: { [NEW]: "NEW" }, agents: [{ id: OP, companyId: NEW, name: "Olive", status: "active", role: "general" }] });
    const sleeps: number[] = [];
    w.env.sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    return Object.assign(w, { sleeps });
  }
  const created = (w: Hybrid, companyId = NEW) => w.fire("company.created", { companyId });
  const setupIssues = (w: Hybrid) => [...w.issues.values()].filter((i) => i.originId === SETUP_ISSUE_ORIGIN_ID);

  it("syncs the Cockpit's skills and opens one owner issue with the Setup link, for a company with no saved settings", async () => {
    const w = await make();
    expect(w.configs[NEW]).toBeUndefined(); // nothing was ever saved for it
    await created(w);
    expect(w.skillCalls.length).toBeGreaterThan(0); // the skills were put in the company's library
    expect(await knownCompanyIds(w.ctx)).toContain(NEW); // and the hourly sweeps know it from now on
    const [issue] = setupIssues(w);
    expect(setupIssues(w)).toHaveLength(1);
    expect(issue).toMatchObject({ companyId: NEW, title: "Set up Company 33333333-3333-4333-8333-333333333333", originKind: ORIGIN.setup, originId: SETUP_ISSUE_ORIGIN_ID });
    expect(issue!.description).toContain("[Setup → Team](/NEW/setup?section=team)");
    expect(issue!.description).toContain("Roles are staffed only there.");
    expect(issue!.description).toContain("Save Configuration");
  });

  it("opens it once however many times the event arrives", async () => {
    const w = await make();
    await created(w);
    await created(w);
    await created(w);
    expect(setupIssues(w)).toHaveLength(1);
    // a later restart (another process) still finds it through the issue itself
    const again = await ensureSetupIssue(w.env, NEW);
    expect(again).toMatchObject({ action: "exists", issueId: setupIssues(w)[0]!.id });
  });

  it("never staffs, hires, creates routines or grants anything: roles are staffed only in Setup → Team", async () => {
    const w = await make();
    const agentsBefore = w.agents.length;
    await created(w);
    expect(w.agents).toHaveLength(agentsBefore);
    expect(w.routines.size).toBe(0);
    expect(w.grants.size).toBe(0);
    expect((await w.client.query(`SELECT 1 FROM ${NAMESPACE}.roles`).catch(() => ({ rows: [] }))).rows).toHaveLength(0);
    expect(w.wakeups).toEqual([]); // the owner's issue wakes nobody
  });

  it("does not double an issue another plugin opened first (the Setup plugin hears the same event)", async () => {
    const w = await make();
    const other = await w.ctx.issues.create({ companyId: NEW, title: "Set up Company", description: "", status: "todo", originKind: SETUP_ORIGIN, originId: SETUP_ISSUE_ORIGIN_ID } as never);
    await created(w);
    expect(setupIssues(w).map((i) => i.id)).toEqual([other.id]);
    expect(w.sleeps).toEqual([]); // seen at the first look: no wait, no second issue
  });

  it("or one that appears while it waits", async () => {
    const w = await make();
    w.env.sleep = async () => {
      await w.ctx.issues.create({ companyId: NEW, title: "Set up Company", description: "", status: "todo", originKind: SETUP_ORIGIN, originId: SETUP_ISSUE_ORIGIN_ID } as never);
    };
    await created(w);
    expect(setupIssues(w)).toHaveLength(1);
    expect(setupIssues(w)[0]!.originKind).toBe(SETUP_ORIGIN);
  });

  it("waits the delay once before opening its own, so a plugin that opens it at the same moment is seen", async () => {
    const w = await make();
    await created(w);
    expect(w.sleeps).toEqual([SETUP_ISSUE_DELAY_MS]);
    expect(setupIssues(w)).toHaveLength(1);
  });

  it("assigns it to the owner when the roles already name one, and leaves it unassigned otherwise", async () => {
    const w = await make();
    await created(w);
    expect(setupIssues(w)[0]!.assigneeUserId ?? null).toBeNull();
    const withOwner = await make();
    await saveTeam(withOwner.env, NEW, { operatorAgentId: OP }, "user-owner");
    await created(withOwner);
    expect(setupIssues(withOwner)[0]).toMatchObject({ assigneeUserId: "user-owner" });
  });

  it("a company that missed company.created gets its skills on the first later event, but no Set up issue", async () => {
    const w = await make();
    await w.fire("project.created", { companyId: NEW });
    expect(w.skillCalls.length).toBeGreaterThan(0);
    expect(setupIssues(w)).toEqual([]);
    expect(await knownCompanyIds(w.ctx)).toContain(NEW);
  });

  it("when the issue cannot be opened it says so and does not throw, so the skills still synced", async () => {
    const w = await make();
    (w.ctx.issues as { create: unknown }).create = async () => {
      throw new Error("host refused");
    };
    await expect(created(w)).resolves.toBeUndefined();
    expect(w.skillCalls.length).toBeGreaterThan(0);
    expect(await ensureSetupIssue(w.env, NEW)).toEqual({ action: "failed", reason: "host refused" });
  });

  it("the Cockpit has exactly one company.created handler (a second would double the issue)", async () => {
    const w = await make();
    expect(w.handlers.get("company.created")).toHaveLength(1);
    expect(w.handlers.get("company.updated")).toHaveLength(1);
    expect(w.handlers.get("project.created")).toHaveLength(1);
  });
});
