/**
 * The managed skill `seo-sprint` (slug `pib-seo-sprint`). References are
 * generated from the template, the playbooks and the tool declarations so
 * the skill always matches what the tools do.
 */
import type { JsonSchema, PluginManagedSkillDeclaration } from "@paperclipai/plugin-sdk";
import { ASK_OWNER_TOOL, withFrontmatter } from "@partnersinbiz/pib-plugin-kit";
import { SKILL_KEY, SKILL_SLUG } from "./constants.js";
import { PHASE_NAMES, dueDayFor, type SeoTaskTemplate, type SprintPhase } from "./templates/outrank-90.js";
import { BUSINESS_TYPES, PLANS, allPlanTasks, type BusinessType } from "./templates/plans.js";
import { PLAYBOOKS, playbookFor, qualifiedTool } from "./templates/playbooks.js";
import { DUE_TERMS } from "./engine/due.js";
import { SEO_SCOPE } from "./engine/site-change.js";
import { ANALYTICS_DOC, GEO_DOC, PAGE_GROUPS_DOC } from "./skill-docs.js";
import { SEO_TOOL_DECLARATIONS } from "./tools.js";

const SKILL_DESCRIPTION =
  "Run Partners in Biz 90-day SEO sprints in Paperclip end to end: pick the plan that fits the business (local service, professional services, online shop or software), work the due issues with the partnersinbiz.seo tools, change the site through its repo (PR, checks, merge of SEO-scope changes), run Search Console through the service account, and batch the few things only a person can do in a weekly Needs you issue.";

