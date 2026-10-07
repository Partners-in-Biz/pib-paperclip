/**
 * The managed skills: the company operating manual (company-os), the
 * Operator and the Reviewer.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ASK_OWNER_TOOL, ASKING_HEADING, COMPANY_MEMORY_HEADING, MODULES, TEAM_ROLES } from "@partnersinbiz/pib-plugin-kit";
import { COMPANY_OS_SKILL_KEY } from "@partnersinbiz/pib-plugin-kit/team";
import { COMPANY_FLOWS, COMPANY_SKILL_KEY, COMPANY_SKILL_SLUG, companySkillBody, toolNaming } from "../src/company-skill.js";
import { canonicalSkillKey, PLUGIN_KEY } from "../src/constants.js";
import { COMPANY_OS_SKILL_KEY as LOCAL_OS_KEY } from "../src/hire.js";
import manifest from "../src/manifest.js";
import { OPERATOR_SKILL_BODY, REVIEWER_SKILL_BODY, routingMap, SKILLS } from "../src/skills.js";
import { ASKING_REFERENCE, CLOSEOUT_REFERENCE, CREDENTIALS_REFERENCE, GOALS_REFERENCE, HEALTH_REFERENCE, OPERATOR_FILES, OPERATOR_REFERENCE_PATHS, RETRO_REFERENCE } from "../src/skill-references.js";
import { skillVersion } from "@partnersinbiz/pib-plugin-kit";
import { COCKPIT_TOOLS } from "../src/tools.js";
import { onboardingContent } from "../src/onboarding.js";
import { routineFailedCheck } from "@partnersinbiz/pib-plugin-kit";
import { blockedCheck, blockedOwnerCheck, retryStormChecks, runRateChecks, runStreakChecks, stalledCheck } from "../src/watch-model.js";
import { DAILY_ROUTINE_DESCRIPTION, WEEKLY_ROUTINE_DESCRIPTION } from "../src/manifest.js";
import { limitFailureChecks, reviewCoverageCheck, spendChecks, emptyAggregate } from "../src/measure-model.js";
import { backlogCheck, unhandledAsksCheck } from "../src/backlog-model.js";
import { credentialChecks, EXPIRY_BAD_DAYS, EXPIRY_WARN_DAYS } from "../src/credentials-model.js";
import { ATTEST_VALID_DAYS, ATTESTATIONS, attestationChecks, singleAdminCheck } from "../src/security.js";
import { clientEffortChecks } from "../src/client-cost-model.js";
import { closeoutContent } from "../src/closeout-model.js";
import { businessReviewContent } from "../src/goals-model.js";

const skill = (slug: string) => SKILLS.find((s) => s.slug === slug)!;
/** The Operator's whole text: the skill and its reference files (an agent reads a reference when a check or an issue calls for it). */
const OPERATOR_TEXT = [OPERATOR_SKILL_BODY, ...OPERATOR_FILES.map((f) => f.content)].join("\n\n");

