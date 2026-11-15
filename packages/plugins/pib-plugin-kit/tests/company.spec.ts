import { describe, expect, it } from "vitest";
import {
  actionableCompanyIds,
  LAZY_BOOTSTRAP_EVENTS,
  SKILL_SYNC_JOB,
  classifySkillSync,
  companySetupIssueText,
  createPeriodicSkillSync,
  createSkillSyncer,
  knownCompanyIds,
  listCompanyIds,
  registerCompanyBootstrap,
  registerSkillSyncJob,
  rememberCompany,
  skillSyncCheck,
  skillVersion,
  skillsBehind,
  syncAllCompanies,
  syncManagedSkills,
} from "../src/index.js";
import { fakeCtx, stateKeyOf } from "./helpers/fake-ctx.js";

const SKILLS = [{ skillKey: "crm-records", markdown: "one" }, { skillKey: "crm-outbound", markdown: "two" }];


describe("known companies", () => {
  it("remembers a company once and survives concurrent calls", async () => {
    const fake = fakeCtx();
    await Promise.all([rememberCompany(fake.ctx, "a"), rememberCompany(fake.ctx, "b"), rememberCompany(fake.ctx, "a")]);
    expect((await knownCompanyIds(fake.ctx)).sort()).toEqual(["a", "b"]);
    expect(await knownCompanyIds(fakeCtx().ctx)).toEqual([]);
  });

  it("never throws when state is unavailable", async () => {
    const fake = fakeCtx({ stateReadThrows: true });
    await expect(rememberCompany(fake.ctx, "a")).resolves.toBeUndefined();
    expect(await knownCompanyIds(fake.ctx)).toEqual([]);
  });

  it("a skill syncer remembers every company it serves", async () => {
    const fake = fakeCtx();
    const syncer = createSkillSyncer(fake.ctx, SKILLS);
    await syncer.ensure("co-1");
    await syncer.force("co-2");
    await syncer.check("co-3");
    expect((await knownCompanyIds(fake.ctx)).sort()).toEqual(["co-1", "co-2", "co-3"]);
  });

  it("lists given, remembered and host companies together, and survives a refused host list", async () => {
    const fake = fakeCtx({ companies: { host: { name: "Host" } } });
    await rememberCompany(fake.ctx, "mine");
    const all = await listCompanyIds(fake.ctx, { extra: ["given"] });
    expect(all.ids.sort()).toEqual(["given", "host", "mine"]);
    expect(all.listed).toBe(true);
    const refused = fakeCtx({ companyListThrows: true });
    await rememberCompany(refused.ctx, "mine");
    const partial = await listCompanyIds(refused.ctx, { extra: ["given"] });
    expect(partial.ids.sort()).toEqual(["given", "mine"]);
    expect(partial.listed).toBe(false);
    expect(partial.listError).toContain("companies.list");
    expect(partial.actionable).toBeNull();
    expect(all.actionable).toEqual(["host"]);
  });

  it("actionableCompanyIds is null when the call throws, and null when the host list is switched off", async () => {
    expect(await actionableCompanyIds(fakeCtx({ companyListThrows: true }).ctx)).toBeNull();
    const fake = fakeCtx({ companies: { a: {} } });
    expect((await listCompanyIds(fake.ctx, { includeHostList: false })).actionable).toBeNull();
  });
});

