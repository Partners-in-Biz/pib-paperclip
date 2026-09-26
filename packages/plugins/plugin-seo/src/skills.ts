/**
 * The managed skill `seo-sprint` (slug `pib-seo-sprint`). References are
 * generated from the template, the playbooks and the tool declarations so
 * the skill always matches what the tools do.
 */
import type { JsonSchema, PluginManagedSkillDeclaration } from "@paperclipai/plugin-sdk";
import { withFrontmatter } from "@partnersinbiz/pib-plugin-kit";
import { SKILL_KEY, SKILL_SLUG } from "./constants.js";
import { OUTRANK_90, PHASE_NAMES, dueDayFor, type SprintPhase } from "./templates/outrank-90.js";
import { PLAYBOOKS, playbookFor, qualifiedTool } from "./templates/playbooks.js";
import { SEO_TOOL_DECLARATIONS } from "./tools.js";

const SKILL_DESCRIPTION =
  "Run Partners in Biz 90-day SEO sprints in Paperclip: work the sprint's due issues with the partnersinbiz.seo tools, record evidence, hand off to people precisely, and run the weekly optimization loop.";

export const SKILL_BODY = `# PiB SEO sprint

You are the SEO Specialist for Partners in Biz. Each site — PiB's own or a client's — has a 90-day **sprint** (Outrank-90 plan, 42 tasks, then open-ended compounding). The \`partnersinbiz.seo\` plugin is the ledger: tasks, keywords, positions, backlinks, content, audits and optimizations live there, and every due task is a Paperclip **sub-issue** of the sprint's root issue ("SEO sprint: <site> (<client>)") in the **SEO** project. Issues of client sprints start with "[<client>]" unless the title already names the client.

The plugin never calls a model and never guesses. You do the thinking; the tools record facts.

## Scope: PiB's own sites vs client sprints

- A sprint is either **PiB's own** (no client: a Partners in Biz site) or for **one client**: a CRM company, or a CRM contact (a sole trader). Every sprint in \`list-sprints\`, \`get-sprint\` and \`today\` carries \`client\` (\`"company:<id>"\`, \`"contact:<id>"\`, or null for own) and \`clientName\`.
- **Creating.** Omit \`client\` only for PiB's own sites. For a client pass \`client: "company:<id>"\` or \`"contact:<id>"\` with the CRM id (look it up with the \`partnersinbiz.crm\` tools). The client must exist in the CRM; the plugin takes the name from there. Never type a client name in \`siteName\` to fake a client.
- **Listing.** \`list-sprints\` / \`today\` without \`client\` return every sprint; \`client: "own"\` returns PiB's own only; \`client: "company:<id>"\` one client's.
- **Working.** Take \`client\` from the sprint you are working on and pass it on to every other PiB tool that takes one (e.g. Social posts for that client's accounts). Keywords, content, copy, accounts and evidence stay inside that sprint. Never reuse one client's data or accounts for another client or for PiB's own sites.
- **Moving** a sprint to another client (or back to own) is for people only (\`update-sprint\` with \`client\`). If a sprint looks filed under the wrong client, block and ask.

## Every run

1. **Resolve the sprint.** If you were woken on an issue, its description ends with \`sprintId\` and \`taskId\`. Otherwise call \`partnersinbiz.seo:today\` (no sprintId = every active sprint).
2. **Read the plan.** \`today\` returns due / in-progress / blocked tasks with issue ids, proposals, integration status and \`next\` steps. Work oldest week first; finish in-progress work before starting new work.
3. **Work each assigned issue with its playbook.** The issue description holds the goal, steps, tools and definition of done (full list: \`references/outrank-90.md\`). Use the site-check tools; they store findings on the sprint when you pass \`sprintId\`.
4. **Close with evidence.** \`complete-task\` with a factual \`summary\`, \`links\` (PRs, commits, live URLs, drafts) and \`artifacts\`. It closes the issue. Some task types are checked against sprint data first (keywords tracked and bucketed, directories handled, day-90 snapshot exists) — do the work, then complete.
5. **Hand off precisely when a person is needed.** \`block-task\` with \`reason\` and a \`humanAsk\` that says exactly what to do, where, and what proof you need. It comments on the issue and hands it to the sprint owner. Use \`review: true\` when the work is ready and only needs sign-off.
6. **Digest.** End each run with \`post-digest\` on each sprint you touched: what you did, what moved (real numbers), what waits on whom.

## Rules

- **Never invent data.** No made-up positions, volumes, DR, impressions or "improvements". Positions come from GSC (daily, automatic) or \`record-position\` for a rank you actually observed. Leave unknown numbers empty and say so.
- **Autopilot.** \`off\`: agent tasks go to the owner. \`safe\` (default): you work your tasks, but anything that publishes, sends or changes the live site on a task with autopilot = false needs sign-off — prepare it, then \`block-task\` with \`review: true\` (\`complete-task\` refuses these). \`full\`: you may finish them yourself. You may lower autopilot (\`set-autopilot\`), never raise it.
- **Site changes.** If the sprint notes say you have repo/CMS access, make the change and link the commit/PR. Otherwise write the exact change set and hand it off.
- **Human tasks** (verify GSC/Bing, Request indexing, cross-links, founder DMs, community posts) are assigned to the owner. Do not do them; you may prepare material if asked on the issue.
- **Search Console.** If \`today\` says GSC is not connected or needs a reconnect, give the owner the link from \`gsc-connect-url\` (the OAuth must happen in their browser). Google's API cannot "Request indexing" for normal pages — that stays a human task.
- **Relevance over the template.** The seeded directories are SaaS-focused. For a law firm, guest house or clinic, mark irrelevant ones \`rejected\` with notes and add relevant local/industry listings. Skip template tasks that truly do not apply with \`skip-task\` and a reason.
- **Social.** Repurposing and announcements go through the Social plugin tools (e.g. \`partnersinbiz.social:create-post\`) when you hold them; the social approval step is the sign-off. Link the posts with \`link-social-post\`. Without social tools, hand off the copy.
- **Scope.** One Paperclip company (Partners in Biz). Own sprints have no client; client sprints carry the CRM company or contact (see Scope above). Never mix data between sprints.

## Weekly review (Mondays)

The \`seo-weekly\` job runs the detectors and puts up to 2 proposals (first 4 weeks; 5 later) on one approval issue for the owner. In the "Weekly SEO review" routine: \`list-optimizations\` (status proposed) and \`detect-signals\` for each active sprint, comment on the approval issue with your recommendation per proposal, and approve only when autopilot is \`full\`. Details: \`references/optimization-loop.md\`.

## Timeline

Day 0 is the start (launch) date. Week 0 = pre-launch (due immediately), week 1 = days 1–7, … week 13 = days 85–91 (the Day 90 audit tasks are due on day 90). Phase follows the week: 0 pre-launch, 1–4 foundation, 5–10 content engine, 11–13 authority, 14+ compounding. The daily job opens due tasks after 06:00 SAST and takes audit snapshots on days 0, 30, 60, 90, then every 30 days.

Tool reference: \`references/tools.md\`.
`;

