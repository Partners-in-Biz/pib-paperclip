import { beforeEach, describe, expect, it } from "vitest";
import { ASK_EVENTS, COMPANY_OS_SKILL_KEY, MEMORY_AGENT_TOOLS, MEMORY_GRANT_EFFECT_KEY, MEMORY_TOOLS_GRANT, PLUGIN_TOOLS_GRANT, agentsWithoutPluginTools, applyMemoryToolsGrant, askAnsweredKey, askCardProblems, clearAskEffects, installAskEffects, memoryGrantAsk, memoryGrantEffect, pluginToolsGrantCheck, registerAskEffect, roleDriftCheck, runAskEffect, skillAttached, staffedAgents, teamRole, teamSkillKey, toolsGrantWaitingItem, type AskAnswered, type AskEffectResult } from "../src/index.js";
import { fakeCtx, rolesCopy } from "./helpers/fake-ctx.js";

const agent = (id: string, name: string, skills: string[], patch: Record<string, unknown> = {}) => ({ id, name, status: "idle", adapterConfig: { paperclipSkillSync: { desiredSkills: skills } }, ...patch });
const ALL_TOOLS = [{ permissionKey: "tools:use", scope: { ...PLUGIN_TOOLS_GRANT.scope } }];
const MEMORY_ONLY = [{ permissionKey: "tools:use", scope: { toolNames: [...MEMORY_AGENT_TOOLS] } }];
const bookkeeperSkills = teamRole("bookkeeper").skills;