describe("syncAllCompanies", () => {
  it("syncs every known company, not only the one a call comes from", async () => {
    const fake = fakeCtx();
    const syncer = createSkillSyncer(fake.ctx, SKILLS);
    await rememberCompany(fake.ctx, "par");
    await rememberCompany(fake.ctx, "para");
    const sweep = await syncAllCompanies(fake.ctx, syncer, { includeHostList: false, plugin: "partnersinbiz.crm" });
    expect(sweep.outcomes.map((o) => [o.companyId, o.status]).sort()).toEqual([["par", "synced"], ["para", "synced"]]);
    expect(fake.resets.filter((r) => r.companyId === "para").map((r) => r.key).sort()).toEqual(["crm-outbound", "crm-records"]);
  });

  it("finds a changed skill again on the next sweep without a restart", async () => {
    const fake = fakeCtx();
    const first = createSkillSyncer(fake.ctx, SKILLS);
    await syncAllCompanies(fake.ctx, first, { companyIds: ["par"], includeHostList: false });
    const again = await syncAllCompanies(fake.ctx, first, { companyIds: ["par"], includeHostList: false });
    expect(again.outcomes[0]!.status).toBe("unchanged");
    const upgraded = createSkillSyncer(fake.ctx, [{ skillKey: "crm-records", markdown: "ONE v2" }, SKILLS[1]!]);
    const sweep = await syncAllCompanies(fake.ctx, upgraded, { companyIds: ["par"], includeHostList: false });
    expect(sweep.outcomes[0]).toMatchObject({ status: "synced", reset: ["crm-records"] });
  });

  it("reports a company whose plugin settings were never saved as needs_settings, and still syncs the rest", async () => {
    const fake = fakeCtx({ deniedCompanies: ["para"] });
    const syncer = createSkillSyncer(fake.ctx, SKILLS);
    const sweep = await syncAllCompanies(fake.ctx, syncer, { companyIds: ["par", "para"], includeHostList: false, plugin: "partnersinbiz.crm" });
    const byCompany = Object.fromEntries(sweep.outcomes.map((o) => [o.companyId, o]));
    expect(byCompany.par!.status).toBe("synced");
    expect(byCompany.para!.status).toBe("needs_settings");
    expect(byCompany.para!.error).toContain("company context is required");
    expect(fake.resets.some((r) => r.companyId === "para")).toBe(false);
  });

  describe("with the host's actionable list (PAR-11072)", () => {
    const COMPANIES = { par: {}, para: {} };

    it("(a) the list throws: one host call per company and the same statuses as before, none marked needs_settings without its own refused call", async () => {
      const fake = fakeCtx({ companyListThrows: true, deniedCompanies: ["para"] });
      const syncer = createSkillSyncer(fake.ctx, SKILLS);
      const sweep = await syncAllCompanies(fake.ctx, syncer, { companyIds: ["par", "para", "other"] });
      const status = Object.fromEntries(sweep.outcomes.map((o) => [o.companyId, o.status]));
      expect(status).toEqual({ par: "synced", para: "needs_settings", other: "synced" });
      expect(fake.hostCalls.some((c) => c.endsWith(":para"))).toBe(true);
      expect(fake.hostCalls.some((c) => c.endsWith(":other"))).toBe(true);
      expect(sweep.listed).toBe(false);
    });

    it("(b) an old host ignores the param and returns every company: today's behaviour, one host call per company", async () => {
      const fake = fakeCtx({ companies: COMPANIES, deniedCompanies: ["para"], actionableHost: "old" });
      const syncer = createSkillSyncer(fake.ctx, SKILLS);
      const sweep = await syncAllCompanies(fake.ctx, syncer, {});
      expect(await actionableCompanyIds(fake.ctx)).toEqual(["par", "para"]);
      expect(sweep.outcomes.map((o) => [o.companyId, o.status]).sort()).toEqual([["par", "synced"], ["para", "needs_settings"]]);
      expect(fake.hostCalls.some((c) => c.endsWith(":para"))).toBe(true);
    });

    it("(c) a new host, one configured and one unconfigured company: needs_settings, and no host call and no isEnabled call names the unconfigured one", async () => {
      const fake = fakeCtx({ companies: COMPANIES, deniedCompanies: ["para"], actionableHost: "new" });
      const syncer = createSkillSyncer(fake.ctx, SKILLS);
      const enabledFor: string[] = [];
      const sweep = await syncAllCompanies(fake.ctx, syncer, { companyIds: ["par", "para"], isEnabled: async (id) => (enabledFor.push(id), true) });
      const byCompany = Object.fromEntries(sweep.outcomes.map((o) => [o.companyId, o]));
      expect(byCompany.par!.status).toBe("synced");
      expect(byCompany.para!.status).toBe("needs_settings");
      expect(byCompany.para!.error).toContain("company context is required");
      expect(fake.hostCalls.filter((c) => c.endsWith(":para"))).toEqual([]);
      expect(enabledFor).toEqual(["par"]);
      expect(fake.resets.some((r) => r.companyId === "para")).toBe(false);
      const stored = fake.state.get(stateKeyOf({ scopeKind: "instance", namespace: "pib-kit", stateKey: "skill-sync-status" })) as { companies: Record<string, { status: string }> };
      expect(stored.companies.para!.status).toBe("needs_settings");
    });

    it("(d) inside an invocation the list is only that call's company, so a sweep records every other known company needs_settings (documented: jobs and webhooks only)", async () => {
      const fake = fakeCtx({ companies: COMPANIES, invocationCompany: "par" });
      const syncer = createSkillSyncer(fake.ctx, SKILLS);
      expect(await actionableCompanyIds(fake.ctx)).toEqual(["par"]);
      const sweep = await syncAllCompanies(fake.ctx, syncer, { companyIds: ["par", "para"] });
      expect(sweep.outcomes.map((o) => [o.companyId, o.status]).sort()).toEqual([["par", "synced"], ["para", "needs_settings"]]);
      expect(fake.hostCalls.filter((c) => c.endsWith(":para"))).toEqual([]);
    });
  });

  it("skips a company that switched the module off, and force resets everything", async () => {
    const fake = fakeCtx();
    const syncer = createSkillSyncer(fake.ctx, SKILLS);
    const sweep = await syncAllCompanies(fake.ctx, syncer, { companyIds: ["on", "off"], includeHostList: false, isEnabled: async (id) => id !== "off" });
    expect(sweep.outcomes.find((o) => o.companyId === "off")!.status).toBe("skipped");
    const forced = await syncAllCompanies(fake.ctx, syncer, { companyIds: ["on"], includeHostList: false, force: true });
    expect(forced.outcomes[0]!.reset).toHaveLength(2);
  });

  it("keeps going when one company throws", async () => {
    const fake = fakeCtx();
    const syncer = createSkillSyncer(fake.ctx, SKILLS);
    const original = syncer.check;
    syncer.check = async (id: string) => {
      if (id === "bad") throw new Error("host exploded");
      return original(id);
    };
    const sweep = await syncAllCompanies(fake.ctx, syncer, { companyIds: ["bad", "good"], includeHostList: false });
    expect(sweep.outcomes.map((o) => o.status).sort()).toEqual(["failed", "synced"]);
  });

  it("classifies results", () => {
    expect(classifySkillSync([{ skillKey: "a", action: "reconcile" }])).toEqual({ status: "unchanged", reset: [] });
    expect(classifySkillSync([{ skillKey: "a", action: "reset" }])).toMatchObject({ status: "synced", reset: ["a"] });
    expect(classifySkillSync([{ skillKey: "a", action: "failed", error: "boom" }]).status).toBe("failed");
    const scoped = (message: string) => classifySkillSync([{ skillKey: "a", action: "failed", error: message }]).status;
    expect(scoped('Plugin "x" is not allowed to perform "skills.managed.reset": company context is required')).toBe("needs_settings");
    // not fixed by saving settings, so not reported as needing them
    expect(scoped('Plugin "x" is not allowed to perform "skills.managed.reset": capability "skills.managed" is not declared')).toBe("failed");
    expect(scoped('Plugin "x" is not allowed to perform "state.get": requested company "a" but the current invocation is scoped to company "b"')).toBe("failed");
    expect(scoped('Plugin "x" is not allowed to perform "state.get": the worker referenced a missing, expired, or unknown invocation scope')).toBe("failed");
  });

  it("tells the Cockpit which company needs its settings saved, and goes red after a day", async () => {
    const fake = fakeCtx({ deniedCompanies: ["para"] });
    const syncer = createSkillSyncer(fake.ctx, SKILLS);
    await syncAllCompanies(fake.ctx, syncer, { companyIds: ["par", "para"], includeHostList: false, plugin: "partnersinbiz.crm" });
    expect(await skillSyncCheck(fake.ctx, "par", "CRM")).toBeNull();
    const warn = await skillSyncCheck(fake.ctx, "para", "CRM");
    expect(warn).toMatchObject({ key: "skills:crm", status: "warn" });
    expect(warn!.fix).toContain("Save Configuration");
    expect((await skillSyncCheck(fake.ctx, "para", "CRM", Date.now() + 25 * 3_600_000))!.status).toBe("bad");
  });

  it("runs as a job and as a periodic function", async () => {
    const fake = fakeCtx();
    const syncer = createSkillSyncer(fake.ctx, SKILLS);
    registerSkillSyncJob(fake.ctx, syncer, { includeHostList: false, companyIds: () => ["par"] });
    await fake.jobs.get(SKILL_SYNC_JOB.jobKey)!();
    expect(fake.resets.map((r) => r.companyId)).toEqual(["par", "par"]);
    const sweep = await createPeriodicSkillSync(fake.ctx, syncer, { includeHostList: false, companyIds: () => ["par"] })();
    expect(sweep.outcomes[0]!.status).toBe("unchanged");
    expect(SKILL_SYNC_JOB.schedule).toMatch(/^\d+ \*\/\d+ \* \* \*$/);
  });

  it("says which skills a company has not received at their current version", async () => {
    const fake = fakeCtx();
    expect((await skillsBehind(fake.ctx, "co-1", SKILLS)).behind).toEqual(["crm-records", "crm-outbound"]);
    await syncManagedSkills(fake.ctx, "co-1", SKILLS);
    expect(await skillsBehind(fake.ctx, "co-1", SKILLS)).toEqual({ behind: [], unreadable: false });
    expect((await skillsBehind(fake.ctx, "co-1", [{ skillKey: "crm-records", markdown: "newer" }])).behind).toEqual(["crm-records"]);
    const denied = fakeCtx({ deniedCompanies: ["co-9"] });
    expect(await skillsBehind(denied.ctx, "co-9", SKILLS)).toEqual({ behind: [], unreadable: true });
    expect(fake.state.get(stateKeyOf({ scopeKind: "company", scopeId: "co-1", namespace: "pib-kit", stateKey: "skill-ver:crm-records" }))).toBe(skillVersion(SKILLS[0]!));
  });
});

