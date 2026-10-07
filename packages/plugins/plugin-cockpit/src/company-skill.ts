/**
 * The company operating manual (managed skill `company-os`, slug
 * `pib-company-os`): how the whole PiB system fits together, for every agent
 * that works for the company. Each role's own skill has the detailed
 * procedure for its module; this one is the map, the rules everyone shares
 * and the main flows across modules. Built from the kit registries (modules,
 * team roles, memory) so it stays true when they change.
 */
import { ASK_OWNER_TOOL, MEMORY_LIMITS, MEMORY_TOOLS, MODULES, TEAM_ROLES, memoryTool, type ModuleKey } from "@partnersinbiz/pib-plugin-kit";

export const COMPANY_SKILL_KEY = "company-os";
export const COMPANY_SKILL_SLUG = "pib-company-os";

export const COMPANY_SKILL_DESCRIPTION =
  "How this company runs on Paperclip and the PiB modules: who keeps what, clients, hand-offs, approvals, where knowledge lives, house rules and the main flows. Read it before your first task in a session and whenever work crosses modules.";

const MODULE_TOOLS: Partial<Record<ModuleKey, string>> = {
  cockpit: "partnersinbiz.cockpit",
  crm: "partnersinbiz.crm",
  mailbox: "partnersinbiz.mailbox",
  social: "partnersinbiz.social",
  seo: "partnersinbiz.seo",
  campaigns: "partnersinbiz.campaigns",
  billing: "partnersinbiz.billing",
  accounting: "partnersinbiz.accounting",
  payroll: "partnersinbiz.payroll",
  partners: "partnersinbiz.partners",
};

/** Roles that work in a module: its own roles, then roles that carry one of its skills as an extra. */
function moduleRoles(key: ModuleKey): string {
  const plugin = MODULE_TOOLS[key];
  const slug = plugin ? `plugin/${plugin.replace(/[^a-z0-9]+/g, "-")}/` : null;
  // Covered roles are listed under the role that covers them (the team list), not per module.
  const titles = TEAM_ROLES.filter((r) => !r.coveredBy && (r.module === key || (slug && (r.extraSkills ?? []).some((skill) => skill.startsWith(slug))))).map((r) => r.title);
  return titles.join(", ") || "—";
}

/** Team summaries are written for the owner ("sends you…"); the manual speaks to agents. */
export function agentFacingSummary(summary: string): string {
  return summary.replace(/\bsends you\b/g, "sends the owner").replace(/\bbefore you approve them\b/g, "before a person approves them").replace(/\byou\b/g, "the owner");
}

/** `crm` for `partnersinbiz.crm`: the module part of its tool names. */
function toolModule(key: ModuleKey): string | null {
  return MODULE_TOOLS[key]?.split(".").pop() ?? null;
}

