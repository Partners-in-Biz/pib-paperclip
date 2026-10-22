/**
 * Done-checks for the Cockpit's own issues: the onboarding checklist rule
 * (ticked, or skipped with a reason), the System health rule, what reopens,
 * what passes, what is never checked, and the hand-over to the Operator.
 */
import { describe, expect, it } from "vitest";
import { companyRoles, DONE_CHECK_MAX_REOPENS, PIB_PLUGINS, routeWork, type CockpitSnapshot } from "@partnersinbiz/pib-plugin-kit";
import { ORIGIN } from "../src/constants.js";
import { checklistItems, checklistResult, healthResult, plainWords, reasonWords, settledIn, SKIP_HINT, isSpike, spikePlugins, spikeResult, SPIKE_HINT } from "../src/done-checks.js";
import { refreshHealthIssue } from "../src/health.js";
import { onboardingContent, onDealWon } from "../src/onboarding.js";
import { createEnv, registerCockpit } from "../src/register.js";
import { KIT_ROLES_STATE, saveTeam } from "../src/roles.js";
import { fakeCtx, fixedClock, type FakeAgent, type FakeIssue } from "./helpers/fake-ctx.js";

const A = "company-a";
const NOW = "2026-09-28T08:00:00.000Z";
const agents: FakeAgent[] = [
  { id: "op", companyId: A, name: "Olive", status: "active" },
  { id: "am", companyId: A, name: "Ama", status: "active" },
];

function setup() {
  const fake = fakeCtx({ savedConfigs: { [A]: { healthIssue: true, escalation: { enabled: false } } }, prefixes: { [A]: "PIB" }, agents: agents.map((a) => ({ ...a })) });
  const clock = fixedClock(NOW);
  const env = createEnv(fake.ctx, clock.now);
  registerCockpit(fake.ctx, env);
  return { ...fake, env, clock };
}

type Setup = ReturnType<typeof setup>;

const CHECKLIST = onboardingContent({
  clientRef: "company:nw",
  clientName: "Northwind",
  dealTitle: "Retainer",
  dealValue: null,
  wonAt: NOW,
  prefix: "PIB",
  modules: { crm: true, billing: true, social: true, seo: true },
  staff: { "account-manager": "Ama", "seo-specialist": null, social: null },
}).description;

async function onboardingIssue(s: Setup): Promise<FakeIssue> {
  await saveTeam(s.env, A, { operatorAgentId: "op" }, "user-1");
  await onDealWon(s.env, { companyId: A, payload: { key: "crm:deal:d1:won", dealId: "d1", title: "Retainer", valueMinor: 100_000, currency: "ZAR", clientKind: "company", clientRef: "nw", clientName: "Northwind", firstWin: true, wonAt: NOW } });
  return [...s.issues.values()].find((i) => i.originKind === ORIGIN.onboarding)!;
}

/** Someone marks the issue done (the host's issue.updated event follows). */
async function close(s: Setup, issue: FakeIssue, actorType: "agent" | "user" = "agent") {
  issue.status = "done";
  await s.fire("issue.updated", { entityId: issue.id, entityType: "issue", companyId: A, actorType, actorId: actorType === "agent" ? "op" : "user-1" });
}

const agentComment = (s: Setup, issue: FakeIssue, body: string) => s.ctx.issues.createComment(issue.id, body, A, { authorAgentId: "op" });