describe("the company operating manual (company-os)", () => {
  const os = skill(COMPANY_SKILL_SLUG);

  it("is a Cockpit managed skill whose canonical key is the kit's COMPANY_OS_SKILL_KEY", () => {
    expect(os).toMatchObject({ skillKey: "company-os", slug: "pib-company-os", displayName: "PiB company operating manual" });
    expect(COMPANY_SKILL_KEY).toBe("company-os");
    expect(canonicalSkillKey(PLUGIN_KEY, os.skillKey)).toBe(COMPANY_OS_SKILL_KEY);
    expect(LOCAL_OS_KEY).toBe(COMPANY_OS_SKILL_KEY);
    expect(manifest.skills?.map((s) => s.skillKey)).toContain("company-os");
  });

  it("names every team role and every module, and how their tools are named", () => {
    const body = companySkillBody();
    for (const role of TEAM_ROLES) expect(body, role.title).toContain(`**${role.title}**`);
    for (const module of Object.values(MODULES)) expect(body, module.title).toContain(module.title);
    expect(body).toContain(toolNaming());
    for (const key of ["cockpit", "crm", "mailbox", "social", "seo", "campaigns", "billing", "accounting", "payroll", "partners"]) expect(body, key).toContain(`(\`${key}\`) |`);
    expect(body).toContain(ASK_OWNER_TOOL);
    expect(body).toContain(COMPANY_FLOWS);
  });

  it("has valid frontmatter, the memory and asking sections, and stays under 19,000 characters", () => {
    const markdown = os.markdown!;
    const match = /^---\nname: (pib-company-os)\nslug: (pib-company-os)\ndescription: "([^"\n]+)"\n---\n\n# PiB company operating manual\n/.exec(markdown);
    expect(match, markdown.slice(0, 300)).not.toBeNull();
    expect(match![3]!.length).toBeGreaterThan(80);
    expect(markdown).toContain(COMPANY_MEMORY_HEADING);
    expect(markdown).toContain(ASKING_HEADING);
    expect(markdown.length).toBeLessThan(19_000);
    expect(companySkillBody().length).toBeLessThan(16_000);
  });

  it("says what is true of the code", () => {
    const body = companySkillBody();
    // The client workspace starts on the CRM page; agents cannot use Setup; a person connects social accounts.
    expect(body).toContain("`?client=company:<id>` on the CRM, Social, SEO, Campaigns and Billing pages");
    expect(body).toContain("the Operator gets the owner to fix it in Setup → Team");
    expect(body).toContain("once a person has connected their accounts");
    expect(body).not.toContain("connect their accounts and plan");
    // Cases: the manual names the API, the stable key rule and the types; the flow uses one.
    expect(body).toContain("`POST /api/companies/:companyId/cases`");
    expect(body).toContain("**stable `key`**");
    expect(body).toContain("writes the client's report as a `client_report` case");
    // A block without a way out is flagged after a day (the Cockpit's blocked check).
    expect(body).toContain("`blocked` with an `unblockDescriptor` (who must do what; a block with none is flagged after a day)");
  });
});

describe("hand-off issues always carry a project", () => {
  // A task with no project has no repository: it runs in the agent's empty home folder (2026-10-07, PAR-1553 and PAR-877 failed
  // at setup for the Code Reviewer this way). Both texts that teach the hand-off must say so.
  it("the operating manual says to set projectId, with the PiB Platform case", () => {
    const body = companySkillBody();
    expect(body).toContain("always a `projectId`");
    expect(body).toContain("PiB Platform");
  });
  it("the Operator skill says to set projectId, the PiB Platform case, and what to do when unsure", () => {
    expect(OPERATOR_SKILL_BODY).toContain("**Always set `projectId`**");
    expect(OPERATOR_SKILL_BODY).toContain("PiB Platform");
    expect(OPERATOR_SKILL_BODY).toContain("instead of creating it without one");
  });
});

describe("the Operator skill", () => {
  it("speaks of the owner, never a name, in the skill, the hire and the routines", () => {
    for (const s of SKILLS) expect([s.markdown, ...((s as { files?: Array<{ content: string }> }).files ?? []).map((f) => f.content)].join("\n"), s.slug).not.toMatch(/\bPeet\b/);
    expect(JSON.stringify(manifest.routines)).not.toMatch(/\bPeet\b/);
  });

  it("has who owns what from TEAM_ROLES, and the daily team check", () => {
    const map = routingMap();
    for (const role of TEAM_ROLES) expect(map, role.title).toContain(`**${role.title}**`);
    // The Account Manager also works in the modules of its extra skills.
    expect(map).toMatch(/\*\*Account Manager\*\* \| .+ \| CRM, Billing, Email campaigns, Mailbox \(Gmail\), Partners \|/);
    expect(OPERATOR_SKILL_BODY).toContain(map);
    for (const text of [
      "routines on, roles staffed (Setup → Team), asks answered",
      "Route unassigned work",
      "`company-brief` → `team`",
      "Onboard new client",
      `\`${PLUGIN_KEY}:ask-owner\``,
      `\`${PLUGIN_KEY}:update-company-profile\``,
      "Never assign issues to people yourself",
    ]) expect(OPERATOR_SKILL_BODY, text).toContain(text);
    expect(OPERATOR_SKILL_BODY).not.toContain("leads → CRM owner");
    expect(OPERATOR_SKILL_BODY).not.toContain("invoices → Bookkeeper");
  });
});