export const SKILL_BODY = `# PiB SEO sprint

You are the SEO Specialist for Partners in Biz. Each site — PiB's own or a client's — has a 90-day **sprint** that follows the plan for its kind of business (42–46 tasks, then open-ended compounding). The \`partnersinbiz.seo\` plugin is the ledger: tasks, keywords, positions, backlinks, content, audits and optimizations live there, and every due task is a Paperclip **sub-issue** of the sprint's root issue ("SEO sprint: <site> (<client>)") in the **SEO** project (client sprints: the client's own project, titles start with "[<client>]" unless they already name the client).

The plugin never writes content and never invents numbers. You do the thinking; the tools record facts. Its one model call is Jev (a classifier, when a TypeSafe key is set) for keyword intent; below 70% confidence it keeps the word-rule guess. Check intents and correct them with \`update-keyword\`.

## Scope: PiB's own sites vs client sprints

A sprint is either **PiB's own** (no client) or for **one client**: a CRM company, or a CRM contact (a sole trader). \`list-sprints\`, \`get-sprint\` and \`today\` carry \`client\` (\`"company:<id>"\`, \`"contact:<id>"\`, or null for own) and \`clientName\`.

- **Creating.** Omit \`client\` only for PiB's own sites. For a client pass \`client: "company:<id>"\` or \`"contact:<id>"\` with the CRM id: find it with \`partnersinbiz.crm:find-records\` and check it with \`partnersinbiz.crm:get-company\`. The client must exist in the CRM; the plugin takes the name from there. Never type a client name in \`siteName\` to fake a client.
- **Working.** Take \`client\` from the sprint you are working on and pass it on to every other PiB tool that takes one. Keywords, content, copy, accounts and evidence stay inside that sprint: never reuse one client's data or accounts for another client or for PiB's own sites.
- **Moving** a sprint to another client is for people only (\`update-sprint\` with \`client\`). One that looks filed under the wrong client: ask once with \`${ASK_OWNER_TOOL}\` (sprint, client it names, client you think it is) and keep working what does not depend on it.

## The plan fits the business

A sprint follows one of four 90-day plans (\`businessType\`): **local**, **professional**, **ecommerce** or **saas**. Before \`create-sprint\` for a client read \`partnersinbiz.crm:get-client-profile\` and pass the one that fits; a mismatch is \`change-plan\` (with a \`reason\`), not a pile of skips. A Google Business Profile, Merchant Center or directory login needs the owner's own account: you prepare everything, the one grant goes on Needs you. Never buy, filter or write reviews. Full text: \`references/clients-and-plans.md\`.

## Words (the SEO page, the Cockpit and the CRM card use the same)

- ${DUE_TERMS.due}
- ${DUE_TERMS.overdue}
- ${DUE_TERMS.waiting}
- ${DUE_TERMS.stuck}
- An **active** sprint is running (pre-launch, active or compounding) and has its 90-day plan.

Use these words in digests and comments: "3 due, 1 overdue", never "task(s)".

## Every run

1. **Resolve the sprint.** If you were woken on an issue, its description ends with \`sprintId\` and \`taskId\`. Otherwise call \`partnersinbiz.seo:today\` (no sprintId = every active sprint).
2. **Read the learned playbook.** \`get-playbook\` with the sprintId, once per client per run: the rules this client's sprints learned from measured optimizations (PiB's own sites have their own). Follow "Rules we follow", avoid "Things that did not work", respect "Constraints". A kept rule beats a task playbook for that client, never the Rules below. Kept SEO rules live here; company memory (the brief) holds client facts and general lessons, not these rules.
3. **Read the plan.** \`today\` returns due, in-progress and blocked tasks (with issue ids), proposals, integration status and \`next\` steps. Work oldest week first; finish in-progress work first.
4. **Work each assigned issue with its task playbook.** The description holds the goal, steps, tools and definition of done (all playbooks: \`references/outrank-90.md\`). The site-check tools store findings on the sprint when you pass \`sprintId\`.
5. **Close with evidence.** \`complete-task\` with a factual \`summary\`, \`links\` (PRs, commits, the live page URL, drafts) and \`artifacts\`. It closes the issue. Some task types are checked against sprint data first (keywords tracked and bucketed, directories handled, social posts linked, day-90 snapshot exists): do the work, then complete. When a page or post is live, mark its content row live (\`update-content\` status \`live\` with the live \`targetUrl\`): Social is told only once the change is live (an approved PR merged, the page answering 200); the answer's \`socialHandOff\` says what it waits for. Marking a task issue done yourself does not complete the task. When you close an issue this module opened, it checks the work; if it reopens, it lists what's missing: finish those.
6. **A person only for a true one-time grant or judgement.** For a sprint: \`block-task\` with \`reason\` and a \`humanAsk\` that says exactly what to do, where, and what proof you need. It lands on the sprint's weekly **Needs you** issue (the Cockpit shows it to the owner) and the task comes back to you when the item is done; \`review: true\` for sign-off (the issue goes to the owner's review). DMs, emails from personal accounts and out-of-scope PRs: \`needs-you-add\` (copy-ready text, links). Anything not about one sprint: \`${ASK_OWNER_TOOL}\`. Never ask in a plain comment or an @-mention, and never write "ask the owner to connect it": do it yourself with the tools, or put the one grant it needs on Needs you and carry on with other work.
7. **Turn results into rules.** A measured win or loss drafts one playbook change (the "Optimization measured" comment on the root issue names it). When a more general rule fits, \`propose-playbook-change\` (op add, section \`rules\` or \`avoid\`, one line, reason with the real numbers, \`optimizationId\`); op remove drops a rule the results no longer support. \`decide-playbook-change\` only on full autopilot; otherwise a person decides from Needs you: do not ask again.
8. **Digest.** Once a day, after the daily run, \`post-digest\` on each sprint you touched: under 1,000 characters, what moved (real numbers) and what waits in Needs you. Full task reports go on the task's own issue, never in the digest.

## Autonomy: what you do alone

- **Site changes** go through the site repo. The sprint links a Paperclip project whose workspace is the repo (\`get-site-link\`, \`link-site\`, \`list-site-projects\`); code and content tasks open in that project so you run inside the repo workspace. Flow: branch \`seo/<task-key>\` → commit → push → PR → CI and the Vercel preview → verify on the preview (\`check-meta\`, \`validate-schema\`, \`check-sitemap\`, \`crawler-sim\`) → \`check-change-scope\` → merge, or leave the PR on Needs you → re-check production after the deploy → \`complete-task\` with PR, commit and check output. Full procedure (git + GitHub REST with $GITHUB_TOKEN, no gh needed): \`references/site-changes.md\`. A site with no repo access (CMS, client-managed): write the exact change set (page, field, old, new) and put it on Needs you.
- **WordPress sites** (site access \`wordpress\`): the sprint links one of the client's CRM websites and you change it through the PiB Connector with the CRM's \`wp-*\` tools, always passing \`siteId\` (from \`get-site-link\`): \`partnersinbiz.crm:wp-health\` first, then the \`wp-*\` tool for the change; \`wp-log\` / \`wp-undo\` reverse any change. Every tool's ops, the checks and what is still a person's job: \`references/wordpress.md\`. Verify live with \`check-meta\`, \`validate-schema\`, \`check-sitemap\`, \`crawler-sim\`. \`merge_seo_scope\` / \`full\`: apply it all yourself; \`pr_only\`: the change set goes on Needs you. Connector not connected: \`needs-you-add\` key \`wp_connector\`, then \`block-task\`. **Verification is your work here** (\`gsc-verification-token\` / \`bing-add-site\` / \`indexnow-key\` → \`wp-verify\` → the matching verify tool): \`gsc-check-access\` does not email the client on such a site until that route failed, and \`needs-you-add\` refuses Search Console, Bing and IndexNow verification items. Template markup in a theme or plugin file (never logic, scripts, forms or styling) is yours when the site has SFTP access (\`references/wordpress.md\` section 11); no SFTP login yet: \`needs-you-add\` key \`wp_sftp\`, then \`block-task\`. **When the Connector lacks an ability, do not park the task on Needs you first: run \`wp-health\` and \`wp-connector\` update** (a Connector older than 1.1 needs one manual zip upload, then you keep it current yourself).
  **On a WordPress sprint a note about GitHub, a token or a site repo does not apply: never look for a repo, and never check out an unrelated repo you find (a Next.js rebuild of the site is not the live site). A task blocked on a person stays blocked: a wake with nothing new (a repeat wake, "are you done?", a general note) gets at most one short comment, and only if the state really changed; do not re-verify and re-post the same status.**
- **Change policy** (per sprint): \`merge_seo_scope\` (default) — merge yourself when every changed file is SEO scope and checks pass; \`pr_only\` — never merge; \`full\` — merge any SEO-plan change when checks pass. Only people raise it.
- **Search Console, crawling and Bing** are yours: one Google **service account** for Search Console (\`gsc-verification-token\` → the tag or file through the repo, or \`wp-verify\` → \`gsc-verify-site\`; other client sites \`gsc-check-access\`, which puts the client's email on Needs you without access), \`indexnow-key\` → \`request-indexing\` for crawling (Google has no public "Request indexing" API), \`bing-add-site\` → tag or file → \`bing-verify-site\` → \`bing-submit\`. Steps: \`references/search-console-and-indexing.md\`.
- **Setup:** \`setup-checklist\` shows every one-time grant and its status. Missing grants are raised on Needs you automatically; standard ones via \`needs-you-add\` with key \`github_token\`, \`site_project\`, \`service_account\`, \`bing_key\` or \`wp_connector\`.

## Rules

- **Never invent data.** No made-up positions, volumes, DR, impressions or "improvements". Positions come from GSC (daily, automatic) or \`record-position\` for a rank you observed. Leave unknown numbers empty and say so.
- **Autopilot.** \`off\`: agent tasks go to the owner and you only read the playbook. \`safe\` (default): you work your tasks and propose playbook changes (a person keeps or discards them), but anything that publishes, sends or changes the live site on a task with autopilot = false needs sign-off: prepare it, then \`block-task\` with \`review: true\` (\`complete-task\` refuses these). \`full\`: you finish them yourself, may decide playbook changes, and measured wins are kept automatically. You may lower autopilot (\`set-autopilot\`), never raise it.
- **No person tasks in the plan.** Verification, crawling, Bing and cross-links are yours (see Autonomy). Link-trade DMs and community posts: you draft everything; Reddit goes through the Social plugin when an account is connected; only messages from someone's personal account go on Needs you, copy ready.
- **Relevance over the template.** The plan and its seeded directories fit the kind of business, not every client: mark a source that does not fit \`rejected\` with notes and add the industry's own listings; \`skip-task\` with a reason for a task that truly does not apply. A plan that does not fit at all is \`change-plan\`, not a pile of skips.
- **Social.** The Social agent owns repurposing: never draft social versions of your pages yourself. You mark content live (Social gets it once the page answers 200) and link the posts it drafts with \`link-social-post\` (tasks w5, w6). Posts the plan asks you to write (day-90 results, community posts) go through \`partnersinbiz.social:create-post\` then \`request-review\` in the sprint's client scope; that approval is the sign-off.
- **Short comments, short threads.** The plugin cuts its own comments at 1,500 characters; the host cannot hand an agent a task thread over about 80 KB (\`spawn E2BIG\`). Keep long reasoning in \`complete-task\` evidence, not repeated comments. A thread past about 60 KB moves to a continuation issue (same task, new issue, summary on top; \`compact-task-thread\` does it on request): work there.

## AI search, Google Analytics, page groups (extras: off until a person turns them on)

A person switches each one on per sprint (SEO page → the sprint → Integrations → Extras); \`today\` and \`get-switches\` show what is on. Where one is off its tasks do not exist, the plugin does none of its work and its tools refuse: leave it alone, never work around it, never try to switch one on. When on:

- **AI search (GEO).** GEO tasks (\`w0-geo-…\` to \`w13-geo-…\`, then monthly). \`geo-audit\` (with sprintId) scores readiness 0–100 from what it can verify. Training crawlers (GPTBot, ClaudeBot …) are the client's policy: report, never change. \`record-ai-mentions\` records answers you really got from a tool of yours (a mention needs a quote or source URL; never guess). Readiness is not visibility: say which you mean. \`references/geo.md\`.
- **Google Analytics (GA4, read only).** \`connect-ga4\` finds the property by the site's address; a missing one-time grant goes on Needs you (optional). \`list-ga4-summary\` for the weekly review and the day-90 report; quote only what it returns. \`references/analytics.md\`.
- **Page groups.** A site-wide task on a big site is split into child issues of N pages, one open at a time: work only your group, close it with a short comment, and complete the parent after the last group (you are woken then). A group issue you are given is yours even if the switch was turned off since. \`references/page-groups.md\`.

## Weekly review (Mondays)

The \`seo-weekly\` job runs the detectors and puts up to 2 proposals (first 4 weeks; 5 later) on one approval issue for the owner. In the "Weekly SEO review" routine: \`list-optimizations\` (status proposed) and \`detect-signals\` per active sprint, comment your recommendation per proposal on the approval issue, approve only when autopilot is \`full\`, then turn last week's measured results into playbook proposals (step 7). Details: \`references/optimization-loop.md\`.

References: \`tools.md\` (every tool), \`site-changes.md\` (repo procedure), \`wordpress.md\`, \`clients-and-plans.md\` (plans, timeline), \`search-console-and-indexing.md\`, \`geo.md\`, \`analytics.md\`, \`page-groups.md\`.
`;

