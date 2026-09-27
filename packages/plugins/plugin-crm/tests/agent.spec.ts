import { afterEach, describe, expect, it, vi } from "vitest";
import { hireTaskDraft } from "@partnersinbiz/pib-plugin-kit";
import { ACCOUNT_MANAGER_ROLE, coversPluginTools, mergeToolsGrant, missingRoleSkills } from "../src/agent.js";
import { EXTRA_SKILLS, ROLE_SKILLS, agentProblem, attachIfMissing, attachRoleSkills, companySkillKeys, stillMissing, TEAM_SETUP_HREF } from "../src/ui/role-skills.js";
import { BOARD, CO, boot, crmIssues, setRoles } from "./helpers/crm.js";

const NOW = Date.parse("2026-09-27T10:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

afterEach(() => vi.unstubAllGlobals());

describe("the tools grant: one tools:use grant per agent", () => {
  const other = { permissionKey: "issues:create", scope: null };

  it("adds the plugin tools grant when there is none", () => {
    expect(mergeToolsGrant([other])).toEqual({
      grants: [other, { permissionKey: "tools:use", scope: { providerType: "paperclip_plugin" } }],
      changed: true,
      conflict: null,
    });
  });

  it("keeps an unscoped grant or one that already covers plugin tools", () => {
    expect(mergeToolsGrant([{ permissionKey: "tools:use", scope: null }])).toMatchObject({ changed: false, conflict: null });
    expect(mergeToolsGrant([{ permissionKey: "tools:use", scope: { providerType: "paperclip_plugin" } }])).toMatchObject({ changed: false });
    expect(mergeToolsGrant([{ permissionKey: "tools:use", scope: { providerTypes: ["mcp_remote_http", "paperclip_plugin"] } }])).toMatchObject({ changed: false });
    expect(coversPluginTools({ allow: ["tool:x"] })).toBe(true);
  });

  it("widens a grant limited to other provider types instead of adding a second one", () => {
    const merged = mergeToolsGrant([other, { permissionKey: "tools:use", scope: { providerType: "mcp_remote_http", allow: ["tool:a"] } }]);
    expect(merged.changed).toBe(true);
    expect(merged.grants.filter((g) => g.permissionKey === "tools:use")).toEqual([
      { permissionKey: "tools:use", scope: { providerTypes: ["mcp_remote_http", "paperclip_plugin"], allow: ["tool:a"] } },
    ]);
  });

  it("never widens a grant limited another way: it asks a person instead", () => {
    const narrow = { permissionKey: "tools:use", scope: { applicationKey: "github" } };
    const merged = mergeToolsGrant([narrow]);
    expect(merged.changed).toBe(false);
    expect(merged.grants).toEqual([narrow]);
    expect(merged.conflict).toMatch(/limited to .*applicationKey.*Add plugin tools/);
  });

  it("collapses duplicates to the widest", () => {
    const merged = mergeToolsGrant([{ permissionKey: "tools:use", scope: { applicationKey: "x" } }, { permissionKey: "tools:use", scope: null }]);
    expect(merged).toMatchObject({ changed: true, conflict: null });
    expect(merged.grants).toEqual([{ permissionKey: "tools:use", scope: null }]);
  });
});

describe("the Account Manager hire", () => {
  it("the hire task lists the CRM skills and the company operating manual", () => {
    const draft = hireTaskDraft(ACCOUNT_MANAGER_ROLE);
    expect(draft.title).toBe("Hire: Account Manager (CRM agent)");
    for (const slug of ["pib-crm-records", "pib-crm-outbound", "pib-company-os"]) expect(draft.description).toContain(`\`${slug}\``);
    expect(draft.description).toContain("Setup → Team");
  });

  it("start-hire opens the hire task; hire-options offers the draft; only a person may do either", async () => {
    const { harness } = await boot();
    const options = await harness.performAction<{ draft: { title: string } }>("crm.hire-options", {}, { companyId: CO, actor: BOARD });
    expect(options.draft.title).toBe("Hire: Account Manager (CRM agent)");
    const started = await harness.performAction<{ hire: { issueId: string; status: string } }>("crm.start-hire", {}, { companyId: CO, actor: BOARD });
    expect(started.hire.status).toBe("open");
    const task = (await crmIssues(harness)).find((i) => i.id === started.hire.issueId)!;
    expect(task).toMatchObject({ originId: "hire:account-manager", status: "backlog" });
    await expect(harness.performAction("crm.start-hire", {}, { companyId: CO, actor: { type: "agent", agentId: "a1" } as never })).rejects.toThrow(/Only a board user/);
  });

  it("linking wires the agent: merged tools grant, waiting CRM work handed over, then new work goes to it", async () => {
    const { harness, store } = await boot();
    harness.seed({
      agents: [
        { id: "am-1", companyId: CO, name: "Nomsa", status: "idle", adapterConfig: { paperclipSkillSync: { desiredSkills: ["plugin/partnersinbiz-crm/crm-records"] } } } as never,
        { id: "op-1", companyId: CO, name: "Operator", status: "idle" } as never,
      ],
      principalGrants: [{ id: "g1", companyId: CO, principalType: "agent", principalId: "am-1", permissionKey: "tools:use", scope: { providerType: "mcp_remote_http" } } as never],
    });
    await setRoles(harness, { operatorAgentId: "op-1", operatorStatus: "idle" });
    // Work that waited: one unassigned lead follow-up, one held by the Operator, one approval that must stay with a person.
    const free = await harness.ctx.issues.create({ companyId: CO, title: "Follow up lead: X", originKind: "plugin:partnersinbiz.crm", originId: "lead:mail:x", status: "todo" });
    const operatorHeld = await harness.ctx.issues.create({ companyId: CO, title: "Reply from Y", originKind: "plugin:partnersinbiz.crm", originId: "reply:m1", status: "todo", assigneeAgentId: "op-1" });
    const approval = await harness.ctx.issues.create({ companyId: CO, title: "Approve email sending", originKind: "plugin:partnersinbiz.crm", originId: "sequence-email:s1", status: "todo" });

    const linked = await harness.performAction<{ agent: { id: string }; steps: string[]; instructions: string[] }>("crm.link-agent", { agentId: "am-1" }, { companyId: CO, actor: BOARD });
    expect(linked.agent.id).toBe("am-1");
    expect(linked.steps.join("\n")).toMatch(/Granted plugin tool access/);
    expect(linked.steps.join("\n")).toMatch(/Handed Nomsa 2 waiting CRM issues/);
    // It lacks crm-outbound: say how to fix it.
    expect(linked.instructions.join("\n")).toMatch(/`pib-crm-outbound`/);
    const grants = await harness.ctx.authorization.grants.list({ companyId: CO, principalType: "agent", principalId: "am-1" });
    expect(grants.filter((g) => g.permissionKey === "tools:use")).toEqual([expect.objectContaining({ scope: { providerTypes: ["mcp_remote_http", "paperclip_plugin"] } })]);
    expect((await harness.ctx.issues.get(free.id, CO))!.assigneeAgentId).toBe("am-1");
    expect((await harness.ctx.issues.get(operatorHeld.id, CO))!.assigneeAgentId).toBe("am-1");
    expect((await harness.ctx.issues.get(approval.id, CO))!.assigneeAgentId ?? null).toBeNull();

    // The snapshot names it for the Cockpit; re-sync is safe to run again.
    const again = await harness.performAction<{ grant: string }>("crm.resync-agent", {}, { companyId: CO, actor: BOARD });
    expect(again.grant).toBe("already_present");
    expect(store.companies).toBeTruthy();
    await harness.performAction("crm.unlink-agent", {}, { companyId: CO, actor: BOARD });
    await expect(harness.performAction("crm.resync-agent", {}, { companyId: CO, actor: BOARD })).rejects.toThrow(/No Account Manager is linked yet/);
  });

  it("a hire task links the matching new agent by itself", async () => {
    const { harness } = await boot();
    await harness.performAction("crm.start-hire", {}, { companyId: CO, actor: BOARD });
    harness.seed({ agents: [{ id: "am-2", companyId: CO, name: "Account Manager", status: "idle", createdAt: new Date() } as never] });
    await harness.emit("agent.created", {}, { companyId: CO, entityId: "am-2" });
    const load = await harness.performAction<{ hire: { agent: { id: string } | null } }>("crm.load", {}, { companyId: CO, actor: BOARD });
    expect(load.hire.agent?.id).toBe("am-2");
  });

  it("new CRM work goes to the linked Account Manager at once, before the Cockpit shares it; a paused one falls back", async () => {
    const store = (await import("./helpers/crm.js")).seed();
    store.enrollments = [{ id: "e1", company_id: CO, sequence_id: "seq-intro", contact_id: "ada", status: "running", step_position: 1, next_due_at: "2026-01-01T00:00:00Z", open_issue_id: null, sending_key: null, mail_thread_id: null, mail_last_message_id: null, created_at: "x" }];
    const { harness } = await boot({ store });
    harness.seed({ agents: [{ id: "am-1", companyId: CO, name: "Nomsa", status: "idle" } as never] });
    await harness.ctx.state.set({ scopeKind: "company", scopeId: CO, namespace: "pib-hire", stateKey: "role:account-manager" }, { agentId: "am-1", linkedAt: "2026-09-27T08:00:00Z", linkedBy: "manual", hire: null });
    await setRoles(harness, { ownerUserId: "user-peet" });
    await harness.runJob("open-due-steps");
    expect((await crmIssues(harness))[0]).toMatchObject({ assigneeAgentId: "am-1" });

    harness.seed({ agents: [{ id: "am-1", companyId: CO, name: "Nomsa", status: "paused" } as never] });
    store.enrollments![0] = { ...store.enrollments![0]!, open_issue_id: null, step_position: 2, next_due_at: "2026-01-01T00:00:00Z" };
    await harness.runJob("open-due-steps");
    const second = (await crmIssues(harness)).find((i) => i.title.startsWith("Follow up"))!;
    expect(second).toMatchObject({ assigneeUserId: "user-peet" });
  });

  it("the worker names the CRM skills the agent lacks, not the Cockpit's manual", () => {
    expect(missingRoleSkills({ adapterConfig: { paperclipSkillSync: { desiredSkills: [] } } })).toEqual(["pib-crm-records", "pib-crm-outbound"]);
    expect(missingRoleSkills({ adapterConfig: { paperclipSkillSync: { desiredSkills: ["plugin/partnersinbiz-crm/crm-records", "pib-crm-outbound"] } } })).toEqual([]);
  });
});

type Call = { url: string; method: string; body: unknown };

/** Stubs the host: the company's skill library, the agent's skills, and skill sync. */
function stubHost(input: { library: string[] | "error"; have: string[]; syncStatus?: number }) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.startsWith("/api/companies/")) {
      if (input.library === "error") return new Response("{}", { status: 403 });
      return new Response(JSON.stringify(input.library.map((key) => ({ key }))), { status: 200 });
    }
    if (method === "GET") return new Response(JSON.stringify({ desiredSkills: input.have }), { status: 200 });
    if ((input.syncStatus ?? 200) !== 200) return new Response(JSON.stringify({ error: "Board access required" }), { status: input.syncStatus });
    return new Response("{}", { status: 200 });
  });
  return calls;
}