describe("registerCompanyBootstrap", () => {
  it("handles company.created: remembers, syncs, ensures resources and opens ONE owner issue with a Setup -> Team link", async () => {
    const fake = fakeCtx({ companies: { new: { name: "Northwind", issuePrefix: "NWD", defaultResponsibleUserId: "founder" } } });
    const syncer = createSkillSyncer(fake.ctx, SKILLS);
    const ensured: string[] = [];
    registerCompanyBootstrap(fake.ctx, { syncer, ensureResources: async (id) => void ensured.push(id), ownerIssue: {} });
    await fake.deliver("company.created", "new");
    await fake.deliver("company.created", "new");
    expect(await knownCompanyIds(fake.ctx)).toEqual(["new"]);
    expect(fake.resets.filter((r) => r.companyId === "new")).toHaveLength(2);
    expect(ensured).toEqual(["new", "new"]);
    expect(fake.issues).toHaveLength(1);
    expect(fake.issues[0]).toMatchObject({ title: "Set up Northwind", assigneeUserId: "founder", originKind: "plugin:partnersinbiz.test", originId: "company-setup" });
    expect(fake.issues[0]!.description).toContain("(/NWD/setup?section=team)");
    expect(fake.issues[0]!.description).toContain("Settings → Plugins");
  });

  it("opens no owner issue unless asked, and none for a lazy run", async () => {
    const fake = fakeCtx({ companies: { c: { name: "C", defaultResponsibleUserId: "founder" } } });
    registerCompanyBootstrap(fake.ctx, { syncer: createSkillSyncer(fake.ctx, SKILLS) });
    await fake.deliver("company.created", "c");
    expect(fake.issues).toHaveLength(0);
    const lazy = fakeCtx({ companies: { c: { name: "C", defaultResponsibleUserId: "founder" } } });
    registerCompanyBootstrap(lazy.ctx, { syncer: createSkillSyncer(lazy.ctx, SKILLS), ownerIssue: {} });
    await lazy.deliver("company.updated", "c");
    expect(lazy.issues).toHaveLength(0);
    expect(lazy.resets.length).toBeGreaterThan(0);
  });

  it("catches up a company that missed company.created on the first rare event for it, once", async () => {
    const fake = fakeCtx();
    const syncer = createSkillSyncer(fake.ctx, SKILLS);
    const seen: string[] = [];
    registerCompanyBootstrap(fake.ctx, { syncer, onBootstrap: async (id, source) => void seen.push(`${id}:${source}`) });
    for (const name of LAZY_BOOTSTRAP_EVENTS) expect(fake.handlers.has(name)).toBe(true);
    await fake.deliver("project.created", "old");
    await fake.deliver("company.updated", "old");
    await fake.deliver("project.created", "old");
    expect(seen).toEqual(["old:lazy"]);
  });

  it("never subscribes to an agent event: registerHireWatch owns those, and a second handler would run twice", () => {
    const fake = fakeCtx();
    registerCompanyBootstrap(fake.ctx, {});
    expect([...fake.handlers.keys()].filter((name) => name.startsWith("agent.") || name === "approval.decided")).toEqual([]);
    expect([...fake.handlers.keys()].sort()).toEqual(["company.created", "company.updated", "project.created"]);
    expect(fake.handlers.get("company.created")).toHaveLength(1);
  });

  it("remembers the company itself, with or without a syncer (the sweep depends on it)", async () => {
    const bare = fakeCtx();
    registerCompanyBootstrap(bare.ctx, { lazyOn: false });
    await bare.deliver("company.created", "bare");
    expect(await knownCompanyIds(bare.ctx)).toEqual(["bare"]);
    const lazy = fakeCtx();
    registerCompanyBootstrap(lazy.ctx, {});
    await lazy.deliver("project.created", "lazy-co");
    expect(await knownCompanyIds(lazy.ctx)).toEqual(["lazy-co"]);
  });

  it("tries a failed lazy catch-up again on the next event, and stops once it is clean", async () => {
    const fake = fakeCtx();
    let attempts = 0;
    registerCompanyBootstrap(fake.ctx, { ensureResources: async () => { attempts += 1; if (attempts === 1) throw new Error("project create failed"); } });
    await fake.deliver("company.updated", "old");
    await fake.deliver("project.created", "old");
    await fake.deliver("company.updated", "old");
    expect(attempts).toBe(2);
  });

  it("registers no lazy events when switched off, and reports a failing step without throwing", async () => {
    const fake = fakeCtx();
    const { run } = registerCompanyBootstrap(fake.ctx, { lazyOn: false, ensureResources: async () => { throw new Error("project create failed"); }, syncer: createSkillSyncer(fake.ctx, SKILLS) });
    expect(fake.handlers.has("company.updated")).toBe(false);
    const report = await run("c", "manual");
    expect(report.resources).toBe("failed");
    expect(report.errors[0]).toContain("project create failed");
    expect(report.skills).toHaveLength(2);
  });

  it("opens the owner issue unassigned when the company has no default owner, and never twice", async () => {
    const fake = fakeCtx({ companies: { c: { name: "C" } } });
    const { run } = registerCompanyBootstrap(fake.ctx, { ownerIssue: {}, lazyOn: false });
    const first = await run("c", "company.created");
    const second = await run("c", "company.created");
    expect(first.ownerIssue).toBe("opened");
    expect(second.ownerIssue).toBe("exists");
    expect(fake.issues).toHaveLength(1);
    expect(fake.issues[0]!.assigneeUserId ?? null).toBeNull();
  });

  it("words the owner issue for a person", () => {
    const text = companySetupIssueText({ name: "Northwind", prefix: null });
    expect(text.title).toBe("Set up Northwind");
    expect(text.description).toContain("(/setup?section=team)");
  });
});