describe("the onboarding checklist rule (pure)", () => {
  it("reads the checklist: each line, ticked or not, named by its bold label", () => {
    const items = checklistItems(CHECKLIST);
    expect(items.map((i) => [i.label, i.key, i.ticked, i.closing])).toEqual([
      ["Account Manager", "account manager", false, false],
      ["One ask for every grant", "one ask for every grant", false, false],
      ["SEO Specialist", "seo specialist", false, false],
      ["Social agent", "social agent", false, false],
      ["Close this issue with links to each module's…", "close this issue with links to", false, true],
    ]);
    expect(checklistItems("* [X] Done thing\n1. [ ] **Numbered**: yes\n- [] not a box\nplain line").map((i) => [i.label, i.ticked])).toEqual([["Done thing", true], ["Numbered", false]]);
    expect(plainWords("**SEO** [site](/x) `n/a`, don't")).toBe("seo site n/a don t");
  });

  it("is done when every line is ticked; the closing line is the close itself", () => {
    expect(checklistResult(CHECKLIST.replace(/- \[ \] (?!Close)/g, "- [x] "), [])).toEqual({ done: true });
    const open = checklistResult(CHECKLIST, []);
    expect(open.done).toBe(false);
    expect(open.missing).toEqual(["Not ticked: Account Manager", "Not ticked: One ask for every grant", "Not ticked: SEO Specialist", "Not ticked: Social agent", SKIP_HINT]);
  });

  it("counts a line ticked or skipped (with a reason) in a comment", () => {
    const comments = [
      { body: "Progress:\n- [x] Account Manager: profile filled, retainer set up\n- [x] **One ask for every grant**: asked on PIB-40" },
      { body: "Skipped: SEO Specialist, because the client has no website yet." },
      { body: "Social agent: n/a, they do not want social media" },
    ];
    expect(checklistResult(CHECKLIST, comments)).toEqual({ done: true });
    // A skip needs a reason; "for now" is not one. A deleted comment does not count.
    expect(checklistResult(CHECKLIST, [...comments.slice(0, 2), { body: "Skipped Social agent for now" }]).missing).toEqual(["Not ticked: Social agent", SKIP_HINT]);
    expect(checklistResult(CHECKLIST, [...comments.slice(0, 2), { ...comments[2]!, deletedAt: NOW }]).missing).toEqual(["Not ticked: Social agent", SKIP_HINT]);
    // An unticked copy of the line is not a tick.
    expect(settledIn("- [ ] SEO Specialist: working on it", { key: "seo specialist" })).toBeNull();
    // The reopen comment itself never settles anything.
    expect(settledIn(`**Not done yet** (Client onboarding):\n- Not ticked: SEO Specialist\n- ${SKIP_HINT}`, { key: "seo specialist" })).toBeNull();
    expect(reasonWords("skipped seo specialist because the client has no website", "seo specialist")).toBe(4);
  });

  it("passes an issue with no checklist (a person rewrote it)", () => {
    expect(checklistResult("Onboard them, thanks.", [])).toEqual({ done: true });
    expect(checklistResult(null, [])).toEqual({ done: true });
  });
});

describe("the System health rule (pure)", () => {
  it("is done when nothing is left, else lists the first five and says to leave it open", () => {
    expect(healthResult([])).toEqual({ done: true });
    const entries = Array.from({ length: 7 }, (_, i) => ({ status: i ? "warn" as const : "bad" as const, title: `Check ${i}` }));
    const result = healthResult(entries);
    expect(result.done).toBe(false);
    expect(result.missing).toEqual(["Problem: Check 0", "Warning: Check 1", "Warning: Check 2", "Warning: Check 3", "Warning: Check 4", "And 2 more, listed on this issue.", "Leave this issue open: the Cockpit closes it itself once every check is ok (it updates every hour)."]);
  });
});