describe("the Operator knows how to act on each watch problem", () => {
  const demo = new Date("2026-10-03T12:00:00.000Z");
  const agents = new Map([["seo", { id: "seo", name: "SEO Specialist" }]]);
  const titles = () => [
    routineFailedCheck({ routineKey: "k", title: "Run today's SEO", pluginTitle: "SEO", routineId: "r", at: demo.toISOString() }).title,
    runRateChecks([{ agentId: "seo", status: "succeeded", errorCode: null, count: 10 }, { agentId: "seo", status: "failed", errorCode: "x", count: 10 }], agents)[0]!.title,
    runStreakChecks(Array.from({ length: 3 }, (_, i) => ({ agentId: "seo", status: "failed", errorCode: "adapter_failed", startedAt: new Date(demo.getTime() - i * 60_000).toISOString(), issueId: null, identifier: null })), agents)[0]!.title,
    retryStormChecks([{ issueId: "i", identifier: "PAR-1", title: null, failed: 5, errorCode: null, codes: 0, agentId: null, firstFailedAt: null, lastError: null }], agents)[0]!.title,
    blockedCheck([{ id: "b", identifier: "PAR-2", title: "t", since: "2026-09-28T00:00:00.000Z" }], 1, demo)!.title,
    stalledCheck([{ id: "s", identifier: "PAR-3", title: "t", assigneeAgentId: "seo", updatedAt: "2026-10-02T00:00:00.000Z", lastRunAt: null }], 1, agents, demo)!.title,
  ];

  it("quotes the words each problem is titled with, so a renamed check cannot orphan its instructions", () => {
    const [routine, rate, streak, storm, blocked, stalled] = titles();
    expect(routine).toContain("failed its last run");
    expect(rate).toMatch(/failed \d+% of its runs$/);
    expect(streak).toContain("times in a row with");
    expect(storm).toContain("keeps failing");
    expect(blocked).toContain("blocked with no way out");
    expect(stalled).toContain("in progress with nobody working on");
    // The daily loop names the two it works itself (step 5); the reference says what to do for every one.
    for (const text of ["blocked with no way out", "in progress with nobody working on"]) expect(OPERATOR_SKILL_BODY, text).toContain(text);
    for (const text of ["failed its last run", "% of its runs", "times in a row with", "keeps failing", "blocked with no way out", "in progress with nobody working on"]) expect(HEALTH_REFERENCE, text).toContain(text);
  });

  it("says what to do: never just retry, give a blocked issue a way out, wake a stalled assignee", () => {
    for (const text of ["never just retry", "spawn E2BIG", "continuation issue", "workspace_validation_failed"]) expect(HEALTH_REFERENCE, text).toContain(text);
    for (const text of [
      "`blockedByIssueIds`",
      "`unblockDescriptor`",
      "PATCH /api/issues/{id}",
      "set it `todo` and wake the assignee, or cancel it with a reason",
      "assignee idle for 12 hours",
    ]) expect(OPERATOR_SKILL_BODY, text).toContain(text);
  });

  it("tells the Operator only what the host lets it do about a failed routine: read the runs, hand the run to the assignee", () => {
    const line = HEALTH_REFERENCE.split("\n").find((l) => l.includes("failed its last run"))!;
    // Reading a routine's runs is open to every agent; running one is not (the host answers 403 unless the agent is its assignee).
    expect(line).toContain("`GET /api/routines/{id}/runs` (any agent");
    expect(line).toContain("only its assignee may `POST /api/routines/{id}/run`");
    expect(line).toContain("(you, for the Cockpit's own routines)");
    expect(line).toContain('open an issue for the assignee: "Run <routine> once now and report"');
    expect(line).toContain("or at the next schedule");
    // No role this plugin cannot name for every company, and no button the Operator may not press.
    expect(line).toContain("the role that owns code, or the owner if none");
    for (const text of ["Developer", "Run now"]) expect(OPERATOR_TEXT, text).not.toContain(text);
    // The same promise in the check's own fix text, so the skill and the check cannot drift apart.
    const fix = routineFailedCheck({ routineKey: "k", title: "Run today's SEO", pluginTitle: "SEO", routineId: "r-1", at: demo.toISOString() }).fix!;
    expect(fix).toContain("only the routine's assignee (or the owner) may POST /api/routines/r-1/run");
    expect(fix).toContain("open an issue for the assignee");
  });

  it("stays inside the skill budget with room to spare, and the manual inside its own", () => {
    const operator = skill("pib-operator");
    expect(operator.markdown!.length).toBeLessThan(18_950);
    // The references are read on demand, each on its own: none is a wall of text.
    for (const file of OPERATOR_FILES) expect(file.content.length, file.path).toBeLessThan(8_000);
    expect(skill(COMPANY_SKILL_SLUG).markdown!.length).toBeLessThan(19_000);
    expect(companySkillBody().length).toBeLessThan(16_000);
  });
});

