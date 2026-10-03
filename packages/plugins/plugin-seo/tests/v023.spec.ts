import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as db from "../src/db.js";
import { AI_BOTS, GEO_WEIGHTS } from "../src/checks/geo.js";
import { GEO_AUDIT_MAX_AGE_DAYS, completionBlocker, MIN_AI_SAMPLES, type CompletionFacts } from "../src/engine/guards.js";
import { AI_ENGINES } from "../src/engine/geo.js";
import { clientGa4Email, geoFirewallItem } from "../src/engine/items.js";
import { plainError, plainWarning } from "../src/engine/plain.js";
import { buildSetupChecklist, type SetupFacts } from "../src/engine/setup.js";
import { SITE_WIDE } from "../src/engine/chunks.js";
import { companyInfo } from "../src/service/common.js";
import { addGeoTasks, upgradeSprintPlan } from "../src/service/upgrade.js";
import { ANALYTICS_DOC, GEO_DOC, PAGE_GROUPS_DOC } from "../src/skill-docs.js";
import { OUTRANK_DOC, SKILL_BODY, SKILLS, TOOLS_DOC } from "../src/skills.js";
import { GEO_CODE_TYPES, GEO_AUDIT_TYPES, GEO_TASK_KEYS, GEO_TASKS, TEMPLATE_V5_ADDED } from "../src/templates/geo.js";
import { BUSINESS_TYPES, PLANS } from "../src/templates/plans.js";
import { dueDayFor, TEMPLATE_VERSION } from "../src/templates/outrank-90.js";
import { PLAYBOOKS } from "../src/templates/playbooks.js";
import { SEO_TOOL_DECLARATIONS } from "../src/tools.js";
import { executed, seoHost, sprintRoutes, taskRow, type Route } from "./helpers/seo-host.js";