describe("closing the Cockpit's issues", () => {
  it("listens to issue.updated once: every extra subscription would deliver each event again", () => {
    const s = setup();
    expect(s.handlers.get("issue.updated")).toHaveLength(1);
    expect(s.handlers.get("issue.comment.created")).toHaveLength(1);
  });

  it("opens onboarding with a stable, prefixed origin id", async () => {
    const s = setup();
    const issue = await onboardingIssue(s);
    expect(issue.originId).toBe("cockpit:onboarding:company:nw");
  });

  it("reopens an agent's early close with what is missing and wakes the agent", async () => {
    const s = setup();
    const issue = await onboardingIssue(s);
    s.wakeups.length = 0;
    await close(s, issue);
    expect(issue.status).toBe("todo");
    const comment = s.comments.filter((c) => c.issueId === issue.id).at(-1)!.body;
    expect(comment).toContain("**Not done yet** (Client onboarding)");
    expect(comment).toContain("- Not ticked: SEO Specialist");
    expect(comment).toContain("Skipped: <item>, because <why>");
    expect(s.wakeups).toContain(issue.id);
  });

  it("passes when the checklist is ticked, or finished another way (ticked or skipped in comments)", async () => {
    const s = setup();
    const issue = await onboardingIssue(s);
    issue.description = issue.description.replace("- [ ] **Account Manager**", "- [x] **Account Manager**").replace("- [ ] **One ask", "- [x] **One ask");
    await agentComment(s, issue, "- [x] SEO Specialist: first sprint created (PIB-51)");
    await agentComment(s, issue, "Skipped: Social agent, because the client has no social accounts.");
    const before = s.comments.length;
    await close(s, issue);
    expect(issue.status).toBe("done");
    expect(s.comments.length).toBe(before);
  });

  it("never checks a person's close", async () => {
    const s = setup();
    const issue = await onboardingIssue(s);
    await close(s, issue, "user");
    expect(issue.status).toBe("done");
  });

  it("checks onboarding issues opened before the ids had the plugin part", async () => {
    const s = setup();
    await saveTeam(s.env, A, { operatorAgentId: "op" }, "user-1");
    const created = await s.ctx.issues.create({ companyId: A, title: "Onboard new client: Old (company:old)", description: "## Checklist\n- [ ] **Account Manager**: profile", status: "todo", assigneeAgentId: "op", originKind: ORIGIN.onboarding, originId: "onboarding:company:old" } as never);
    const issue = s.issues.get(created.id)!;
    await close(s, issue);
    expect(issue.status).toBe("todo");
  });

  it("hands a third early close to the Operator, even before the team was re-sent", async () => {
    const s = setup();
    const issue = await onboardingIssue(s);
    // The kit's copy of the team is kept by the Cockpit, so kit helpers route like it does.
    expect(await companyRoles(s.ctx, A)).toMatchObject({ operatorAgentId: "op", operatorStatus: "active" });
    expect(await routeWork(s.ctx, A, ["operator"])).toMatchObject({ assigneeAgentId: "op", via: "operator" });
    // A company whose roles were saved before this version has no copy yet: the check refreshes it.
    const key = KIT_ROLES_STATE(A);
    s.state.delete(`${key.scopeKind}:${key.scopeId}:${key.namespace}:${key.stateKey}`);
    for (let i = 1; i < DONE_CHECK_MAX_REOPENS; i += 1) await close(s, issue);
    s.updates.length = 0;
    await close(s, issue);
    expect(issue).toMatchObject({ status: "todo", assigneeAgentId: "op" });
    expect(s.updates.at(-1)!.patch).toMatchObject({ status: "todo", assigneeAgentId: "op" });
    expect(s.comments.filter((c) => c.issueId === issue.id).at(-1)!.body).toContain("Handing this to the Operator");
  });

  it("reopens the System health issue while problems remain, and lets it close once all is ok", async () => {
    const s = setup();
    await saveTeam(s.env, A, { operatorAgentId: "op" }, "user-1");
    const bad: CockpitSnapshot = { plugin: PIB_PLUGINS.billing, title: "Billing", checkedAt: NOW, kpis: [], health: [{ key: "outbox", title: "Cross-plugin deliveries", status: "bad", detail: "2 failed" }], waiting: [], activity: [], quality: [] };
    s.store.snapshots = [{ company_id: A, plugin_key: PIB_PLUGINS.billing, kind: "cockpit", payload: bad, checked_at: NOW, received_at: NOW }];
    const created = await refreshHealthIssue(s.env, A);
    const issue = s.issues.get((created as { issueId: string }).issueId)!;
    expect(issue.originId).toBe(`cockpit:health:${A}`);
    await close(s, issue);
    expect(issue.status).toBe("todo");
    const comment = s.comments.filter((c) => c.issueId === issue.id).at(-1)!.body;
    expect(comment).toContain("**Not done yet** (System health)");
    expect(comment).toContain("- Problem: Cross-plugin deliveries");
    // Fixed: the close stands.
    s.store.snapshots![0]!.payload.health = [];
    await close(s, issue);
    expect(issue.status).toBe("done");
  });

  it("ignores other plugins' issues and other statuses", async () => {
    const s = setup();
    await saveTeam(s.env, A, { operatorAgentId: "op" }, "user-1");
    const created = await s.ctx.issues.create({ companyId: A, title: "CRM work", description: "- [ ] **Something**", status: "todo", assigneeAgentId: "am", originKind: "plugin:partnersinbiz.crm:lead", originId: "crm:lead-followup:c1" } as never);
    const issue = s.issues.get(created.id)!;
    await close(s, issue);
    expect(issue.status).toBe("done");
    const onboarding = await onboardingIssue(s);
    onboarding.status = "in_review";
    await s.fire("issue.updated", { entityId: onboarding.id, entityType: "issue", companyId: A, actorType: "agent", actorId: "op" });
    expect(onboarding.status).toBe("in_review");
  });
});