describe("the Reviewer skill", () => {
  it("drops checks nobody can do and matches the modules' opt-out standard", () => {
    for (const gone of ["preview text", "Renders on mobile", "physical address", "company settings", "brand profile"]) expect(REVIEWER_SKILL_BODY, gone).not.toContain(gone);
    expect(REVIEWER_SKILL_BODY).toContain("reply STOP");
    expect(REVIEWER_SKILL_BODY).toContain("List-Unsubscribe");
    expect(REVIEWER_SKILL_BODY).toContain(`\`${PLUGIN_KEY}:company-profile\``);
    expect(REVIEWER_SKILL_BODY).toContain("`partnersinbiz.crm:get-client-profile`");
    expect(REVIEWER_SKILL_BODY).toContain("Timing, when it has a time");
  });

  it("names only tools that exist (other modules' tools read from their declarations)", () => {
    const declared = (plugin: string) => {
      const source = readFileSync(new URL(`../../plugin-${plugin}/src/tools.ts`, import.meta.url), "utf8");
      return new Set([...source.matchAll(/name: "([a-z0-9-]+)"/g)].map((m) => m[1]!));
    };
    const own = new Set(COCKPIT_TOOLS.map((t) => t.name));
    // The Reviewer's and the Operator's tool names, and the onboarding checklist's.
    const texts = [REVIEWER_SKILL_BODY, OPERATOR_SKILL_BODY, onboardingContent({ clientRef: "company:x", clientName: "X", dealTitle: "d", dealValue: null, wonAt: "2026-09-26", prefix: null, modules: { crm: true, billing: true, social: true, seo: true }, staff: {} }).description];
    const mentioned = [...new Set(texts.flatMap((text) => [...text.matchAll(/partnersinbiz\.([a-z]+):([a-z0-9-]+)/g)].map((m) => `${m[1]}:${m[2]}`)))];
    expect(mentioned.length).toBeGreaterThan(10);
    for (const ref of mentioned) {
      const [plugin, name] = ref.split(":") as [string, string];
      const tools = plugin === "cockpit" ? own : declared(plugin);
      expect(tools.has(name), `partnersinbiz.${ref}`).toBe(true);
    }
    // The SEO checks named without the prefix exist too.
    for (const name of ["check-meta", "check-canonical", "validate-schema", "crawler-sim"]) expect(declared("seo").has(name), name).toBe(true);
  });
});