describe("the GEO tasks in every plan", () => {
  it("carries the same eight tasks in all four plans, due where the plan says", () => {
    expect(GEO_TASKS.map((t) => [t.templateKey, t.week, t.dueDay ?? null])).toEqual([
      ["w0-geo-crawlers", 0, null],
      ["w1-geo-llms-txt", 1, null],
      ["w1-geo-entity", 1, null],
      ["w2-geo-baseline", 2, null],
      ["w4-geo-answers", 4, null],
      ["w6-geo-brand", 6, null],
      ["w8-geo-recheck", 8, null],
      ["w13-geo-recheck", 13, 90],
    ]);
    for (const type of BUSINESS_TYPES) {
      const plan = PLANS[type];
      for (const task of GEO_TASKS) expect(plan.tasks.find((t) => t.templateKey === task.templateKey), `${type} ${task.templateKey}`).toMatchObject({ taskType: task.taskType, owner: "agent", autopilotEligible: true, focus: "AI search" });
      expect(plan.tasks.filter((t) => GEO_TASK_KEYS.includes(t.templateKey))).toHaveLength(8);
      expect(plan.tasks.map((t) => t.week)).toEqual([...plan.tasks.map((t) => t.week)].sort((a, b) => a - b));
    }
    expect([PLANS.saas, PLANS.local, PLANS.professional, PLANS.ecommerce].map((p) => p.tasks.length)).toEqual([50, 54, 54, 53]);
    expect(dueDayFor(13, 90)).toBe(90);
    expect(TEMPLATE_VERSION).toBe(5);
    expect(TEMPLATE_V5_ADDED).toEqual(GEO_TASK_KEYS);
  });

  it("has a playbook for each, naming the tools that exist, the honest limits and the client's policy", () => {
    const tools = new Set(SEO_TOOL_DECLARATIONS.map((t) => t.name));
    for (const task of GEO_TASKS) {
      const playbook = PLAYBOOKS[task.playbook]!;
      expect(playbook, task.templateKey).toBeDefined();
      for (const tool of playbook.tools) if (!tool.includes(":")) expect(tools.has(tool), `${task.templateKey} → ${tool}`).toBe(true);
    }
    expect(PLAYBOOKS["w0-geo-crawlers"]!.steps.join(" ")).toMatch(/Training crawlers .* are the client's policy, not a defect/);
    expect(PLAYBOOKS["w0-geo-crawlers"]!.steps.join(" ")).toMatch(/never change a rule for them yourself/);
    expect(PLAYBOOKS["w1-geo-llms-txt"]!.steps.join(" ")).toMatch(/no major search engine or AI company has said it uses it/);
    expect(PLAYBOOKS["w1-geo-llms-txt"]!.steps.join(" ")).toMatch(/skip-task.*never a Needs you item/);
    expect(PLAYBOOKS["w1-geo-entity"]!.steps.join(" ")).toMatch(/Never invent a profile/);
    expect(PLAYBOOKS["w2-geo-baseline"]!.steps.join(" ")).toMatch(/do not guess/);
    expect(PLAYBOOKS["w2-geo-baseline"]!.steps.join(" ")).toMatch(/refused/);
    expect(PLAYBOOKS["w13-geo-recheck"]!.tools).toContain("list-ga4-summary");
    expect(PLAYBOOKS["w8-geo-recheck"]!.tools).not.toContain("list-ga4-summary");
    // The day-90 report and snapshot carry the new numbers.
    expect(PLAYBOOKS["w13-audit-report"]!.steps.join(" ")).toMatch(/readiness score.*list-ai-mentions/);
    expect(PLAYBOOKS["w13-audit-report"]!.steps.join(" ")).toContain("list-ga4-summary");
  });

  it("opens the site-changing ones in the site project and leaves the research ones where they are", () => {
    expect([...GEO_CODE_TYPES].sort()).toEqual(GEO_TASKS.filter((t) => ["geo-crawler-access", "geo-llms-txt", "geo-entity-schema", "geo-answer-blocks"].includes(t.taskType)).map((t) => t.taskType).sort());
    expect(GEO_AUDIT_TYPES).toContain("geo-brand-consistency");
    expect(GEO_AUDIT_TYPES).not.toContain("geo-mention-check");
  });
});

describe("closing a GEO task needs its evidence on record", () => {
  const facts = (extra: Partial<CompletionFacts> = {}): CompletionFacts => ({ activeKeywords: 9, keywordsWithoutIntent: 0, priorityKeywords: 3, directoriesNotStarted: 0, latestSnapshotDay: 90, geoAuditAgeDays: 2, aiSamplesRecent: 8, ...extra });

  it("refuses a sampling task without enough answers, and says what to do when no tool returns one", () => {
    expect(completionBlocker("geo-mention-check", facts({ aiSamplesRecent: 2 }))).toMatch(/Only 2 AI answers were sampled in the last 14 days. Ask at least 5 questions and record each with record-ai-mentions first.*skip-task with that reason instead of guessing/);
    expect(completionBlocker("geo-mention-check", facts({ aiSamplesRecent: 1 }))).toMatch(/Only 1 AI answer was sampled/);
    expect(completionBlocker("geo-mention-check", facts({ aiSamplesRecent: MIN_AI_SAMPLES }))).toBeNull();
    expect(completionBlocker("geo-mention-check", facts({ aiSamplesRecent: undefined }))).toMatch(/Only 0 AI answers/);
    // Enough answers is not enough without an audit from the last two weeks.
    expect(completionBlocker("geo-mention-check", facts({ geoAuditAgeDays: null }))).toMatch(/No geo-audit was recorded in the last 14 days/);
    expect(completionBlocker("geo-mention-check", facts({ geoAuditAgeDays: GEO_AUDIT_MAX_AGE_DAYS + 1 }))).toMatch(/No geo-audit/);
    expect(completionBlocker("geo-mention-check", facts({ geoAuditAgeDays: GEO_AUDIT_MAX_AGE_DAYS }))).toBeNull();
  });

  it("refuses a site-changing GEO task until a geo-audit is on record, and asks for it after the change is live", () => {
    for (const type of ["geo-crawler-access", "geo-llms-txt", "geo-entity-schema", "geo-answer-blocks", "geo-brand-consistency"]) {
      expect(completionBlocker(type, facts({ geoAuditAgeDays: null })), type).toMatch(/Run geo-audit with the sprintId \(after your change is live\)/);
      expect(completionBlocker(type, facts({ geoAuditAgeDays: 0 })), type).toBeNull();
    }
    // Other task types are unaffected.
    expect(completionBlocker("page-write", facts({ geoAuditAgeDays: null, aiSamplesRecent: 0 }))).toBeNull();
  });

  it("reads both facts from the sprint's own tables in one query", async () => {
    const h = seoHost({ routes: [[/FROM plugin_seo_8099f8879a\.keywords k WHERE k\.sprint_id = \$1 AND k\.retired_at IS NULL\) AS active_keywords|AS active_keywords/, () => [{ active_keywords: 9, no_intent: 0, priority: 3, dirs: 0, latest_day: 90, live_social: 0, geo_age: 3, ai_samples: 7 }]], ...sprintRoutes] });
    expect(await db.completionFacts(h.env.ctx.db, "sp-1")).toMatchObject({ geoAuditAgeDays: 3, aiSamplesRecent: 7 });
    const none = seoHost({ routes: [[/AS active_keywords/, () => [{ active_keywords: 0, geo_age: null, ai_samples: 0 }]]] });
    expect(await db.completionFacts(none.env.ctx.db, "sp-1")).toMatchObject({ geoAuditAgeDays: null, aiSamplesRecent: 0 });
    const sql = h.queries.find((q) => /AS active_keywords/.test(q.sql))!.sql;
    expect(sql).toContain("plugin_seo_8099f8879a.geo_audits");
    expect(sql).toContain("plugin_seo_8099f8879a.ai_mentions");
  });
});