describe("spike done-check (pure)", () => {
  it("recognizes spikes by title or description marker", () => {
    expect(isSpike({ title: "Spike: prove tool X works" })).toBe(true);
    expect(isSpike({ title: "Check something important", description: "pib:spike" })).toBe(true);
    expect(isSpike({ title: null, description: "SPIKE in production" })).toBe(true);
    expect(isSpike({ title: "Work on the spike", description: null })).toBe(true);
    expect(isSpike({ title: "Regular issue", description: "Normal work" })).toBe(false);
  });

  it("extracts plugin names from text with required prefix", () => {
    const plugins1 = spikePlugins("Check plugin-crm and partnersinbiz.social");
    expect(plugins1).toContain("partnersinbiz.crm");
    expect(plugins1).toContain("partnersinbiz.social");
    expect(plugins1).toHaveLength(2);

    const plugins2 = spikePlugins("Spike plugin-billing and partnersinbiz.seo");
    expect(plugins2).toEqual(["partnersinbiz.billing", "partnersinbiz.seo"]);

    // Bare words without prefix should NOT match (regression test)
    const plugins3 = spikePlugins("Spike: setup of the ads seo partners");
    expect(plugins3).toHaveLength(0);

    const plugins4 = spikePlugins("no known plugins");
    expect(plugins4).toHaveLength(0);
  });

  it("marks done when evidence exists after the threshold", () => {
    const now = new Date("2026-10-20T12:00:00Z");
    const before = new Date("2026-10-20T10:00:00Z");
    const after = new Date("2026-10-20T14:00:00Z");

    const result = spikeResult({
      startedAt: before.toISOString(),
      comments: [{ body: "**Evidence:** Tool output confirmed working", createdAt: after }],
      attachments: [],
      deployedAt: [{ plugin: "partnersinbiz.crm", at: before.toISOString() }],
    });
    expect(result.done).toBe(true);
  });

  it("marks not done without evidence or with evidence before the threshold", () => {
    const startTime = "2026-10-20T10:00:00Z";
    const deployTime = "2026-10-20T12:00:00Z";
    const beforeDeploy = "2026-10-20T11:00:00Z";

    const result1 = spikeResult({
      startedAt: startTime,
      comments: [],
      attachments: [],
      deployedAt: [{ plugin: "partnersinbiz.crm", at: deployTime }],
    });
    expect(result1.done).toBe(false);
    expect(result1.missing).toContain(SPIKE_HINT);
    expect(result1.missing?.[0]).toContain("No evidence yet");

    const result2 = spikeResult({
      startedAt: startTime,
      comments: [{ body: "**Evidence:** early check", createdAt: beforeDeploy }],
      attachments: [],
      deployedAt: [{ plugin: "partnersinbiz.crm", at: deployTime }],
    });
    expect(result2.done).toBe(false);
  });

  it("ignores deleted evidence comments and uses attachments", () => {
    const threshold = "2026-10-20T12:00:00Z";
    const after = "2026-10-20T14:00:00Z";

    const result = spikeResult({
      startedAt: threshold,
      comments: [{ body: "**Evidence:** deleted check", createdAt: after, deletedAt: threshold }],
      attachments: [{ createdAt: after }],
      deployedAt: [{ plugin: "partnersinbiz.crm", at: threshold }],
    });
    expect(result.done).toBe(true);
  });

  it("mentions deploy time unknown when no plugin is found", () => {
    const result = spikeResult({
      startedAt: "2026-10-20T10:00:00Z",
      comments: [],
      attachments: [],
      deployedAt: [],
    });
    expect(result.done).toBe(false);
    expect(result.missing?.some((m) => m.includes("Name the plugin"))).toBe(true);
  });

  it("rejects evidence posted before startedAt", () => {
    const startedAt = "2026-10-20T12:00:00Z";
    const beforeStarted = "2026-10-20T10:00:00Z";
    const deployTime = "2026-10-20T11:00:00Z";

    const result = spikeResult({
      startedAt,
      comments: [{ body: "**Evidence:** early check", createdAt: beforeStarted }],
      attachments: [],
      deployedAt: [{ plugin: "partnersinbiz.crm", at: deployTime }],
    });
    expect(result.done).toBe(false);
    expect(result.missing?.[0]).toContain("No evidence yet");
  });

  it("rejects evidence when deploy time is later than evidence", () => {
    const startedAt = "2026-10-20T10:00:00Z";
    const deployTime = "2026-10-20T14:00:00Z";
    const evidence = "2026-10-20T12:00:00Z";

    const result = spikeResult({
      startedAt,
      comments: [{ body: "**Evidence:** check output", createdAt: evidence }],
      attachments: [],
      deployedAt: [{ plugin: "partnersinbiz.crm", at: deployTime }],
    });
    expect(result.done).toBe(false);
    expect(result.missing?.[0]).toContain("No evidence yet");
  });

  it("accepts evidence when deploy time is earlier than evidence", () => {
    const startedAt = "2026-10-20T10:00:00Z";
    const deployTime = "2026-10-20T12:00:00Z";
    const evidence = "2026-10-20T14:00:00Z";

    const result = spikeResult({
      startedAt,
      comments: [{ body: "**Evidence:** check output", createdAt: evidence }],
      attachments: [],
      deployedAt: [{ plugin: "partnersinbiz.crm", at: deployTime }],
    });
    expect(result.done).toBe(true);
  });
});