describe("roleDriftCheck", () => {
  it("is quiet when every staffed agent has its role's skills and plugin tool access", async () => {
    const fake = fakeCtx({ agents: [agent("bk", "Bookkeeper", bookkeeperSkills)], grants: { bk: ALL_TOOLS } });
    const report = await roleDriftCheck(fake.ctx, "co-1", { roles: rolesCopy({ team: { bookkeeper: { agentId: "bk", status: "idle" } } }) as never });
    expect(report).toMatchObject({ checked: 1, problems: [], check: null, grantsChecked: true });
  });

  it("names the agent and the skill it lacks, and points at Setup -> Team", async () => {
    const fake = fakeCtx({ agents: [agent("bk", "Bookkeeper", [bookkeeperSkills[0]!])], grants: { bk: ALL_TOOLS } });
    const report = await roleDriftCheck(fake.ctx, "co-1", { roles: rolesCopy({ team: { bookkeeper: { agentId: "bk" } } }) as never });
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatchObject({ role: "bookkeeper", agentId: "bk", kind: "missing_skill", skill: COMPANY_OS_SKILL_KEY, required: true });
    expect(report.problems[0]!.message).toBe(`Bookkeeper (Bookkeeper) lacks skill ${COMPANY_OS_SKILL_KEY}`);
    expect(report.check).toMatchObject({ key: "roles:drift", status: "warn", href: "/setup?section=team" });
    expect(report.check!.detail).toContain("lacks skill");
    expect(report.check!.detail).toContain("attach in Setup → Team");
    expect(report.check!.fix).toContain("A plugin cannot attach skills itself");
  });

  it("accepts a skill attached under its short key, and counts extras as optional only", async () => {
    expect(skillAttached(["pib-company-os"], COMPANY_OS_SKILL_KEY)).toBe(true);
    expect(skillAttached(["plugin/other/bookkeeping"], bookkeeperSkills[0]!)).toBe(true);
    expect(skillAttached([], bookkeeperSkills[0]!)).toBe(false);
    const fake = fakeCtx({ agents: [agent("bk", "Bookkeeper", bookkeeperSkills)], grants: { bk: ALL_TOOLS } });
    const roles = rolesCopy({ team: { bookkeeper: { agentId: "bk" } } }) as never;
    const plain = await roleDriftCheck(fake.ctx, "co-1", { roles });
    expect(plain.problems).toEqual([]);
    const withOptional = await roleDriftCheck(fake.ctx, "co-1", { roles, includeOptional: true });
    expect(withOptional.problems.map((p) => [p.kind, p.skill])).toEqual([["missing_optional_skill", teamSkillKey("partnersinbiz.billing", "invoice-draft")]]);
    expect(withOptional.check).toBeNull();
  });

  it("finds an agent with no plugin tool grant, or one that leaves plugin tools out", async () => {
    const fake = fakeCtx({
      agents: [agent("bk", "Bookkeeper", bookkeeperSkills), agent("rev", "Reviewer", teamRole("reviewer").skills)],
      grants: { bk: [], rev: [{ permissionKey: "tools:use", scope: { providerType: "mcp_remote_http" } }] },
    });
    const report = await roleDriftCheck(fake.ctx, "co-1", { roles: rolesCopy({ team: { bookkeeper: { agentId: "bk" } } }) as never });
    expect(report.problems.map((p) => [p.agentName, p.kind])).toEqual([["Reviewer", "limited_tools_grant"], ["Bookkeeper", "no_tools_grant"]]);
    expect(report.problems[1]!.message).toContain("cannot call PiB tools or recall memory");
  });

  it("a memory-only grant is not drift for a staffed role (optional note only); named tools without memory still are", async () => {
    const roles = rolesCopy({ team: { bookkeeper: { agentId: "bk" } } }) as never;
    const memoryOnly = fakeCtx({ agents: [agent("bk", "Bookkeeper", bookkeeperSkills)], grants: { bk: MEMORY_ONLY } });
    const quiet = await roleDriftCheck(memoryOnly.ctx, "co-1", { roles });
    expect(quiet.problems).toEqual([]);
    expect(quiet.check).toBeNull();
    const withOptional = await roleDriftCheck(memoryOnly.ctx, "co-1", { roles, includeOptional: true });
    expect(withOptional.problems.find((p) => p.kind === "limited_tools_grant")).toMatchObject({ required: false });
    const noMemory = fakeCtx({ agents: [agent("bk", "Bookkeeper", bookkeeperSkills)], grants: { bk: [{ permissionKey: "tools:use", scope: { toolNames: ["partnersinbiz.billing:invoice-draft"] } }] } });
    const loud = await roleDriftCheck(noMemory.ctx, "co-1", { roles });
    expect(loud.problems.map((p) => [p.kind, p.required])).toEqual([["limited_tools_grant", true]]);
    expect(loud.problems[0]!.message).toContain("memory-recall");
    expect(loud.check).not.toBeNull();
  });

  it("checks the Operator and the Reviewer through their own fields, ignores unstaffed, ended and switched-off roles", async () => {
    const fake = fakeCtx({ agents: [agent("op", "Operator", teamRole("operator").skills), agent("rev", "Reviewer", [], { status: "terminated" })], grants: { op: ALL_TOOLS } });
    const roles = rolesCopy() as never;
    expect(staffedAgents(roles, [teamRole("operator"), teamRole("reviewer"), teamRole("bookkeeper")]).map((s) => s.agentId)).toEqual(["op", "rev"]);
    const report = await roleDriftCheck(fake.ctx, "co-1", { roles });
    expect(report.checked).toBe(1);
    expect(report.problems).toEqual([]);
    const off = await roleDriftCheck(fake.ctx, "co-1", { roles, modules: { cockpit: false } });
    expect(off.checked).toBe(0);
    expect((await roleDriftCheck(fake.ctx, "co-1", { roles: null })).checked).toBe(0);
  });

  it("still reports skills when the grants cannot be read", async () => {
    const fake = fakeCtx({ agents: [agent("bk", "Bookkeeper", [])], grantsThrow: true });
    const report = await roleDriftCheck(fake.ctx, "co-1", { roles: rolesCopy({ team: { bookkeeper: { agentId: "bk" } } }) as never });
    expect(report.grantsChecked).toBe(false);
    expect(report.problems.every((p) => p.kind === "missing_skill")).toBe(true);
    expect(report.check).not.toBeNull();
  });
});