describe("existing sprints get the GEO tasks from the daily run, and nothing else changes", () => {
  const sprint = async (h: ReturnType<typeof seoHost>, extra: Partial<db.Sprint> = {}) => ({ ...(await db.getSprint(h.env.ctx.db, "co-1", "sp-1"))!, ...extra });
  const has = (keys: string[]): Route => [/FROM plugin_seo_8099f8879a\.sprint_tasks/, () => keys.map((k, i) => taskRow({ id: `t-${i}`, template_key: k }))];

  it("adds the eight tasks of the sprint's plan, with the plan's due days, in one idempotent insert", async () => {
    const h = seoHost({ routes: sprintRoutes });
    const s = await sprint(h, { templateVersion: 4 });
    expect(await addGeoTasks(h.env, s)).toBe(1); // the fake database reports one row; the statement carries all eight
    const [insert] = executed(h, /INSERT INTO plugin_seo_8099f8879a\.sprint_tasks/);
    expect(insert!.sql).toContain("ON CONFLICT (sprint_id, template_key) WHERE template_key IS NOT NULL DO NOTHING");
    const rows = Array.from({ length: insert!.params.length / 17 }, (_, i) => insert!.params.slice(i * 17, (i + 1) * 17));
    expect(rows).toHaveLength(8);
    expect(rows.map((r) => [r[3], r[4], r[6]])).toEqual(GEO_TASKS.map((t) => [t.templateKey, t.week, dueDayFor(t.week, t.dueDay)]));
    expect(rows.every((r) => r[1] === "co-1" && r[2] === "sp-1" && r[14] === "template" && r[11] === "agent")).toBe(true);
  });

  it("adds only the ones a sprint lacks, and none at all to a sprint that has them", async () => {
    const partial = seoHost({ routes: [has(["w0-geo-crawlers", "w1-geo-llms-txt", "w1-meta", "w5-post-1"]), ...sprintRoutes] });
    await addGeoTasks(partial.env, await sprint(partial));
    const [insert] = executed(partial, /INSERT INTO plugin_seo_8099f8879a\.sprint_tasks/);
    const keys = Array.from({ length: insert!.params.length / 17 }, (_, i) => insert!.params[i * 17 + 3]);
    expect(keys).toEqual(["w1-geo-entity", "w2-geo-baseline", "w4-geo-answers", "w6-geo-brand", "w8-geo-recheck", "w13-geo-recheck"]);
    const full = seoHost({ routes: [has(GEO_TASK_KEYS), ...sprintRoutes] });
    expect(await addGeoTasks(full.env, await sprint(full))).toBe(0);
    expect(executed(full, /INSERT INTO plugin_seo_8099f8879a\.sprint_tasks/)).toHaveLength(0);
  });

  it("brings a sprint on version 4 to version 5 without touching an open issue, and says so once on its root issue", async () => {
    const h = seoHost({ routes: [has(["w0-meta-tags"]), ...sprintRoutes] });
    const info = await companyInfo(h.env, "co-1");
    const result = await upgradeSprintPlan(h.env, info, await sprint(h, { templateVersion: 4 }), { id: "agent-1", status: "idle" });
    expect(result).toMatchObject({ upgraded: true, added: 1 });
    expect(executed(h, /UPDATE plugin_seo_8099f8879a\.sprints SET/).some((u) => u.params.includes(5))).toBe(true);
    expect(h.updates).toEqual([]); // no issue was changed
    expect(h.wakeups).toEqual([]);
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]).toMatchObject({ id: "root-1" });
    expect(h.comments[0]!.body).toMatch(/Plan v5 adds 1 task for AI search \(GEO\)/);
    expect(h.comments[0]!.body).toContain("Nothing that was already open changed");
    // A sprint already on version 5 is left alone.
    const current = seoHost({ routes: sprintRoutes });
    expect((await upgradeSprintPlan(current.env, info, await sprint(current, { templateVersion: 5 }), null)).upgraded).toBe(false);
    expect(current.executes).toHaveLength(0);
  });

  it("does it for the software plan too, in the same pass as its older rewrites", async () => {
    const h = seoHost({ routes: [has(["w0-meta-tags"]), ...sprintRoutes] });
    const info = await companyInfo(h.env, "co-1");
    const result = await upgradeSprintPlan(h.env, info, await sprint(h, { templateVersion: 3, templateId: "outrank-90" }), { id: "agent-1", status: "idle" });
    expect(result.upgraded).toBe(true);
    expect(executed(h, /INSERT INTO plugin_seo_8099f8879a\.sprint_tasks/).some((e) => e.params.includes("w0-geo-crawlers"))).toBe(true);
  });
});