describe("the Operator's references (Wave 3)", () => {
  const operator = skill("pib-operator") as { markdown: string; files?: Array<{ path: string; content: string }> };

  it("the skill ships eight reference files, and the body names every one of them", () => {
    expect(operator.files?.map((f) => f.path)).toEqual([
      "references/health-checks.md",
      "references/closeout-review.md",
      "references/retro-and-improvements.md",
      "references/goals-and-business-review.md",
      "references/credentials-and-custody.md",
      "references/asking-with-an-effect.md",
      "references/quality-gates.md",
      "references/skill-coach.md",
    ]);
    for (const path of Object.values(OPERATOR_REFERENCE_PATHS)) {
      expect(operator.files!.some((f) => f.path === path), path).toBe(true);
      expect(OPERATOR_SKILL_BODY, path).toContain(`\`${path}\``);
    }
    // The Reviewer stays one file; the manual carries one reference (how to look at a page) for every role, and the Acceptance skill its own two.
    expect(skill("pib-reviewer")).not.toHaveProperty("files");
    expect((skill(COMPANY_SKILL_SLUG) as { files?: Array<{ path: string }> }).files?.map((f) => f.path)).toEqual(["references/screenshots.md"]);
    expect(companySkillBody()).toContain("`references/screenshots.md`");
  });

  it("a re-run of acceptance is asked for through an issue to the Acceptance agent: the Cockpit has no Run button to point at", () => {
    const gates = operator.files!.find((f) => f.path === "references/quality-gates.md")!.content;
    expect(gates).not.toMatch(/Run acceptance now/i);
    expect(gates).toContain("open an issue for the Acceptance agent");
    expect(gates).toContain("The Cockpit has no Run button");
  });

  it("a change to a reference changes the skill's version, so every company's copy is brought up to date", () => {
    const base = skillVersion(operator as never);
    const edited = { ...operator, files: operator.files!.map((f, i) => (i === 0 ? { ...f, content: `${f.content}\nNew rule.` } : f)) };
    expect(skillVersion(edited as never)).not.toBe(base);
    expect(skillVersion({ ...operator, files: [] } as never)).not.toBe(base);
    expect(skillVersion(operator as never)).toBe(base);
  });

  it("the daily loop and the retro list the steps the routines list, in the same order", () => {
    for (const text of ["1. **Read.**", "2. **Health first.**", "3. **Check the team", "4. **Route unassigned work.**", "5. **Unblock agents.**", "6. **Stuck in the flows.**", "7. **Check what waits on the owner.**", "8. **Plan today.**", "9. **Improvements and reviews.**", "10. **Post the brief**", "11. Close the routine issue"]) expect(OPERATOR_SKILL_BODY, text).toContain(text);
    expect(DAILY_ROUTINE_DESCRIPTION).toContain("9. Look at `improvements`");
    expect(DAILY_ROUTINE_DESCRIPTION).toContain("11. Close this issue");
    for (const text of ["1. ", "2. ", "3. ", "4. ", "5. ", "6. Carry out the proposals that do not need the owner"]) expect(OPERATOR_SKILL_BODY, text).toContain(text);
    for (const tool of [`${PLUGIN_KEY}:measure-report`, `${PLUGIN_KEY}:improvement-list`, `${PLUGIN_KEY}:improvement-propose`, `${PLUGIN_KEY}:memory-review`]) {
      expect(OPERATOR_SKILL_BODY, tool).toContain(tool);
      expect(WEEKLY_ROUTINE_DESCRIPTION, tool).toContain(tool);
    }
    expect(WEEKLY_ROUTINE_DESCRIPTION).toContain("NO SIGNAL");
    expect(OPERATOR_SKILL_BODY).toContain("**NO SIGNAL**");
  });

  it("quotes the words every new check is titled with, so a renamed check cannot orphan its instructions", () => {
    const now = new Date("2026-10-03T12:00:00.000Z");
    const titles: string[] = [];
    const add = (...checks: Array<{ title: string } | null | undefined>) => titles.push(...checks.filter((c): c is { title: string } => !!c).map((c) => c.title));
    add(...spendChecks({ usd24h: 120, usd7d: 600, usdBaseline7d: 140, daysWithData: 10 }, { dailyUsd: 50, weeklyUsd: 400 }));
    add(...limitFailureChecks({ total: 7, byAgent: [{ agentId: "a", count: 7 }], since: now.toISOString() }, new Map(), 24));
    add(reviewCoverageCheck({ done: 20, reviewed: 5, byPolicy: 3, byIssue: 2, coverage: 0.25, latencyP50Hours: 4, latencyP90Hours: 9, latencySamples: 5, unreviewed: [{ id: "x", identifier: "PAR-1" }], rule: "" } as never));
    add(backlogCheck(Array.from({ length: 12 }, (_, i) => ({ id: `i${i}`, kind: "issue" as const, since: "2026-09-20T00:00:00.000Z" })), now), unhandledAsksCheck([{ identifier: "PAR-1", issueId: "i", askedAt: "2026-09-20T00:00:00.000Z" }, { identifier: "PAR-2", issueId: "j", askedAt: "2026-09-21T00:00:00.000Z" }]));
    add(...credentialChecks([{ id: "c", companyId: "x", seedKey: null, name: "GitHub token", system: "GitHub", livesIn: null, owner: null, expiresAt: "2026-10-10", expiryNote: null, rotateHow: null, rotateHref: null, verifyWith: null, lastVerifiedAt: null, lastVerifyStatus: "invalid", lastVerifyDetail: null, status: "active", notes: null, createdAt: "", updatedAt: "" }, { id: "b", companyId: "x", seedKey: null, name: "Old", system: "X", livesIn: null, owner: null, expiresAt: null, expiryNote: null, rotateHow: null, rotateHref: null, verifyWith: null, lastVerifiedAt: null, lastVerifyStatus: null, lastVerifyDetail: null, status: "burned", notes: null, createdAt: "", updatedAt: "" }], now));
    add(...attestationChecks(new Map(), now), singleAdminCheck(1, false));
    add(...clientEffortChecks([{ clientRef: "company:a", name: "Brightside", lifecycle: "customer", matchedBy: "name", projects: [], usd: 200, runs: 1, doneIssues: 1, paidZar: 1000, skippedCurrencies: [], ratio: 0.9 }, { clientRef: "company:b", name: "Northwind", lifecycle: "customer", matchedBy: "name", projects: [], usd: 200, runs: 1, doneIssues: 1, paidZar: 0, skippedCurrencies: [], ratio: null }]));
    add(blockedOwnerCheck([{ id: "b", identifier: "PAR-2", title: "t", since: "2026-09-28T00:00:00.000Z", ownerAgentId: "x", ownerName: "Dev", why: "paused" }], 1, now));
    expect(titles.length).toBeGreaterThanOrEqual(14);
    // The wording each title is built from, without the numbers and names that change.
    const fragments = [
      "Notional AI spend is", "in 24 hours", "this week", "times the usual", "failed on the subscription limit", "of finished code work was reviewed",
      "wait on the owner", "have gone unhandled for 3 days", "expires in", "refused", "exposed and not yet replaced", "Confirm board sign-up is closed", "Confirm the backup key is stored outside your Mac",
      "Confirm a second break-glass admin", "Confirm the Mac that holds the keys is backed up", "Only one person can administer this company", "agent effort is", "nothing paid in 30 days",
      "on an agent that cannot act",
    ];
    for (const fragment of fragments) {
      expect(titles.some((t) => t.includes(fragment.replace(/^N /, ""))), `a check titled with "${fragment}"`).toBe(true);
      expect(OPERATOR_TEXT, `the Operator's references say what to do for "${fragment}"`).toContain(fragment);
    }
    // And the kit's checks and the improvements check, named by the words they carry.
    for (const text of ["Agents with no run profile", "Agents that cannot use company memory", "Approvals with nobody to decide them", "lacks skill", "has no plugin tool access", "improvements past the re-check date", "skills not synced"]) expect(HEALTH_REFERENCE, text).toContain(text);
  });

  it("names only tools that exist, and only parameters those tools declare", () => {
    const tools = new Map(COCKPIT_TOOLS.map((t) => [t.name, new Set(Object.keys(((t.parametersSchema ?? {}) as { properties?: Record<string, unknown> }).properties ?? {}))]));
    for (const file of OPERATOR_FILES) {
      for (const m of file.content.matchAll(/`partnersinbiz\.cockpit:([a-z0-9-]+)`/g)) expect(tools.has(m[1]!), `${file.path}: ${m[1]}`).toBe(true);
    }
    // Bare tool names inside prose (improvement-propose, goal-set, credential-record...) are real too.
    for (const file of OPERATOR_FILES) {
      for (const m of file.content.matchAll(/(?<![.\w-])(improvement-(?:propose|list|resolve)|goal-(?:set|list)|credential-(?:list|record)|measure-report|open-closeout-review|memory-[a-z]+|ask-owner)(?![\w-])/g)) expect(tools.has(m[1]!), `${file.path}: ${m[1]}`).toBe(true);
    }
    // The parameters the references tell the Operator to pass.
    const expectParams: Array<[string, string[]]> = [
      ["measure-report", ["windowHours", "parts"]],
      ["open-closeout-review", ["projectId", "issueId"]],
      ["improvement-propose", ["sourceFactId"]],
      ["improvement-resolve", ["resultValue", "drop", "archiveFact"]],
      ["goal-list", ["sources"]],
      ["goal-set", ["metricKey", "targetValue", "period", "unit", "id", "value"]],
      ["credential-list", ["verify"]],
      ["credential-record", ["id", "expiresAt", "markVerified", "status"]],
      ["ask-owner", ["effect"]],
    ];
    for (const [tool, params] of expectParams) for (const param of params) expect(tools.get(tool)!.has(param), `${tool}.${param}`).toBe(true);
    // The values the references name are values the tools accept.
    const parts = ((COCKPIT_TOOLS.find((t) => t.name === "measure-report")!.parametersSchema as { properties: { parts: { items: { enum: string[] } } } }).properties.parts.items.enum);
    expect(parts).toEqual(["agents", "projects", "trees", "review", "limits", "clients"]);
    expect(RETRO_REFERENCE).toContain('parts: ["clients"]');
  });

  it("each reference says what its own issue or check carries, in the words the code writes", () => {
    // The close-out review's checklist.
    const closeout = closeoutContent({ kind: "final", scopeLabel: "Launch", scopeName: "Launch", fromLabel: "x", reason: "r", projectId: "p", total: { ...emptyAggregate(), runs: 3 }, issues: { total: 3, done: 3, cancelled: 0, blocked: 0, blockedDays: 0 }, agents: [], closedPerDay: null, reopenWakes: 0, unblockWakes: 0 } as never).description;
    for (const line of ["Read the evidence.", "Decide what to change.", "Record what was learned.", "Close the project in Paperclip.", "Close this issue"]) {
      expect(closeout, line).toContain(line);
      expect(CLOSEOUT_REFERENCE.toLowerCase(), line).toContain(line.toLowerCase().replace(/\.$/, "").replace("close the project in paperclip", "close the project"));
    }
    // The business review.
    const review = businessReviewContent({ weekLabel: "5 Oct", rows: [{ goal: { id: "g", title: "Leads", metricKey: "manual", metricLabel: null, unit: null, direction: "higher", targetValue: 30, period: "week" }, progress: { state: "behind", current: 10, progress: 0.3, change: null }, note: null }] as never, proposedWaiting: 0, cockpitHref: "/cockpit" });
    expect(review.title).toContain("Business review: week of");
    expect(GOALS_REFERENCE).toContain("**Business review: week of <date>**");
    expect(OPERATOR_SKILL_BODY).toContain("**Business review**");
    // The credentials and confirmations: the four confirmations the register names, and the 30 and 7 day rule.
    for (const a of ATTESTATIONS) expect(a.title.length).toBeGreaterThan(10);
    expect(CREDENTIALS_REFERENCE).toContain("**30 days** (warn) and **7 days**");
    expect(`${EXPIRY_WARN_DAYS} ${EXPIRY_BAD_DAYS}`).toBe("30 7");
    expect(CREDENTIALS_REFERENCE).toContain("180 days");
    expect(ATTEST_VALID_DAYS).toBe(180);
    // The ledger's rules: the default re-check, the tolerance and the overdue grace.
    expect(RETRO_REFERENCE).toContain("(default 14 days)");
    expect(RETRO_REFERENCE).toContain("within 5%");
    expect(RETRO_REFERENCE).toContain("more than 3 days past its date");
    // Asking with an effect: the three keys that exist.
    for (const key of ["mailbox.delegate", "social.connect-account", "cockpit.grant-memory-tools"]) expect(ASKING_REFERENCE, key).toContain(key);
  });
});