/** Where a task key appears: its title in each plan that has it. */
function titlesByPlan(key: string): Array<{ type: BusinessType; title: string }> {
  const out: Array<{ type: BusinessType; title: string }> = [];
  for (const type of BUSINESS_TYPES) {
    const task = PLANS[type].tasks.find((t) => t.templateKey === key);
    if (task) out.push({ type, title: task.title });
  }
  return out;
}

function taskLine(task: SeoTaskTemplate): string {
  const due = dueDayFor(task.week, task.dueDay);
  return `\`${task.templateKey}\` · type \`${task.taskType}\` · owner **${task.owner}**${task.owner === "agent" && !task.autopilotEligible ? " (sign-off in safe mode)" : ""} · due ${due == null ? "immediately (pre-launch)" : `day ${due}`} · focus ${task.focus}`;
}

function renderOutrank(): string {
  const lines = [
    "# The 90-day plans",
    "",
    "Four plans by business type (`businessType` on `create-sprint` and `change-plan`). A task key means the same work in every plan and has one playbook below; a plan may give a shared task its own title. Tool names without a prefix are `partnersinbiz.seo:` tools.",
    "",
    "Every template task is the SEO Specialist's (plan v4). *sign-off* marks tasks with autopilot = false, which in safe mode end with `block-task` + `review: true`. Code and content tasks run in the site's repo project (`references/site-changes.md`); what only a person can do goes on the weekly Needs you issue. Repurposing for social is the Social agent's.",
    "",
  ];
  for (const type of BUSINESS_TYPES) {
    const plan = PLANS[type];
    lines.push(`## ${plan.label} plan (\`${type}\`): ${plan.tasks.length} tasks`, "", plan.summary, "");
    let week = -1;
    for (const task of plan.tasks) {
      if (task.week !== week) {
        week = task.week;
        lines.push(`- **Week ${week} (${PHASE_NAMES[task.phase as SprintPhase]})**`);
      }
      lines.push(`  - ${task.title} (\`${task.templateKey}\`${task.autopilotEligible ? "" : ", sign-off"})`);
    }
    lines.push("", `Seeded directories and citations: ${plan.sources.map((s) => `${s.source} (${s.domain})`).join(", ")}.`, "");
  }
  lines.push("## Playbooks", "", "One per task key, in plan order. The heading is the software plan's title when it has the task.", "");
  const tasks = [...allPlanTasks()].sort((a, b) => a.week - b.week);
  for (const task of tasks) {
    const titles = titlesByPlan(task.templateKey);
    const heading = titles.find((t) => t.type === "saas")?.title ?? titles[0]?.title ?? task.title;
    const playbook = playbookFor(task.playbook);
    const others = titles.filter((t) => t.title !== heading);
    lines.push(
      `### ${heading}`,
      taskLine(task),
      "",
      `Plans: ${titles.map((t) => t.type).join(", ")}${others.length ? `. Also titled: ${others.map((t) => `"${t.title}" (${t.type})`).join("; ")}` : ""}.`,
      "",
      `**Goal:** ${playbook.goal}`,
      "",
      "**Steps:**",
      ...playbook.steps.map((step, index) => `${index + 1}. ${step}`),
      "",
      `**Tools:** ${playbook.tools.map((t) => `\`${qualifiedTool(t)}\``).join(", ")}`,
      "",
      `**Done when:** ${playbook.done}`,
      "",
      `**Evidence:** ${playbook.evidence}`,
      "",
    );
  }
  lines.push("## Optimization task types", "", "Created when an optimization proposal is approved (for the current week).", "");
  for (const [key, playbook] of Object.entries(PLAYBOOKS)) {
    if (!key.startsWith("opt:")) continue;
    lines.push(
      `### ${key.slice(4)}`,
      `**Goal:** ${playbook.goal}`,
      "",
      ...playbook.steps.map((step, index) => `${index + 1}. ${step}`),
      "",
      `**Tools:** ${playbook.tools.map((t) => `\`${qualifiedTool(t)}\``).join(", ")} · **Done when:** ${playbook.done} · **Evidence:** ${playbook.evidence}`,
      "",
    );
  }
  return lines.join("\n");
}

export const OPTIMIZATION_LOOP_DOC = `# Optimization loop

A small experiment loop per sprint: detect a problem, test one hypothesis, measure, learn which hypotheses work on this site.

## 1. Detect (weekly job, or \`detect-signals\`)