describe("plugin tool access visibility (Q9-6, Q8-12)", () => {
  const roster = [
    agent("cr", "Code Reviewer", [COMPANY_OS_SKILL_KEY]),
    agent("dev", "Developer", [COMPANY_OS_SKILL_KEY]),
    agent("para", "Arjun", ["paperclipai/paperclip/paperclip"]),
    agent("gone", "Old", [COMPANY_OS_SKILL_KEY], { status: "terminated" }),
    agent("lim", "Limited", ["plugin/partnersinbiz-crm/crm-records"]),
  ];
  const grants = { cr: [], dev: ALL_TOOLS, para: [], gone: [], lim: [{ permissionKey: "tools:use", scope: { providerType: "mcp_remote_http" } }] };

  it("lists the active agents that carry PiB skills but cannot call plugin tools", async () => {
    const { problems, checked, unreadable } = await agentsWithoutPluginTools(fakeCtx({ agents: roster, grants }).ctx, "co-1");
    expect(problems.map((p) => [p.agentName, p.state])).toEqual([["Code Reviewer", "none"], ["Limited", "limited"]]);
    expect(checked).toBe(3);
    expect(unreadable).toBe(false);
    const all = await agentsWithoutPluginTools(fakeCtx({ agents: roster, grants }).ctx, "co-1", { onlyWithPibSkills: false });
    expect(all.problems.map((p) => p.agentName)).toContain("Arjun");
  });

  it("publishes a health check that recommends the memory-only grant, and one batched Needs-you item that names the wide option plainly", async () => {
    const ctx = fakeCtx({ agents: roster, grants }).ctx;
    const check = await pluginToolsGrantCheck(ctx, "co-1");
    expect(check).toMatchObject({ key: "grants:plugin-tools", status: "warn" });
    expect(check!.detail).toContain("Code Reviewer");
    expect(check!.detail).toContain("memory-recall");
    expect(check!.fix).toContain("narrowest grant");
    expect(check!.fix).toContain("all plugin tools");
    expect(check!.fix).not.toContain("only scope");
    const { problems } = await agentsWithoutPluginTools(ctx, "co-1");
    const item = toolsGrantWaitingItem(problems, { prefix: "PAR" })!;
    expect(item).toMatchObject({ key: "grants:plugin-tools", kind: "grant", href: "/PAR/agents" });
    expect(item.title).toBe("Let 2 agents use company memory");
    expect(item.why).toContain("memory-only grant");
    expect(item.why).toContain("opens nothing else");
    expect(item.why).toContain("also opens CRM, billing and payroll");
    // the host DOES offer a narrower scope: never tell the owner otherwise
    expect(item.why).not.toContain("no narrower scope");
    expect(toolsGrantWaitingItem([])).toBeNull();
  });

  it("a memory-only grant satisfies the check (least privilege must be able to turn it green); named tools without memory do not", async () => {
    const fake = fakeCtx({
      agents: [agent("a", "Planner", [COMPANY_OS_SKILL_KEY]), agent("b", "Summarizer", [COMPANY_OS_SKILL_KEY]), agent("c", "Wiki", [COMPANY_OS_SKILL_KEY]), agent("d", "Recall only", [COMPANY_OS_SKILL_KEY]), agent("e", "Allow list", [COMPANY_OS_SKILL_KEY])],
      grants: {
        a: MEMORY_ONLY,
        b: [{ permissionKey: "tools:use", scope: { providerType: "paperclip_plugin", toolNames: [...MEMORY_AGENT_TOOLS] } }],
        c: [{ permissionKey: "tools:use", scope: { toolNames: ["partnersinbiz.crm:crm-records"] } }],
        d: [{ permissionKey: "tools:use", scope: { toolNames: ["partnersinbiz.cockpit:memory-recall"] } }],
        e: [{ permissionKey: "tools:use", scope: { providerType: "mcp_remote_http", allow: MEMORY_AGENT_TOOLS.map((name) => `tool:${name}`) } }],
      },
    });
    const { problems, checked } = await agentsWithoutPluginTools(fake.ctx, "co-1");
    expect(checked).toBe(5);
    expect(problems.map((p) => [p.agentName, p.state])).toEqual([["Wiki", "limited"], ["Recall only", "limited"]]);
    expect(problems[0]!.missing).toEqual([...MEMORY_AGENT_TOOLS]);
    expect(problems[1]!.missing).toEqual(MEMORY_AGENT_TOOLS.filter((name) => name !== "partnersinbiz.cockpit:memory-recall"));
    // the whole company on a memory-only grant: no check, no item
    const clean = fakeCtx({ agents: [agent("a", "Planner", [COMPANY_OS_SKILL_KEY])], grants: { a: MEMORY_ONLY } });
    expect(await pluginToolsGrantCheck(clean.ctx, "co-1")).toBeNull();
  });

  it("can require other tools than memory", async () => {
    const fake = fakeCtx({ agents: [agent("a", "Planner", [COMPANY_OS_SKILL_KEY])], grants: { a: MEMORY_ONLY } });
    const crm = "partnersinbiz.crm:crm-records";
    const { problems } = await agentsWithoutPluginTools(fake.ctx, "co-1", { requiredTools: [crm] });
    expect(problems).toEqual([{ agentId: "a", agentName: "Planner", state: "limited", missing: [crm] }]);
    const check = await pluginToolsGrantCheck(fake.ctx, "co-1", { requiredTools: [crm] });
    expect(check!.title).toBe("Agents missing tool access");
    expect(check!.detail).toContain("crm-records");
  });

  it("is quiet when all have access, and when grants cannot be read", async () => {
    expect(await pluginToolsGrantCheck(fakeCtx({ agents: [roster[1]!], grants: { dev: ALL_TOOLS } }).ctx, "co-1")).toBeNull();
    const unreadable = await agentsWithoutPluginTools(fakeCtx({ agents: roster, grantsThrow: true }).ctx, "co-1");
    expect(unreadable).toMatchObject({ problems: [], unreadable: true });
  });
});