describe("spike done-check (end-to-end)", () => {
  it("reopens a spike issue without evidence", async () => {
    const s = setup();
    await saveTeam(s.env, A, { operatorAgentId: "op" }, "user-1");

    // Create a plain agent issue titled "Spike: ..."
    const created = await s.ctx.issues.create({
      companyId: A,
      title: "Spike: prove plugin-crm tool X on live",
      description: "Test if the CRM tool works in production.",
      status: "todo",
      assigneeAgentId: "am",
      originKind: undefined,
      originId: null,
    } as never);
    const issue = s.issues.get(created.id)!;

    // Agent closes it without evidence
    await close(s, issue);
    expect(issue.status).toBe("todo");
    const reopenComment = s.comments.filter((c) => c.issueId === issue.id).at(-1)!.body;
    expect(reopenComment).toContain("**Not done yet** (Spike)");
    expect(reopenComment).toContain(SPIKE_HINT);
  });

  it("ignores regular issues without 'spike'", async () => {
    const s = setup();
    await saveTeam(s.env, A, { operatorAgentId: "op" }, "user-1");

    const created = await s.ctx.issues.create({
      companyId: A,
      title: "Regular work: fix something",
      description: "Just normal work.",
      status: "todo",
      assigneeAgentId: "am",
      originKind: undefined,
      originId: null,
    } as never);
    const issue = s.issues.get(created.id)!;

    const before = s.comments.length;
    await close(s, issue);
    expect(issue.status).toBe("done");
    expect(s.comments.length).toBe(before);
  });
});