| Signal | Fires when | Severity |
|---|---|---|
| stuck_page | the last 3 GSC positions of a keyword are all between 8 and 20 and improved by less than 2 | medium |
| lost_keyword | the latest position is 5+ worse than the latest one recorded at least 7 days earlier | high |
| zero_impression_content | content live for 14+ days has fewer than 5 impressions | medium |
| unindexed_page | from week 2, a keyword with a target URL has no positions at all | high |
| directory_silence | a backlink has been \`submitted\` for more than 30 days | low |
| cwv_regression | a tracked page has LCP > 2.5 s or CLS > 0.1 (high above 4 s / 0.25) | medium/high |
| keyword_misalignment | a keyword has > 100 impressions and CTR < 1% | medium |
| pillar_orphan | a live pillar has fewer than 3 content items listing it in \`linksToPillarIds\` | medium |
| compound_stagnation | compounding phase, 5+ snapshots, each impressions change < 5% | medium |

GSC-based signals stay silent until Search Console has delivered data. Signals also update the sprint health score (100 minus 3/8/15 per low/medium/high signal).

## 2. Propose

Each signal maps to one or more hypotheses (e.g. stuck_page → "depth + FAQ" or "internal links"). Hypothesis types are ranked with UCB over this sprint's **scoreboard**: a type never measured here goes first, then the best average result (win 1, no change 0.3, loss 0) plus an exploration bonus that shrinks as a type is tried more. So a fix that won once is not repeated forever while an untried one waits. The weekly job records at most **2 proposals per rolling 7 days while day ≤ 28**, then 5, never two open proposals for the same signal and subject. New proposals go on **one approval issue** for the sprint owner (reused while it is open). Closing that issue does **not** approve anything.

## 3. Approve or reject

\`approve-optimization\` (people; agents only when autopilot is \`full\`) creates the proposed tasks **for the current week** (they open as issues immediately), records a **baseline** — the target keywords' average position, impressions and clicks (or site totals when there are no target keywords) and the page's Core Web Vitals — and sets \`measure_on\` to 14 days later. \`reject-optimization\` needs a reason. When every proposal on an approval issue is decided, the issue closes itself.

## 4. Measure (daily job, 14 days after approval)

The same metrics are read again and classified:

- **win**: average position improved by ≥ 2, or impressions up ≥ 20 %
- **loss**: average position worse by ≥ 2, or impressions down ≥ 20 %
- **no_change**: neither, or the signals disagree
- **inconclusive**: no positions and no impressions in either window

Impression rules count only once either window has ≥ 20 impressions (a page going from 0 to ≥ 20 impressions is a win). The result is commented on the sprint root issue and added to the scoreboard (wins / losses / noChange / inconclusive per hypothesis type).

## 5. Learn: the playbook

Each scope — one client (CRM company or contact), or PiB's own sites — has one **learned playbook**: versioned markdown with the sections Goal, Rules we follow, Things that did not work, Open questions to test and Constraints. Every sprint of that client shares it, so what one sprint learns carries to the next.

- **Read** it with \`get-playbook\` (sprintId) before working a sprint's tasks, and follow it.
- **Drafts from results.** When an optimization is measured as a **win**, the plugin drafts "+ Rules we follow: <the action> (win on <date>: <reasons>; <hypothesis type>)"; a **loss** drafts the same under Things that did not work. No change and inconclusive draft nothing. One draft per optimization; the measured comment on the root issue names it.
- **Propose** better or more general rules with \`propose-playbook-change\`: op \`add\` (section, one line of at most 400 characters), \`remove\` (the exact line from \`get-playbook\`) or \`replace\` (the whole markdown), always with a reason and the evidence, and \`optimizationId\` when it comes from one. At most 10 changes wait at once.
- **Decide.** \`decide-playbook-change\` keep (a new version with the reason) or discard. \`off\` / \`safe\` autopilot: a person decides; the sprint's pending changes are batched as **one** item on its weekly Needs you issue and on SEO → sprint → Playbook, and the item closes itself once all are decided. \`full\`: you decide, and measured wins are kept automatically.

## What you do in the weekly review

1. \`list-optimizations\` status proposed, and \`detect-signals\` for context.
2. For each proposal, check the evidence yourself (\`gsc-query\`, \`crawler-sim\`, \`run-pagespeed\`) and comment your recommendation on the approval issue.
3. Approve only in \`full\` autopilot. Otherwise leave the decision to the owner.
4. Do not start optimization work before approval; unapproved proposals have no tasks.
5. For each optimization measured since the last review: read its drafted playbook change (\`get-playbook\` → pendingChanges), and propose a clearer, more general rule when one fits. On \`full\` autopilot keep or discard every pending change; otherwise leave them to the person.
6. Prefer hypothesis types the playbook marks as working; do not re-propose what it lists under "Things that did not work" unless the evidence is new.
`;

type PropSchema = { type?: string; enum?: string[]; description?: string; items?: PropSchema; properties?: Record<string, PropSchema>; required?: string[] };

/** "a|b" for an enum, "list of a|b" or "list of {…}" for arrays, else the type. */
function propType(prop: PropSchema): string {
  if (prop.enum) return prop.enum.join("|");
  if (prop.type === "array" && prop.items) {
    if (prop.items.enum) return `list of ${prop.items.enum.join("|")}`;
    if (prop.items.properties) return `list of {${schemaProps(prop.items as JsonSchema)}}`;
    return `list of ${prop.items.type ?? "any"}`;
  }
  return prop.type ?? "any";
}

function schemaProps(schema: JsonSchema): string {
  const s = schema as PropSchema;
  const required = new Set(s.required ?? []);
  const entries = Object.entries(s.properties ?? {});
  if (entries.length === 0) return "none";
  return entries
    .map(([key, prop]) => `\`${key}\`${required.has(key) ? "*" : ""} (${propType(prop)})${prop.description ? ` — ${prop.description}` : ""}`)
    .join("; ");
}

function renderTools(): string {
  const lines = ["# SEO tools", "", "All tools are `partnersinbiz.seo:<name>`. `*` = required. Every call is scoped to your company.", ""];
  let group = "";
  for (const tool of SEO_TOOL_DECLARATIONS) {
    if (tool.group !== group) {
      group = tool.group;
      lines.push(`## ${group}`, "");
    }
    lines.push(`### ${tool.name}`, tool.description, "", `Params: ${schemaProps(tool.parametersSchema)}`, "");
  }
  return lines.join("\n");
}