describe("applying the memory-only grant (an ask effect the Cockpit registers)", () => {
  beforeEach(() => clearAskEffects());
  const ID_A = "11111111-1111-4111-8111-111111111111";
  const ID_B = "22222222-2222-4222-8222-222222222222";
  const answered = (patch: Partial<AskAnswered> = {}, params: Record<string, string> = { agentIds: `${ID_A},${ID_B}` }): AskAnswered => ({
    key: askAnsweredKey("ask-g", "2026-10-03T08:00:00.000Z"),
    askId: "ask-g",
    issueId: "issue-1",
    kind: "grant",
    effect: { key: MEMORY_GRANT_EFFECT_KEY, params },
    question: "May they use company memory?",
    options: ["Yes: memory tools only", "All plugin tools", "No"],
    answer: "Yes",
    answeredByUserId: "user-peet",
    answeredAt: "2026-10-03T08:00:00.000Z",
    ...patch,
  });
  const roster = () => [agent(ID_A, "Planner", [COMPANY_OS_SKILL_KEY]), agent(ID_B, "Summarizer", [COMPANY_OS_SKILL_KEY])];

  it("grants the four memory tools and nothing else, then reads it back", async () => {
    const fake = fakeCtx({ agents: roster(), grants: { [ID_A]: [{ permissionKey: "tasks:assign", scope: null }], [ID_B]: [] } });
    registerAskEffect(MEMORY_GRANT_EFFECT_KEY, memoryGrantEffect);
    const result = await runAskEffect(fake.ctx, "co-1", answered());
    expect(result).toMatchObject({ status: "applied", verified: true });
    expect(result!.detail).toContain("Planner: memory tools granted");
    expect(result!.detail).toContain("Summarizer: memory tools granted");
    expect(fake.grantStore[ID_A]).toEqual([{ permissionKey: "tasks:assign", scope: null }, MEMORY_TOOLS_GRANT]);
    expect(fake.grantStore[ID_B]).toEqual([MEMORY_TOOLS_GRANT]);
    expect(fake.grantWrites.map((w) => w.grantedByUserId)).toEqual(["user-peet", "user-peet"]);
    // and the check it fixes is now quiet
    expect(await pluginToolsGrantCheck(fake.ctx, "co-1")).toBeNull();
    // asked again: nothing is written twice
    const again = await runAskEffect(fake.ctx, "co-1", answered());
    expect(again!.status).toBe("already_applied");
    expect(fake.grantWrites).toHaveLength(2);
  });

  it("does not take the grant from the params: the agent cannot ask for more than memory", async () => {
    const fake = fakeCtx({ agents: roster(), grants: { [ID_A]: [], [ID_B]: [] } });
    registerAskEffect(MEMORY_GRANT_EFFECT_KEY, memoryGrantEffect);
    const widened = await runAskEffect(fake.ctx, "co-1", answered({}, { agentIds: ID_A, scope: "paperclip_plugin", toolNames: "*" }));
    expect(widened).toMatchObject({ status: "refused" });
    expect(widened!.detail).toContain('"scope" is not a parameter this effect accepts');
    expect(fake.grantWrites).toEqual([]);
  });

  it("refuses an agent that is not an active agent of the company, a bad id, and an empty list", async () => {
    const fake = fakeCtx({ agents: [...roster(), agent("33333333-3333-4333-8333-333333333333", "Gone", [], { status: "terminated" })], grants: {} });
    registerAskEffect(MEMORY_GRANT_EFFECT_KEY, memoryGrantEffect);
    const foreign = await runAskEffect(fake.ctx, "co-1", answered({ key: "k1" }, { agentIds: `${ID_A},44444444-4444-4444-8444-444444444444` }));
    expect(foreign!.status).toBe("refused");
    expect(foreign!.detail).toContain("is not an active agent of this company");
    expect((await runAskEffect(fake.ctx, "co-1", answered({ key: "k2" }, { agentIds: "33333333-3333-4333-8333-333333333333" })))!.status).toBe("refused");
    expect((await runAskEffect(fake.ctx, "co-1", answered({ key: "k3" }, { agentIds: "not-an-id" })))!.detail).toContain("not valid");
    expect((await runAskEffect(fake.ctx, "co-1", answered({ key: "k4" }, { agentIds: "" })))!.status).toBe("refused");
    expect(fake.grantWrites).toEqual([]);
  });

  it("is not applied for an answer with no person, a decline, or an answer that wants something else", async () => {
    const fake = fakeCtx({ agents: roster(), grants: { [ID_A]: [], [ID_B]: [] } });
    registerAskEffect(MEMORY_GRANT_EFFECT_KEY, memoryGrantEffect);
    expect((await runAskEffect(fake.ctx, "co-1", answered({ answeredByUserId: null as never })))!.status).toBe("refused");
    expect((await runAskEffect(fake.ctx, "co-1", answered({ key: "d", answer: "No" })))!.status).toBe("declined");
    expect((await runAskEffect(fake.ctx, "co-1", answered({ key: "w", answer: "2" })))!.status).toBe("unclear");
    expect(fake.grantWrites).toEqual([]);
  });

  it("reports a grant limited another way as a failure for a person, without widening it", async () => {
    const limited = [{ permissionKey: "tools:use", scope: { providerType: "mcp_remote_http" } }];
    const fake = fakeCtx({ agents: roster(), grants: { [ID_A]: limited, [ID_B]: [] } });
    registerAskEffect(MEMORY_GRANT_EFFECT_KEY, memoryGrantEffect);
    const result = await runAskEffect(fake.ctx, "co-1", answered());
    expect(result!.status).toBe("failed");
    expect(result!.detail).toContain("Planner");
    expect(result!.detail).toContain("limited");
    expect(fake.grantStore[ID_A]).toEqual(limited);
    const direct = await applyMemoryToolsGrant(fake.ctx, "co-1", ID_A);
    expect(direct).toMatchObject({ state: "conflict", verified: false });
  });

  it("applyMemoryToolsGrant says failed when the host refuses, and already_present when nothing is needed", async () => {
    const refused = await applyMemoryToolsGrant(fakeCtx({ grantsThrow: true }).ctx, "co-1", ID_A);
    expect(refused).toMatchObject({ state: "failed", verified: false });
    const fake = fakeCtx({ grants: { [ID_A]: ALL_TOOLS } });
    expect(await applyMemoryToolsGrant(fake.ctx, "co-1", ID_A)).toEqual({ state: "already_present", detail: null, verified: true });
    expect(fake.grantWrites).toEqual([]);
  });

  it("runs through the event loop like any effect, once", async () => {
    const cockpit = fakeCtx({ manifestId: "partnersinbiz.cockpit", agents: roster(), grants: { [ID_A]: [], [ID_B]: [] } });
    registerAskEffect(MEMORY_GRANT_EFFECT_KEY, memoryGrantEffect);
    installAskEffects(cockpit.ctx);
    await cockpit.deliver(`plugin.partnersinbiz.cockpit.${ASK_EVENTS.answered}`, "co-1", answered());
    expect(cockpit.emitted.map((e) => (e.payload as unknown as AskEffectResult).status)).toEqual(["applied"]);
  });

  it("builds an ask the owner can answer once, that passes the card rules and carries its effect", () => {
    const ask = memoryGrantAsk([{ agentId: ID_A, agentName: "Planner", state: "none", missing: [...MEMORY_AGENT_TOOLS] }, { agentId: ID_B, agentName: "Summarizer", state: "none", missing: [...MEMORY_AGENT_TOOLS] }], { prefix: "PAR" });
    expect(askCardProblems(ask)).toEqual([]);
    expect(ask.kind).toBe("grant");
    expect(ask.links).toEqual([{ label: "Agents", href: "/PAR/agents" }]);
    expect(ask.options[0]).toContain("memory tools only");
    expect(ask.effect).toEqual({ key: MEMORY_GRANT_EFFECT_KEY, params: { agentIds: `${ID_A},${ID_B}` } });
    expect(ask.question).toContain("Planner, Summarizer");
  });
});