function moduleTable(): string {
  const rows = (Object.keys(MODULES) as ModuleKey[])
    .filter((key) => key !== "memory")
    .map((key) => `| ${MODULES[key].title}${toolModule(key) ? ` (\`${toolModule(key)}\`)` : ""} | ${MODULES[key].description} | ${moduleRoles(key)} |`);
  return ["| Module | What it keeps | Agent role |", "|---|---|---|", ...rows].join("\n");
}

/** Tool namespaces, said once instead of a column per table row. */
export function toolNaming(): string {
  return "Each module's tools are `partnersinbiz.<module>:<tool>` (the module in brackets above).";
}

/** One line per role; roles another role covers go on one line under it (they share its work). */
function teamList(): string {
  const covered = (key: string) => TEAM_ROLES.filter((r) => r.coveredBy === key);
  const lines: string[] = [];
  for (const r of TEAM_ROLES.filter((role) => !role.coveredBy)) {
    lines.push(`- **${r.title}**${r.required ? "" : " (optional)"}: ${agentFacingSummary(r.summary)}`);
    const team = covered(r.key);
    if (team.length) {
      lines.push(`  - Optional roles it covers while unstaffed: ${team.map((t) => `**${t.title}** (${SHORT_ROLE[t.key] ?? t.summary})`).join(", ")}.`);
    }
  }
  return lines.join("\n");
}

/** A few words per covered role, for the manual's team list. */
const SHORT_ROLE: Partial<Record<string, string>> = {
  "sales-lead": "the pipeline",
  "inbound-qualifier": "new leads",
  "crm-data-steward": "clean records",
  "deal-desk": "quotes",
};

/** Cases: durable work products that no module owns. Short on purpose: the API detail is in the paperclip skill's `references/cases.md`. */
export const COMPANY_CASES = `## Cases (durable work products)
A **case** holds one work product that several issues or agents revise: a report, proposal, audit or dossier. The issue says who does what; the case holds the thing. Module records (posts, sprints, campaigns, invoices, pay runs, reconciliations) stay in their modules; never copy them into cases.
- **Create or update** with \`POST /api/companies/:companyId/cases\` (paperclip skill, \`references/cases.md\`): \`caseType\`, a **stable \`key\`** (a retry updates the same case), \`title\`, \`fields\` (send the whole object each time; always \`client\`: \`company:<id>\`, \`contact:<id>\` or \`own\`), and the body at \`PUT /api/cases/<id>/documents/body\`. Parts with their own owner are child cases.
- **Status**: \`in_progress\` while you write; \`in_review\` when the Reviewer or a person must look; \`approved\` once a person says yes; \`done\` once delivered (link or evidence in \`fields\`); \`cancelled\` if dropped. A client-facing case never goes out without an approval.
- **Types in use**: \`client_report\` (Account Manager, key \`<client id>:<YYYY-MM>\`), \`client_proposal\` (Deal Desk, the deal id), \`seo_audit\` (SEO Specialist, \`<client id>:<date>\`), \`content_piece\` (child \`image_assets\`), \`research_dossier\` (any role, the topic), \`onboarding_pack\` (Operator, the client id), \`incident\` (Operator, what broke and when).
- If a route answers **Cases are disabled** (403), say so on the issue and carry on with a document on the issue.
`;

/** Who decides what, and the tool that asks for it. */
const APPROVALS = `| What | Who decides | How to ask |
|---|---|---|
| Send an invoice, quote or reminder | A person (the Reviewer checks first) | Billing \`request-invoice-send\`, \`request-quote-send\`, \`request-reminder-send\` (not needed once a person switches automatic reminders on) |
| Record a payment, issue a credit note | A person | Billing \`record-payment\` / \`create-credit-note\` open a decision for them |
| A proof of payment | A person verifies | Billing \`request-payment-check\` |
| Publish a post | A person (the Reviewer checks first) | Social approval on the post |
| Launch a campaign or sequence | A person (the Reviewer checks first) | Campaigns \`request-campaign-approval\` (launches on approval); CRM sequence approval |
| Change a client's website | A person signs off, then it is merged | SEO sign-off task |
| Approve and lock a pay run | A person | Payroll \`request-pay-run-approval\` |
| Month-end reconciliation, VAT201 | A person | Accounting \`prepare-reconciliation\`, \`prepare-vat201\` open the approval |
| Anything else only the owner can give (a decision, a login, a key, a DNS record) | The owner | \`${ASK_OWNER_TOOL}\` |`;

/** The main flows across modules, step by step, with the role that owns each step. */
export const COMPANY_FLOWS = `## Main flows

Each step names the role that owns it. An unstaffed sales role's work goes to the Account Manager, any other to the Operator.

### Lead to cash
1. **Lead in** (Social DMs and comments, the Mailbox) → the CRM stores it and opens a follow-up for the **Inbound Qualifier** (done: work logged plus a next action, a deal, or a lifecycle call; churned when not a fit). Leads from a *client's* channels stay with that client; they never become our contacts.
2. **Qualify** (Inbound Qualifier): \`find-records\` / \`get-company\` before creating anything, then the deal. The **Sales Lead** chases quiet deals.
3. **Quote** (Deal Desk): \`create-quote\` with the \`dealId\` → \`request-quote-send\` → a person approves → the Mailbox sends it. When the customer replies, Billing opens an issue for the Deal Desk.
4. **Won**: quote accepted or deal moved to won (a pick-the-deal issue: \`move-deal\` to won with the \`quoteId\`) → the CRM makes the client a customer, Billing opens a drafting task, and on a first win the Cockpit opens onboarding.
5. **Invoice** (Account Manager): \`convert-quote\` or \`create-invoice\` → \`request-invoice-send\` → a person approves → sent. Accounting posts the journal.
6. **Paid**: the Bookkeeper matches the bank line, or a proof of payment goes through \`request-payment-check\` → Billing settles it and tells the CRM.
7. **Overdue** (Account Manager): Billing's weekly "Overdue invoices" issue → reminders through approval.

### Onboarding a new client
On a first win the Cockpit opens one onboarding issue for the **Operator**, who hands off and tracks:
- **Account Manager:** fill the client profile (\`update-client-profile\`); set up the retainer or subscription in Billing.
- **Grants only the owner or the client can give** (social account logins, Search Console access, site repo access): one \`ask-owner\` (kind \`grant\`) with every link and step, not one ask per item.
- **SEO Specialist:** the client's first sprint, on the plan that fits the business (\`create-sprint\` \`businessType\`: local, professional, ecommerce or saas; \`change-plan\` to switch later). **Social agent:** the first month's plan, once a person has connected their accounts (part of the grants ask).
- **Done when** every module shows the client in its client workspace and the first work is scheduled.
- **Every month** the Account Manager writes the client's report as a \`client_report\` case, built from each module's client workspace, and sends it once approved. **Offboarding:** lifecycle churned, stop sequences and campaigns, hand off to each module to stop work, keep the records.

### Content
SEO publishes a page (merged and returning 200) → the Social agent gets a repurpose task → drafts (\`create-post\` with the task's \`handoffKey\`) with proposed times → the Reviewer checks → a person approves and each post is scheduled at its time → published → the posts are linked back to the SEO content (\`link-social-post\`) → metrics over 30 days → the Growth Lab learns and proposes playbook changes.

### Campaigns and sequences
The Account Manager builds the campaign (audience by tags; "all contacts" needs a person's explicit OK) → \`request-campaign-approval\` → a person approves and it launches (any edit after approval cancels the approval) → the Mailbox sends each step as marketing mail → replies stop, suppress or come back as issues. CRM sequences are one-to-one follow-ups with their own approval. **Opt-outs** (\`set-email-status\` in the CRM, \`suppress-address\` in Campaigns, or a reply "STOP") are shared, and every module honours them.

### The books (Bookkeeper)
Bank statement by email (the issue gives the message and attachment ids) or upload → Mailbox \`get-attachment\` → Accounting \`import-statement\` (or \`mark-statement-email\` when it is no statement or a duplicate) → match lines to invoices and bills → reconcile → month-end: \`prepare-reconciliation\` and \`prepare-vat201\` → a person approves each (\`mark-not-needed\`, with a reason, for a step the month does not need).

### Payroll (Payroll Clerk)
Five days before pay day Payroll opens "Prepare pay run" → create, calculate and adjust → \`request-pay-run-approval\` → a person approves, which locks the run → payslips emailed → journals posted → an "EMP201 due" issue for the Bookkeeper (else the Clerk): export it, then one \`ask-owner\` for the owner to file and pay by the 7th; their answer → \`mark-emp201-filed\`.

### Every day (Operator)
07:00: review every module (unblock agents, route unassigned work, check routines, roles and asks) → one daily brief to the owner of everything waiting on them. Mondays: the retro and the memory review.

### Who decides what
${APPROVALS}
`;

export function companySkillBody(flows: string = COMPANY_FLOWS): string {
  return `# PiB company operating manual

You work for this company inside **Paperclip**. Paperclip holds the work: issues (tasks), projects, routines, agents, approvals and the org chart. The **PiB modules** are Paperclip plugins; each keeps one part of the business. Your role's own skill has the detailed procedure for your module. This manual is the map and the rules everyone shares.

## The modules
${moduleTable()}

${toolNaming()}

- A company can switch modules off in **Setup**. If a tool answers that its module is off, leave that area alone and say so on the issue.
- The **Cockpit** is the owner's one view: what waits on them, what agents did, the numbers, agent cost and quality, system health and memory.

## The team
${teamList()}

Roles are staffed in **Setup → Team**. If your role's tools or skills are missing, say so on your issue; the Operator gets the owner to fix it in Setup → Team (agents cannot use Setup).

## Clients
- A client is a **CRM company** (or a **CRM contact** for a sole trader). Refer to it everywhere as \`company:<crm id>\` or \`contact:<crm id>\`: every tool that takes \`client\` wants that, never a name.
- The **CRM is the source of truth** for clients: look them up there first, create or update them there. Other modules pick clients from it and follow its changes.
- **PiB's own work has no client.** Pages show own work by default; a client's work lives in its **client workspace** (\`?client=company:<id>\` on the CRM, Social, SEO, Campaigns and Billing pages).
- **Never mix clients**: data, accounts, copy, files and evidence for one client never go to another client or into PiB's own work.
- **Brand, audience and sender details**: ours from \`company-profile\` (Cockpit), a client's from \`get-client-profile\` (CRM). Fill empty fields you learn with \`update-company-profile\` / \`update-client-profile\`; changing a set value is the owner's call.

## How work moves
- **Everything is an issue.** You are woken on issues assigned to you or by a routine. Do the work in the same run and leave the issue in a clear state: \`done\` (with evidence), \`in_review\` (with a real reviewer or approval), or \`blocked\` with an \`unblockDescriptor\` (who must do what; a block with none is flagged after a day).
- **A run ends with your turn** (30 min max) and kills what you started. Detach builds/tests (\`setsid nohup … > <log> 2>&1 < /dev/null &\`), poll. Servers (\`next start\`) never exit: detach, curl within 20s, cap commands with \`timeout 60\`. Never end a turn to "wait" or leave an issue \`in_progress\` without a comment.
- **Hand-offs**: when another role owns the next step, create an issue for that agent: title \`Hand-off: <what> (<client or own>)\`, the context and links, and what "done" means, and always a \`projectId\` (the client's project, or **PiB Platform** for own platform work; a task with no project has no repository and a code agent cannot work on it). Don't do their work.
- **People are asked only for** money, legal, one-time grants (a login consent, a key, DNS) and real judgement: through the module's approval step, or \`ask-owner\`. Never ask a person to do what an agent can do.
- **Outward-facing work** (posts, emails, invoices, quotes, pull requests) goes through its module's approval step (a Reviewer checks first, if staffed). Never send, publish, pay or merge outside it.
- If you are stuck, say exactly what you need on the issue; the **Operator** (who reviews the company every morning) routes it.
- **Done-checks**: closing an issue a module opened runs its done-check. If the issue reopens, it lists what is missing: finish those items, then close it. Work that leaves no other trace goes in the module's log tool (Billing \`log-follow-up\`, Campaigns \`log-reply\`, SEO \`complete-task\`). **Cockpit → Flows** shows every flow stage by stage.
- **Look at what you built.** You can open a browser: \`pib-shot <url> --viewport mobile\` (and desktop; \`references/screenshots.md\`). Run it before closing UI work and paste its \`--json\` line; "not checked" is no reason.

## Where knowledge lives
| Kind | Where | Who keeps it |
|---|---|---|
| How to do the work | Your skills (this one and your role's) | The modules; updated for you automatically |
| What works, per client or channel | Learned playbooks (SEO \`get-playbook\`, Social Growth Lab) | Measured results; you propose, people or autopilot keep |
| Facts and lessons | **Company memory** | You: \`${memoryTool(MEMORY_TOOLS.recall)}\` at the start of every task (at most ${MEMORY_LIMITS.briefMaxFacts} facts), **Learned:** lines when you close |
| What happened | Issues, comments, documents, activity | Everyone, as you work |
| Readable pages | Company wiki: \`paperclipai.plugin-llm-wiki:wiki_search\`, then \`wiki_read_page\` | The Wiki Maintainer, from finished work |

${COMPANY_CASES}
## Skills
- You may create a **company skill** (never change a plugin skill). Its \`SKILL.md\` must start with a \`---\` frontmatter block holding \`name\` (equal to the slug) and \`description\`, or the host audit fails it and only the board can attach it.
- To give it to other agents, run \`pib-skill-request attach <slug> --agent <Name> [--agent <Name>...] --issue <PAR-n>\`, then end your run. The answer arrives as a comment on that issue.
- It only adds. It refuses skills with scripts or assets, skills that fail the host audit, other companies' agents and the protected agents (Delivery Lead, Operator, Reflection Coach, Developer, Senior Developer, Mac Builder): for those, say so on the issue and set it \`in_review\` for the board.
- Never edit, remove or reset skills, and never work around a refusal.

## House rules
- **Money** is an integer in minor units (cents) plus a currency code (ZAR by default).
- **Dates** \`YYYY-MM-DD\`; the company's time zone is Africa/Johannesburg unless its settings say otherwise.
- **Links** in comments are Paperclip paths with the company prefix: \`/<PREFIX>/issues/<ID>\`, module pages \`/<PREFIX>/<module>?tab=<tab>\` (and \`&client=company:<id>\` for a client).
- **Never** paste secrets, tokens or passwords into issues, comments, documents or memory.
- **Never invent** numbers or facts. Say "unknown".
- Stay inside your **budget**; if a task would exceed it, stop and say so.
- Write plain, short South African English; lead with the answer.

${flows}`;
}