export const SITE_CHANGES_DOC = `# Site changes through the repo

Code and content tasks (meta, schema, sitemap/robots, verification files, alt text, noindex, canonical, internal links, new pages/posts, fixes like a broken WebSite SearchAction) open as issues in the sprint's **site project**, so your run starts in that project's workspace: a checkout of the site repo. \`get-site-link\` shows the repo, default branch, hosting and change policy. The default branch it shows is the project's work branch (its workspace policy base ref, e.g. \`development\`), or the branch a person set: branch from it and open the PR against it, never assume \`main\`.

## 1. Branch and commit

\`\`\`sh
git fetch origin && git checkout -B seo/<task-key> origin/<default-branch>
# edit, then
git add -A && git commit -m "seo: <what changed> (<task-key>)"
git push -u origin seo/<task-key>
\`\`\`

\`<task-key>\` is the template key (e.g. \`w0-meta-tags\`) — the issue's Site repo section names the branch. Paperclip configures git with the company secret \`GITHUB_TOKEN\` and gives it to you as \`$GITHUB_TOKEN\`. If the push is refused, try \`git push https://x-access-token:$GITHUB_TOKEN@github.com/<owner>/<repo>.git HEAD:seo/<task-key>\` (never print the token). Still refused, or \`$GITHUB_TOKEN\` is empty: \`needs-you-add\` with key \`github_token\`, \`why\` = the error, \`taskIds\` = this task, then \`block-task\`.

## 2. Open the PR (GitHub REST; use \`gh\` only if it is installed)

\`\`\`sh
API=https://api.github.com/repos/<owner>/<repo>
H=(-H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28")
curl -sS "\${H[@]}" -X POST $API/pulls -d '{"title":"SEO: <title>","head":"seo/<task-key>","base":"<default-branch>","body":"<what and why; link the sprint issue>"}'
# → number, head.sha, html_url
\`\`\`

## 3. Wait for the checks and the preview

\`\`\`sh
curl -sS "\${H[@]}" $API/commits/<sha>/check-runs   # every run completed; conclusion success, neutral or skipped
curl -sS "\${H[@]}" $API/commits/<sha>/status       # state: success (pending = wait, failure = fix)
\`\`\`

On Vercel the commit status with context "Vercel" carries the **preview URL** (\`target_url\`); so do the deployment statuses (\`GET $API/deployments?sha=<sha>\` → \`GET $API/deployments/<id>/statuses\` → \`environment_url\`), and the Vercel bot comments it on the PR (\`GET $API/issues/<number>/comments\`). Poll every 30–60 s for at most ~15 minutes; if the checks are still pending, note it on the task and continue on the next run.

## 4. Verify on the preview

Run the plugin checks against the preview URL: \`check-meta\`, \`validate-schema\`, \`check-sitemap\`, \`check-robots\`, \`crawler-sim\` (pass the full preview URL as \`url\` and no \`sprintId\`, so preview findings are not stored). Fix and push again until they pass. (Vercel previews may send \`X-Robots-Tag: noindex\`; that is expected on a preview.)

## 5. Decide: merge or hand over

List the changed files (\`git diff --name-only origin/<default-branch>...HEAD\`) with a category each and call \`check-change-scope\` with \`checks: "passed"\` only when every check is green.

SEO scope under \`merge_seo_scope\` (anything else is out of scope):

{{SCOPE}}

Never in scope: dependencies and lockfiles, CI workflows, env/secrets files, hosting/build config, middleware, API routes, database, auth/payments, tooling config, next.config (except SEO redirects).

- **merge** → \`curl -sS "\${H[@]}" -X PUT $API/pulls/<number>/merge -d '{"merge_method":"squash"}'\`
- **wait** → the checks are not green: never merge on red or pending.
- **pr_only** → leave the PR open and \`needs-you-add\` (kind \`pr\`, key \`pr:<html_url>\`, the reasons, \`taskIds\` this task). The item closes itself when the task is done.

Policies: \`merge_seo_scope\` (default) merges only SEO scope; \`pr_only\` never merges; \`full\` merges any SEO-plan change when checks pass. Sign-off tasks in safe mode (publishing posts, pSEO launches, pitches, announcements) end with \`block-task\` + \`review: true\` and the preview link in \`links\`; when the owner approves (closes the issue) you get a follow-up task to merge the PR.

## 6. After the deploy

Wait for the production deployment of the merge commit (deployment status \`success\` for the Production environment), re-run the checks on production with \`sprintId\` (findings resolve), then \`complete-task\` with the PR link, the merge commit and the check output as artifacts.
`;