describe("the skill", () => {
  const skill = SKILLS[0]!;
  const ref = (name: string) => skill.files!.find((f) => f.path === `references/${name}.md`)!.content;

  it("points at the three new references and the six new tools, within the character budget", () => {
    expect(skill.markdown!.length).toBeLessThan(18_000);
    for (const file of ["geo.md", "analytics.md", "page-groups.md"]) expect(skill.markdown).toContain(file);
    for (const tool of ["geo-audit", "record-ai-mentions", "list-ai-mentions", "connect-ga4", "list-ga4-summary", "split-task"]) {
      expect(SKILL_BODY + TOOLS_DOC, tool).toContain(tool);
      expect(TOOLS_DOC, tool).toContain(`### ${tool}`);
    }
    expect(SKILL_BODY).toMatch(/Readiness is not visibility/);
    expect(SKILL_BODY).toMatch(/Training crawlers .* are the client's policy: report, never change/);
    expect(SKILL_BODY).toMatch(/a mention needs a quote or source URL; never guess/);
    expect(SKILL_BODY).toMatch(/quote only what it returns/);
  });

  it("generates the GEO reference from the code: every crawler, the weights, the evidence rule", () => {
    for (const bot of AI_BOTS) expect(GEO_DOC, bot.token).toContain(`\`${bot.token}\``);
    for (const [section, weight] of Object.entries(GEO_WEIGHTS)) expect(GEO_DOC, section).toContain(`| ${section} | ${weight} |`);
    for (const engine of AI_ENGINES) expect(GEO_DOC, engine).toContain(`\`${engine}\``);
    expect(GEO_DOC).toMatch(/The plugin has no account with any AI provider and calls none of them/);
    expect(GEO_DOC).toMatch(/no major search engine or AI company has said it uses llms\.txt/);
    expect(GEO_DOC).toContain("geo_firewall");
    expect(GEO_DOC).toMatch(/What to avoid/);
    for (const task of GEO_TASKS) expect(GEO_DOC).toContain(`\`${task.templateKey}\``);
    expect(ref("geo")).toBe(GEO_DOC);
  });

  it("documents GA4 states and page-group sizes as the code has them", () => {
    for (const state of ["connected", "needs_access", "needs_api", "needs_property", "bad_property", "no_service_account"]) expect(ANALYTICS_DOC, state).toContain(`\`${state}\``);
    expect(ANALYTICS_DOC).toMatch(/never writes to a property/);
    expect(ANALYTICS_DOC).toMatch(/say "landed on", not "because of"/);
    for (const [type, kind] of Object.entries(SITE_WIDE)) expect(PAGE_GROUPS_DOC, type).toContain(`| \`${type}\` | ${kind.size} |`);
    expect(PAGE_GROUPS_DOC.slice(PAGE_GROUPS_DOC.indexOf("## Do not"))).toMatch(/Call `complete-task` on a group issue; closing it is the signal/);
    expect(ref("analytics")).toBe(ANALYTICS_DOC);
    expect(ref("page-groups")).toBe(PAGE_GROUPS_DOC);
  });

  it("lists the GEO tasks and their playbooks in the plan reference", () => {
    for (const task of GEO_TASKS) {
      expect(OUTRANK_DOC).toContain(`\`${task.templateKey}\``);
      expect(OUTRANK_DOC).toContain(task.title);
    }
    expect(ref("clients-and-plans")).toContain("### Timeline");
    expect(ref("clients-and-plans")).toContain("### Local presence");
  });
});

describe("Google Analytics in the checklist and in plain words", () => {
  const facts = (ga4: NonNullable<SetupFacts["sprint"]>["ga4"]): SetupFacts => ({
    prefix: "PIB",
    settingsPath: null,
    settingsSaved: true,
    serviceAccount: { configured: true, email: "paperclip-seo@example.iam.gserviceaccount.com", error: null },
    agent: { id: "a1", status: "idle" },
    pagespeedKey: true,
    bingKey: true,
    sprint: { siteName: "Acme", siteUrl: "https://acme.co.za", isClient: true, siteAccess: "repo", siteProjectId: "p1", repoUrl: "https://github.com/pib/acme", changePolicy: "merge_seo_scope", autopilotMode: "safe", property: "sc-domain:acme.co.za", gscVia: "service_account", bingVerified: true, ga4 },
  });
  const item = (f: SetupFacts) => buildSetupChecklist(f).find((i) => i.key === "ga4_property")!;

  it("is optional, done once connected, and gives the exact steps and links until then", () => {
    const todo = item(facts({ propertyId: null, connected: false, lastError: null, lastPullOn: null }));
    expect(todo.status).toBe("warn");
    expect(todo.label).toContain("optional");
    expect(todo.detail).toContain("paperclip-seo@example.iam.gserviceaccount.com");
    expect(todo.steps.join(" ")).toMatch(/Property access management/);
    expect(todo.steps.join(" ")).toContain("paperclip-seo@example.iam.gserviceaccount.com");
    expect(todo.links.map((l) => l.url).join(" ")).toMatch(/analyticsdata\.googleapis\.com/);
    expect(todo.next).toMatch(/attributes organic traffic and key events to this sprint's pages/);
    const done = item(facts({ propertyId: "222222222", connected: true, lastError: null, lastPullOn: "2026-10-03" }));
    expect(done).toMatchObject({ status: "done", steps: [], links: [] });
    expect(done.detail).toContain("222222222");
    expect(item(facts({ propertyId: "1", connected: false, lastError: "no access", lastPullOn: null })).detail).toContain("no access");
    expect(buildSetupChecklist({ ...facts(undefined), sprint: { ...facts(undefined).sprint!, ga4: undefined } }).some((i) => i.key === "ga4_property")).toBe(false);
  });

  it("says Google Analytics errors in one plain sentence, and names the warning's area", () => {
    expect(plainError("Google Analytics Data API has not been used in project 1 before or it is disabled.", "ga4")).toMatchObject({ needsPerson: true, tone: "warn", text: expect.stringContaining("not switched on") });
    expect(plainError("Analytics Data: User does not have sufficient permissions for this property.", "ga4")!.text).toMatch(/owner adds it as a Viewer/);
    expect(plainError("Exhausted property tokens: quota", "ga4")).toMatchObject({ tone: "info", needsPerson: false });
    expect(plainError("Google does not know property 9: Invalid property id", "ga4")!.text).toMatch(/Property ID/);
    expect(plainError("The Google service account cannot be used: the key is not valid JSON", "ga4")).toMatchObject({ tone: "bad" });
    expect(plainError("boom", "ga4")!.text).toBe("The Google Analytics pull failed; the next daily run tries again.");
    expect(plainWarning("GA4: The service account (x) cannot read any GA4 property yet")).toMatchObject({ area: "Google Analytics", tab: "integrations", needsPerson: true });
    expect(plainWarning("AI search: connection refused").area).toBe("AI-search check");
  });

  it("writes the client's email without jargon, with the service account to add and the read-only promise", () => {
    const text = clientGa4Email({ clientName: "Acme", siteUrl: "https://acme.co.za", serviceAccountEmail: "paperclip-seo@example.iam.gserviceaccount.com" });
    expect(text).toContain("Hi Acme,");
    expect(text).toContain("paperclip-seo@example.iam.gserviceaccount.com");
    expect(text).toMatch(/Property access management/);
    expect(text).toMatch(/Role: Viewer/);
    expect(text).toMatch(/read only: we cannot change anything/);
  });

  it("asks the site's owner to check the firewall with the bots, the limit of what was seen and the way to say it is fine", () => {
    const item = geoFirewallItem({ siteName: "Acme", siteUrl: "https://www.acme.co.za", clientName: "Acme" }, [{ token: "PerplexityBot", detail: "HTTP 403" }, { token: "OAI-SearchBot", detail: null }], ["t-1"]);
    expect(item).toMatchObject({ key: "geo_firewall", kind: "grant", check: "geo_firewall", taskIds: ["t-1"] });
    // Advice, not a blocker: a probe from an ordinary server address cannot tell a real block from a CDN that lets the real bots in.
    expect(item.optional).toBe(true);
    expect(item.title).toBe("Check that AI search bots get through the firewall of acme.co.za");
    expect(item.why).toContain("PerplexityBot (HTTP 403), OAI-SearchBot");
    expect(item.why).toMatch(/refused .* twice/);
    expect(item.why).toMatch(/may be a false alarm/);
    expect(item.why).toMatch(/verified bots in by their own addresses/);
    expect(item.why).toMatch(/blocks by address range/);
    expect(item.steps.join(" ")).toContain("Check these user agents are allowed: PerplexityBot, OAI-SearchBot");
    expect(item.steps.join(" ")).toMatch(/Fine as it is\? Mark this item done/);
  });
});

describe("the database objects the code uses exist in the migrations", () => {
  const dir = new URL("../migrations/", import.meta.url);
  const sql = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(new URL(f, dir), "utf8")).join("\n");
  const files = ["db.ts", "service/needs-you.ts", "service/tasks.ts", "service/signoff.ts", "service/jobs.ts", "service/thread.ts", "service/preview.ts"];

  it("only uses table names the host's helper accepts (letters and underscores) and that a migration creates", () => {
    const used = new Set<string>();
    for (const f of readdirSync(new URL("../src/service/", import.meta.url)).map((n) => `service/${n}`).concat(["db.ts"])) {
      const text = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
      for (const m of text.matchAll(/\bt\("([A-Za-z0-9_]+)"\)/g)) used.add(m[1]!);
    }
    expect(used.size).toBeGreaterThan(20);
    for (const name of used) {
      expect(name, `t("${name}")`).toMatch(/^[a-z_]+$/); // db.t() refuses digits: a table like ga4_weeks fails at the first query
      expect(sql, name).toContain(`CREATE TABLE plugin_seo_8099f8879a.${name}`);
    }
    expect(files.length).toBeGreaterThan(0);
  });

  it("020 widens the integration providers to ga4 and adds the four tables and the two snapshot columns", () => {
    const m = readFileSync(new URL("020_seo.sql", dir), "utf8");
    expect(m).toContain("DROP CONSTRAINT IF EXISTS integrations_provider_check");
    expect(m).toContain("CHECK (provider IN ('gsc', 'bing', 'pagespeed', 'ga4'))");
    for (const table of ["geo_audits", "ai_mentions", "analytics_weeks", "task_chunks"]) expect(m).toContain(`CREATE TABLE plugin_seo_8099f8879a.${table}`);
    expect(m).toContain("ADD COLUMN geo jsonb");
    expect(m).toContain("ADD COLUMN analytics jsonb");
    expect(m).toContain("CREATE UNIQUE INDEX task_chunks_group ON plugin_seo_8099f8879a.task_chunks (parent_issue_id, seq)");
    expect(m).toContain("CREATE UNIQUE INDEX ai_mentions_sample ON plugin_seo_8099f8879a.ai_mentions (sprint_id, query_key, engine, sampled_on)");
    expect(m).toContain("CREATE UNIQUE INDEX analytics_weeks_week ON plugin_seo_8099f8879a.analytics_weeks (sprint_id, week_start)");
    // An applied migration is never edited: 001 to 019 keep the provider list they shipped with.
    expect(readFileSync(new URL("008_seo.sql", dir), "utf8")).toContain("CHECK (provider IN ('gsc', 'bing', 'pagespeed'))");
  });
});

describe("the tool declarations", () => {
  const decl = (name: string) => SEO_TOOL_DECLARATIONS.find((t) => t.name === name)!;
  const props = (name: string) => (decl(name).parametersSchema as { properties: Record<string, { enum?: string[]; items?: { properties?: Record<string, { enum?: string[] }> } }> }).properties;

  it("groups the new tools and keeps the engine values equal to the service's", () => {
    expect(decl("geo-audit").group).toBe("AI search (GEO)");
    expect(decl("record-ai-mentions").group).toBe("AI search (GEO)");
    expect(decl("list-ai-mentions").group).toBe("AI search (GEO)");
    expect(decl("connect-ga4").group).toBe("Google Analytics");
    expect(decl("list-ga4-summary").group).toBe("Google Analytics");
    expect(decl("split-task").group).toBe("Tasks");
    expect(props("record-ai-mentions").samples!.items!.properties!.engine!.enum).toEqual([...AI_ENGINES]);
  });

  it("tells the agent the rules of evidence in the tool's own description", () => {
    expect(decl("record-ai-mentions").description).toMatch(/never fill a gap with what an assistant would probably say/i);
    expect(decl("record-ai-mentions").description).toMatch(/refused/);
    expect(decl("geo-audit").description).toMatch(/Readiness is not how often AI assistants mention the business/);
    expect(decl("geo-audit").description).toMatch(/training is the client's choice and not scored/);
    expect(decl("connect-ga4").description).toMatch(/read only/);
    expect(decl("connect-ga4").description).toMatch(/Needs you digest/);
    expect(decl("list-ga4-summary").description).toMatch(/never quote a number it did not return/);
    expect(decl("split-task").description).toMatch(/end your run/);
  });
});