const KEYS = ROLE_SKILLS.map((s) => s.key);

describe("the page keeps the role skills attached", () => {
  it("attaches the missing role skills that exist, and the extra skills of installed modules", async () => {
    const billing = EXTRA_SKILLS[0]!;
    const calls = stubHost({ library: [...KEYS, billing], have: [KEYS[0]!] });
    const note = await attachIfMissing({ agentId: "a1", agentName: "Nomsa", companyId: CO, skills: ROLE_SKILLS, extras: EXTRA_SKILLS });
    expect(note).toEqual({ ok: true, line: "Attached the pib-crm-outbound and pib-company-os skills to Nomsa. Also added 1 skill from the other modules it uses." });
    const syncs = calls.filter((c) => c.method === "POST").map((c) => c.body);
    expect(syncs).toEqual([{ mode: "add", desiredSkills: [billing] }, { mode: "add", desiredSkills: [KEYS[1], KEYS[2]] }]);
  });

  it("a skill the company does not have yet (the operating manual before the Cockpit upgrade) is not counted as missing", async () => {
    const calls = stubHost({ library: [KEYS[0]!, KEYS[1]!], have: [KEYS[0]!, KEYS[1]!] });
    expect(await attachIfMissing({ agentId: "a1", agentName: "Nomsa", companyId: CO, skills: ROLE_SKILLS, extras: EXTRA_SKILLS })).toBeNull();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("the Attach skills button says what it attached and what comes later", async () => {
    stubHost({ library: [KEYS[0]!, KEYS[1]!], have: [] });
    const note = await attachRoleSkills({ agentId: "a1", agentName: "Nomsa", companyId: CO, skills: ROLE_SKILLS, purpose: "x", extras: [] });
    expect(note.ok).toBe(true);
    expect(note.line).toBe("Attached the pib-crm-records and pib-crm-outbound skills to Nomsa, so it knows x. the pib-company-os skill is not in this company yet; it will be attached once it exists.");
  });

  it("a viewer without permission gets a note, never an error", async () => {
    stubHost({ library: KEYS, have: [], syncStatus: 403 });
    expect(await attachIfMissing({ agentId: "a1", agentName: "Nomsa", companyId: CO, skills: ROLE_SKILLS })).toEqual({ ok: false, line: "Nomsa is missing the pib-crm-records, pib-crm-outbound and pib-company-os skills. Add them in Agents → Nomsa → Skills." });
    expect(await companySkillKeys(CO, (async () => new Response("nope", { status: 500 })) as typeof fetch)).toBeNull();
  });
});

describe("the Account Manager box: only when something is wrong", () => {
  const nomsa = (status: string) => ({ name: "Nomsa", status });

  it("shows nothing while the agent works and has its skills", () => {
    for (const status of ["active", "idle", "running"]) expect(agentProblem({ agent: nomsa(status), hire: null, now: NOW })).toBeNull();
  });

  it("no agent and no open hire: one line, fixed in Setup → Team", () => {
    expect(agentProblem({ agent: null, hire: null, now: NOW })).toEqual({
      health: "missing",
      tone: "warn",
      text: "No Account Manager yet, so lead follow-ups, replies and sequence steps go to the Operator or to you.",
      skills: false,
    });
    expect(TEAM_SETUP_HREF).toBe("/setup?section=team#team-account-manager");
  });

  it("a hire task open, stale or closed", () => {
    const hire = { status: "open", createdAt: daysAgo(1), issueStatus: "todo", identifier: "PIB-7" };
    expect(agentProblem({ agent: null, hire, now: NOW })).toMatchObject({ tone: "info", text: "The hire task PIB-7 is open: the new Account Manager is linked as soon as it appears." });
    expect(agentProblem({ agent: null, hire: { ...hire, createdAt: daysAgo(9) }, now: NOW })).toMatchObject({ tone: "warn" });
    expect(agentProblem({ agent: null, hire: { ...hire, issueStatus: "done" }, now: NOW })?.text).toBe("The hire task PIB-7 was closed, but no Account Manager was linked.");
  });

  it("paused, in error, awaiting approval, or missing a skill", () => {
    expect(agentProblem({ agent: nomsa("paused"), hire: null, now: NOW })?.text).toBe("Nomsa is paused, so lead follow-ups, replies and sequence steps go to the Operator or to you.");
    expect(agentProblem({ agent: nomsa("error"), hire: null, now: NOW })?.tone).toBe("bad");
    expect(agentProblem({ agent: nomsa("pending_approval"), hire: null, now: NOW })?.text).toBe("Nomsa is waiting for approval: approve the hire, then resume it.");
    expect(agentProblem({ agent: nomsa("idle"), hire: null, missingSkills: ["pib-crm-outbound"], now: NOW })).toEqual({ health: "attention", tone: "warn", text: "Nomsa is missing the pib-crm-outbound skill.", skills: true });
  });

  it("counts a skill missing only once the page's own check has run", () => {
    expect(stillMissing({ checked: false, attached: false, attachFailed: false, workerMissing: ["pib-crm-records"] })).toEqual([]);
    expect(stillMissing({ checked: true, attached: false, attachFailed: false, workerMissing: ["pib-crm-records"] })).toEqual(["pib-crm-records"]);
    expect(stillMissing({ checked: true, attached: true, attachFailed: false, workerMissing: ["pib-crm-records"] })).toEqual([]);
  });
});