export const WORDPRESS_DOC = `# WordPress sites through the PiB Connector

A sprint in site access \`wordpress\` is linked to one of its client's CRM websites. The site runs the **PiB Connector**, a small WordPress plugin a person installs once; after that you keep it up to date yourself. You change the site only through the CRM's Connector tools, and every call takes \`siteId\` (\`get-site-link\` → \`siteId\`, or \`today\` → \`siteRepo.siteId\`). Writes take a \`reason\`: one plain sentence naming the task and why (it is stored in the site's change log). Every issue of the sprint opens in the client's own Paperclip project; there is no repo and no branch.

| Tool | What it does |
|---|---|
| \`partnersinbiz.crm:wp-health\` | WordPress, PHP and theme versions, the SEO plugin, the sitemap provider, \`blogPublic\`, active plugins, pending updates, the installed Connector version |
| \`partnersinbiz.crm:wp-seo\` | op \`get\` / \`set\` for a page (\`url\` or \`postId\`), a category or tag (\`termId\`, \`taxonomy\`) or a post type archive such as the shop (\`postTypeArchive\`): title, description, canonical, noindex, nofollow, focusKeyword, ogTitle, ogDescription, \`ogImage\`. op \`list\` audits many pages (\`postType\`, \`status\`, \`search\`, \`page\`, \`perPage\`, \`missing\`) |
| \`partnersinbiz.crm:wp-schema\` | JSON-LD pieces per page or for the whole site (\`site: true\`), each under a stable \`id\` |
| \`partnersinbiz.crm:wp-redirects\` | list, set (301/302/307/308/410) and delete redirects |
| \`partnersinbiz.crm:wp-robots\` | extra robots.txt lines; \`allowSearchEngines: true\` switches "Discourage search engines" off |
| \`partnersinbiz.crm:wp-sitemap\` | the SEO plugin's sitemap on or off (Yoast), posts left out of the sitemap |
| \`partnersinbiz.crm:wp-media\` | Media Library: op \`list\` (\`missingAlt\`), \`sideload\` an image from an https URL, \`set-featured\` (a post's featured image), \`alt\` (alt text on up to 50 images) |
| \`partnersinbiz.crm:wp-content\` | op \`get\`, \`images\`, \`img-alt\` (alt text on in-content images), \`update\` (title, content, excerpt, slug of an existing post or page), \`create\` (a new page or post, always a draft), \`publish\` (your own draft only) |
| \`partnersinbiz.crm:wp-verify\` | Connector 1.2+: op \`get\` / \`set\` for verification meta tags (\`google-site-verification\`, \`msvalidate.01\`, …) and root files (IndexNow \`/<key>.txt\`, Google \`/google<hex>.html\`, \`/BingSiteAuth.xml\`); set replaces the lists you send |
| \`partnersinbiz.crm:wp-connector\` | op \`update\` (installs the Connector build Paperclip ships; you cannot pass a URL) and \`rollback\` (restores the backup an update made) |
| \`partnersinbiz.crm:wp-log\` | the last 200 changes with before and after |
| \`partnersinbiz.crm:wp-undo\` | reverse one change by its \`changeId\` |

## 1. Read the site first

Call \`wp-health\` at the start of each task. Note the SEO plugin (Yoast, Rank Math or none), the sitemap provider, \`blogPublic\` and the Connector version.

- **Keep Yoast or Rank Math installed.** The Connector writes into their own fields, so wp-admin and the live page stay in step. Never suggest removing them.
- **\`blogPublic\` false** ("Discourage search engines" is on) blocks the whole site from Google. It is the top finding on the sprint. Under \`merge_seo_scope\` or \`full\` fix it with \`wp-robots\` \`allowSearchEngines: true\` and a reason; under \`pr_only\` put it on Needs you first.
- The Connector not connected (a 401 or "not paired" error, or \`get-site-link\` says so): \`needs-you-add\` with key \`wp_connector\` and this task in \`taskIds\`, then \`block-task\`. The item closes itself when the CRM sees the Connector connected, and the task comes back to you.

## 2. Keep the Connector current (before you park anything)

A tool answering that a route is missing, or \`check-client-site\` warning "Connector X is out of date (bundled Y)", means the plugin on the site is older than the tools. **Do not put the task on Needs you for that.** Read the warning:

- **Connector 1.1 or newer:** run \`partnersinbiz.crm:wp-connector\` op \`update\` with a \`reason\`. The CRM sends the shipped build itself; you never pass a URL or a checksum. Afterwards \`check-client-site\` (it should report the new version) and re-check a page with \`check-meta\`. If the site misbehaves, \`wp-connector\` op \`rollback\` with the \`backupId\` from the update result, then put the problem on Needs you.
- **Connector 1.0.x:** it has no update route. One person uploads the new zip once in wp-admin → Plugins → Add New → Upload Plugin (replace the current one). \`needs-you-add\` that as a one-time grant with the download link from the warning, \`block-task\`; after that you update it yourself.
- **The update tool says the feature is off:** a person switches "Connector updates" on in wp-admin → Settings → PiB Connector: one Needs you item.

## 3. Check the change scope

List what you plan to change as \`wp:<area>:<target>\` with a category and call \`check-change-scope\`, e.g. \`{ "path": "wp:seo:/about", "category": "head_metadata" }\`, \`{ "path": "wp:schema:site/localbusiness", "category": "json_ld" }\`, \`{ "path": "wp:redirects:/old-page", "category": "seo_redirect" }\`, \`{ "path": "wp:robots", "category": "sitemap_robots" }\`, \`{ "path": "wp:media:/about", "category": "media" }\`, \`{ "path": "wp:content:/about", "category": "page_copy" }\`, \`{ "path": "wp:images:/about", "category": "image_alt" }\`, \`{ "path": "wp:page:/durban-drain-repairs", "category": "new_content" }\`.

- **apply**: every change is in the Connector's scope and the policy lets you (\`merge_seo_scope\` or \`full\`). Make it yourself.
- **pr_only**: the policy is \`pr_only\`, or something is a person's job (see Never). Write the exact change set (page, field, old value, new value) and \`needs-you-add\` it (kind \`task\`, the change set in \`copy\`, \`taskIds\` this task), then \`block-task\`.

## 4. SEO fields, page by page

For each page: \`wp-seo\` op \`get\` → decide from the stored values (null means the page falls back to the SEO plugin's template) → op \`set\` with only the fields that change and a \`reason\`. Keep the answer's \`changeId\`. To audit a whole site, \`wp-seo\` op \`list\` with \`missing: ["title","description","ogImage"]\` finds the pages that need work; page through it with \`page\`.

- **Categories, tags and product categories:** \`termId\` (and \`taxonomy\` when the id could belong to more than one). **Archives and the shop:** \`postTypeArchive: "product"\`. On WooCommerce the shop page writes to the product archive settings too (Yoast only); archives take no canonical or nofollow.
- **Share images:** \`ogImage\` takes an https URL or a site-relative path; use the URL of an image already in the Media Library. No \`ogImage\` and no featured image means the page shares without a picture: that is a finding.

Verify on the live page with \`check-meta\` (with \`sprintId\`, so findings resolve). Pages are often cached: if the old title or description still shows, wait 2 minutes and check again. Still old: note a possible page cache on the task and \`needs-you-add\` an item to purge the site's cache (the caching plugin or the host panel), with the page URLs.

## 5. Images: alt text, featured and share images

- **Alt text.** Library images: \`wp-media\` op \`list\` with \`missingAlt: true\`, then op \`alt\` (up to 50 per call). Images inside page copy: \`wp-content\` op \`images\` (index, src, alt), then op \`img-alt\` with the indexes to change; only the \`alt\` attributes change. Alt text describes the picture in context, plain text, under 300 characters; decorative images stay empty. Verify with \`crawler-sim\`.
- **Where an image comes from.** Never hotlink, scrape or copy an image you have no rights to. Use, in this order: (1) an image already in the site's Media Library (\`wp-media\` op \`list\`); (2) the client's own asset: a URL from their Drive or brand kit, or a media asset in the client's Social scope (\`partnersinbiz.social:list-media-assets\`, public https URLs); (3) an image you generate, if your run has an image-generation tool (check your tools; this plugin has none) and the client's brand allows generated images. Then \`wp-media\` op \`sideload\` with an \`imageUrl\` (jpeg, png, webp, gif or avif, up to 10 MB; the same URL is not duplicated; a sideload cannot be undone, so use it only for an image you mean to keep), with \`alt\` and a sensible \`filename\`.
- **No source for the image?** Ask for the asset, not for a wp-admin edit: \`needs-you-add\` naming the page, the image needed (subject, size) and where to put it (the client's Drive folder or the Social media library). Carry on with other work; when the asset is there, sideload it yourself.
- **Featured image:** \`wp-media\` op \`set-featured\` (\`postId\` plus \`attachmentId\` or \`imageUrl\`). **Share image:** \`wp-seo\` op \`set\` with \`ogImage\`.

## 6. Page copy and new pages

- **Editing existing copy:** \`wp-content\` op \`get\` first, change the smallest thing that does the job, then op \`update\` with only the fields that change and a \`reason\`. The content is block markup; \`update\` replaces the whole \`content\`, so start from what \`get\` returned. The site refuses scripts, iframes, forms and event handlers that are not already in the content, and keeps the last 5 versions (\`wp-undo\` restores one). A changed \`slug\` on a page with traffic also needs a \`wp-redirects\` entry. Never touch status, author or password: the Connector ignores them.
- **New pages and posts:** \`wp-content\` op \`create\` (a \`page\` by default) makes a **draft**, never a live page. Check it at the \`previewUrl\`. Publish it with op \`publish\` only when the task says to publish, and only for a draft the Connector created; anything else it refuses. A page that is not yours to publish goes on Needs you with the link to review.
- Put internal links inside the copy with \`update\` (category \`internal_links\`). Verify live pages with \`check-meta\` and \`crawler-sim\`; a new page also with \`check-sitemap\`.

## 7. Schema

\`wp-schema\` with a stable, readable \`id\` per piece, e.g. \`localbusiness\` or \`organization\` for the site (\`site: true\`) and \`faq-home\` or \`service-<slug>\` for a page. Setting the same \`id\` again replaces the piece, so never make a new id for the same thing. With Yoast or Rank Math the piece joins their schema graph; do not add a second Organization or WebSite next to theirs. Then \`validate-schema\` on the live page.

## 8. Redirects, robots and sitemap

- \`wp-redirects\` set for moved or duplicate URLs (301 by default, 410 for pages gone for good). Before you redirect a page, check whether it has traffic or rankings (\`gsc-query\` by page, tracked keywords); if it does, say so in the \`reason\` and on the task. Never create chains: point to the final URL.
- \`wp-robots\` \`extraLines\` only adds lines (e.g. a \`Sitemap:\` line). The Connector refuses a blanket \`Disallow: /\`.
- \`wp-sitemap\` leaves thin or duplicate posts out (\`excludePostIds\`) or switches Yoast's sitemap on. Then \`check-sitemap\` and \`check-robots\`.

## 9. Search engine verification (yours, not the client's)

Connector 1.2+ prints verification meta tags and serves root key files itself (nothing is written to disk, so a read-only web root does not matter). \`wp-verify\` op \`get\` first, then op \`set\` with the existing entries plus your addition: it replaces the whole \`metaTags\` and \`files\` lists you send. Always fetch the live page or file afterwards and confirm the exact content and a 200.

- **Search Console:** \`gsc-verification-token\` (method META, property url) → \`wp-verify\` set \`metaTags [{ name: "google-site-verification", content }]\` → \`check-meta\` → \`gsc-verify-site\`. The service account becomes a verified owner of the URL-prefix property, so the client grants nothing and \`gsc-check-access\` does not email them. Only if this route fails does it queue the client email, and it records why on the sprint.
- **Bing:** \`bing-add-site\` → \`wp-verify\` set \`metaTags [{ name: "msvalidate.01", content }]\` or \`files [{ path: "/BingSiteAuth.xml", content }]\` → \`bing-verify-site\`.
- **IndexNow:** \`indexnow-key\` → \`wp-verify\` set \`files [{ path: "/<key>.txt", content: "<key>" }]\` → \`indexnow-key\` (confirms it is live) → \`request-indexing\`.
- A tool saying the route is missing means Connector older than 1.2: \`wp-connector\` update first (section 2).
- \`needs-you-add\` refuses these items on such a site unless \`wpVerifyFailed\` says what you tried and the error. Existing items of this kind are closed as superseded by the daily check and the task comes back to you.

## 10. Reversible, logged, then done

Every write is in \`wp-log\` with its before and after. If a check shows a change did harm, \`wp-undo\` its \`changeId\` and note it on the task (image uploads and Connector updates are not undoable: leave the upload, roll the Connector back with \`wp-connector\` op \`rollback\`). Finish with \`complete-task\`: the pages changed, the \`changeId\`s and the check output as artifacts.

## 11. Template markup in a theme or plugin file (SFTP)

Template markup is yours when the site has SFTP access: an empty \`alt=""\` on a decorative icon, a missing \`alt\`, a \`<title>\` or heading tag, a meta or link tag. Never logic, PHP control flow, scripts, forms or styling. \`check-change-scope\` with category \`theme_markup\` and a path like \`wp:theme:<file>\`, then the theme-edit routine in the CRM's \`wp-sites\` skill (backup, \`php -l\`, upload, checksum readback, live check, rollback). No SFTP login yet: \`needs-you-add\` key \`wp_sftp\` (one grant, then it is yours from then on), then \`block-task\`.

## Still a person (Needs you)

- Plugin installs and rollbacks (\`partnersinbiz.crm:wp-plugins\`): you never run them. Deactivating a plugin is a person too (wp-admin; deactivate, never delete). An active Open Graph plugin (duplicate og: tags) or maintenance / coming-soon plugin that \`check-client-site\` warns about is fixed first with \`wp-seo\` and checked with \`check-meta\` / \`crawler-sim\`; only then is the deactivation (never deletion) put on Needs you.
- Merchant Center account creation (a Google account and business details).
- Deleting anything (posts, pages, media, users). The Connector cannot.
- Publishing anything the Connector did not create, or unpublishing a page.
- Changing a site's theme, settings or users, or editing theme files beyond template markup (section 11).
- A new page, featured image or share image that needs an image you have no source for: ask for the asset (see 5), not for a wp-admin edit.
- The one-time zip upload for a Connector older than 1.1 (see 2), and switching a Connector feature on in wp-admin.
- Removing or replacing Yoast or Rank Math: never.
`;