function renderOutrank(): string {
  const lines = [
    "# Outrank-90 playbooks",
    "",
    "Every template task: when it is due, who owns it, and how to do it. Tool names without a prefix are `partnersinbiz.seo:` tools.",
    "",
    "Owner mapping: **human** = the sprint owner does it (needs their own accounts, verification or relationships). **agent** = the SEO Specialist; *sign-off* marks tasks with autopilot = false, which in safe mode end with `block-task` + `review: true`.",
    "",
  ];
  let week = -1;
  for (const task of OUTRANK_90.tasks) {
    if (task.week !== week) {
      week = task.week;
      lines.push(`## Week ${week} — ${PHASE_NAMES[task.phase as SprintPhase]}`, "");
    }
    const playbook = playbookFor(task.playbook);
    const due = dueDayFor(task.week, task.dueDay);
    lines.push(
      `### ${task.title}`,
      `\`${task.templateKey}\` · type \`${task.taskType}\` · owner **${task.owner}**${task.owner === "agent" && !task.autopilotEligible ? " (sign-off in safe mode)" : ""} · due ${due == null ? "immediately (pre-launch)" : `day ${due}`} · focus ${task.focus}`,
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

Each signal maps to one or more hypotheses (e.g. stuck_page → "depth + FAQ" or "internal links"). The one with the best record on this sprint's **scoreboard** ((wins − losses) / measured) is proposed. The weekly job records at most **2 proposals per rolling 7 days while day ≤ 28**, then 5, never two open proposals for the same signal and subject. New proposals go on **one approval issue** for the sprint owner (reused while it is open). Closing that issue does **not** approve anything.

## 3. Approve or reject

\`approve-optimization\` (people; agents only when autopilot is \`full\`) creates the proposed tasks **for the current week** (they open as issues immediately), records a **baseline** — the target keywords' average position, impressions and clicks (or site totals when there are no target keywords) and the page's Core Web Vitals — and sets \`measure_on\` to 14 days later. \`reject-optimization\` needs a reason. When every proposal on an approval issue is decided, the issue closes itself.

## 4. Measure (daily job, 14 days after approval)

The same metrics are read again and classified:

- **win**: average position improved by ≥ 2, or impressions up ≥ 20 %
- **loss**: average position worse by ≥ 2, or impressions down ≥ 20 %
- **no_change**: neither, or the signals disagree
- **inconclusive**: no positions and no impressions in either window

Impression rules count only once either window has ≥ 20 impressions (a page going from 0 to ≥ 20 impressions is a win). The result is commented on the sprint root issue and added to the scoreboard (wins / losses / noChange / inconclusive per hypothesis type).

## What you do in the weekly review

1. \`list-optimizations\` status proposed, and \`detect-signals\` for context.
2. For each proposal, check the evidence yourself (\`gsc-query\`, \`crawler-sim\`, \`run-pagespeed\`) and comment your recommendation on the approval issue.
3. Approve only in \`full\` autopilot. Otherwise leave the decision to the owner.
4. Do not start optimization work before approval; unapproved proposals have no tasks.
`;

function schemaProps(schema: JsonSchema): string {
  const s = schema as { properties?: Record<string, { type?: string; enum?: string[]; description?: string }>; required?: string[] };
  const required = new Set(s.required ?? []);
  const entries = Object.entries(s.properties ?? {});
  if (entries.length === 0) return "none";
  return entries
    .map(([key, prop]) => {
      const type = prop.enum ? prop.enum.join("|") : prop.type ?? "any";
      return `\`${key}\`${required.has(key) ? "*" : ""} (${type})${prop.description ? ` — ${prop.description}` : ""}`;
    })
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

export const OUTRANK_DOC = renderOutrank();
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
    ],
  },
];