function renderSiteChanges(): string {
  const scope = Object.entries(SEO_SCOPE).map(([key, text]) => `- \`${key}\` — ${text}`).join("\n");
  return SITE_CHANGES_DOC.replace("{{SCOPE}}", scope);
}

export const CLIENTS_AND_PLANS_DOC = `# Clients and plans

The full text of the skill's scope and plan rules, with the listing filters.

### Scope: PiB's own sites vs client sprints

- A sprint is either **PiB's own** (no client: a Partners in Biz site) or for **one client**: a CRM company, or a CRM contact (a sole trader). Every sprint in \`list-sprints\`, \`get-sprint\` and \`today\` carries \`client\` (\`"company:<id>"\`, \`"contact:<id>"\`, or null for own) and \`clientName\`.
- **Creating.** Omit \`client\` only for PiB's own sites. For a client pass \`client: "company:<id>"\` or \`"contact:<id>"\` with the CRM id: find it with \`partnersinbiz.crm:find-records\` (by name, domain or email; it returns ids) and check it with \`partnersinbiz.crm:get-company\`. The client must exist in the CRM; the plugin takes the name from there. Never type a client name in \`siteName\` to fake a client.
- **Listing.** \`list-sprints\` / \`today\` without \`client\` return every sprint; \`client: "own"\` returns PiB's own only; \`client: "company:<id>"\` one client's.
- **Working.** Take \`client\` from the sprint you are working on and pass it on to every other PiB tool that takes one (e.g. Social posts for that client's accounts). Keywords, content, copy, accounts and evidence stay inside that sprint. Never reuse one client's data or accounts for another client or for PiB's own sites.
- **Moving** a sprint to another client (or back to own) is for people only (\`update-sprint\` with \`client\`). If a sprint looks filed under the wrong client, ask once with \`${ASK_OWNER_TOOL}\` (the sprint, the client it names, the client you think it is) and keep working what does not depend on it.
- **Manual pacing.** A person can put a sprint on manual pacing (\`pacing\` in \`get-sprint\` and \`today\`, and a line in \`next\`): then no plan task opens until they start its week. Work what is open, do not call \`start-tasks-now\` there (it refuses you), and do not treat the waiting tasks (\`held: true\` in \`list-tasks\`) as late. The data work and the weekly proposals carry on as usual.
- **Rehearsal sprints.** A sprint for a fixture site (host ending \`.invalid\`, e.g. \`https://canary.invalid\`) or for the canary client (CRM id \`canary-…\`) is a rehearsal for a test journey: \`create-sprint\` answers \`rehearsal: true\` and \`issuesOpened: 0\`, \`list-tasks\` and \`get-sprint\` read its plan, and \`archive-sprint\` ends it. It never gets a root issue, a task issue, a Needs you line, a proposal or a Social hand-off, and \`today\` without a sprintId leaves it out. Do not try to open issues for it; \`start-tasks-now\` and \`request-build\` refuse.

### The plan fits the business

Most PiB clients are South African service businesses, so a sprint follows one of four 90-day plans (\`businessType\`):

- **local** — a local service business (guest house, clinic, biokineticist, club, trades): Google Business Profile, one exact name, address and phone everywhere, SA directories and citations (Yellow Pages, Yell, Brabys, Cylex, Snupit, saYellow, Hotfrog…), reviews, a page per service and per area.
- **professional** — professional services (law firm, accountant, consultancy): service and team pages that show real expertise, case studies, professional bodies, LinkedIn and B2B directories, reviews.
- **ecommerce** — an online shop: category and product pages, Google Merchant Center free listings, buying guides, PriceCheck and review sites.
- **saas** — software: the launch plan with comparison and feature pages, G2, Product Hunt and SaaS directories.

- **Choosing.** Before \`create-sprint\` for a client, read \`partnersinbiz.crm:get-client-profile\` (services, website, audience) and pass the \`businessType\` that fits. Without one a client gets \`local\` and our own site gets \`saas\`. The SEO page preselects it from the same profile when a person creates a sprint.
- **Wrong plan?** \`change-plan\` moves a sprint (say why in \`reason\`): it adds the new plan's tasks and directories (the due ones open at once), rewords shared tasks nobody started, marks the old plan's unstarted tasks not needed and its unstarted directories not relevant, and leaves started work for you to finish or skip. Do it as soon as you see a mismatch (a law firm on the software plan).
- **Local presence.** A Google Business Profile, Merchant Center or a directory login needs the owner's own account: you prepare every detail and the copy, and the one grant goes on Needs you. A client's customers are theirs: review requests go to the owner as a Needs you message (our own sites: a Campaigns campaign with its approval). Never buy, filter or write reviews.


### Timeline

Day 0 is the start (launch) date; week 0 is pre-launch, week 1 days 1–7, week 13 days 85–91; phases 0 pre-launch, 1–4 foundation, 5–10 content engine, 11–13 authority, 14+ compounding. The daily job opens due tasks after 06:00 SAST and takes audit snapshots on days 0, 30, 60, 90, then every 30 days.

### Local presence

A Google Business Profile, Merchant Center or a directory login needs the owner's own account: you prepare every detail and the copy, and the one grant goes on Needs you. A client's customers are theirs: review requests go to the owner as a Needs you message (our own sites: a Campaigns campaign with its approval). Never buy, filter or write reviews.

### Listing

\`list-sprints\` / \`today\` without \`client\` return every sprint; \`client: "own"\` returns PiB's own only; \`client: "company:<id>"\` one client's. The SEO page preselects the plan from the client's CRM profile when a person creates a sprint.
`;

export const SEARCH_DOC = `# Search Console, crawling and Bing

- **Search Console** runs through one Google **service account**. Own sites: \`gsc-verification-token\` → add the meta tag (or file) through the repo (WordPress with a Connector 1.2+: through \`wp-verify\`, client sites too) → \`gsc-verify-site\` (verifies, adds the property, submits the sitemap). Other client sites: \`gsc-check-access\`; without access it puts the email for the client (service account email + Users link) on Needs you. The OAuth connection is only a fallback.
- **Crawling:** Google has no public "Request indexing" API for normal pages. \`indexnow-key\` (key file through the repo, or \`wp-verify\` on WordPress) → \`request-indexing\` (sitemap + IndexNow + URL Inspection). The daily run follows up after 14 days.
- **Bing:** \`bing-add-site\` → BingSiteAuth.xml or the msvalidate.01 tag through the repo (or \`wp-verify\`) → \`bing-verify-site\` → \`bing-submit\`.
### Setup

- **Setup:** \`setup-checklist\` shows every one-time grant and its status. Missing grants are raised on Needs you automatically; standard ones via \`needs-you-add\` with key \`github_token\`, \`site_project\`, \`service_account\`, \`bing_key\` or \`wp_connector\`.

`;

export const OUTRANK_DOC = renderOutrank();
export const SITE_CHANGES_REF = renderSiteChanges();
export const TOOLS_DOC = renderTools();

export const SKILLS: PluginManagedSkillDeclaration[] = [
  {
    skillKey: SKILL_KEY,
    displayName: "PiB SEO sprint",
    slug: SKILL_SLUG,
    description: SKILL_DESCRIPTION,
    markdown: withFrontmatter({ name: SKILL_SLUG, description: SKILL_DESCRIPTION }, SKILL_BODY),
    files: [
      { path: "references/outrank-90.md", content: OUTRANK_DOC },
      { path: "references/optimization-loop.md", content: OPTIMIZATION_LOOP_DOC },
      { path: "references/tools.md", content: TOOLS_DOC },
      { path: "references/site-changes.md", content: SITE_CHANGES_REF },
      { path: "references/wordpress.md", content: WORDPRESS_DOC },
      { path: "references/clients-and-plans.md", content: CLIENTS_AND_PLANS_DOC },
      { path: "references/search-console-and-indexing.md", content: SEARCH_DOC },
      { path: "references/geo.md", content: GEO_DOC },
      { path: "references/analytics.md", content: ANALYTICS_DOC },
      { path: "references/page-groups.md", content: PAGE_GROUPS_DOC },
    ],
  },
];
