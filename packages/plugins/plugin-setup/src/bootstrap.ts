/**
 * Setup -> New company: the bootstrap plan, its stored state and the one batched
 * list of grants only a person can give (Q7-1, Q7-7, Q10-1). Pure and browser-safe.
 *
 * What a plugin can and cannot do (host rules, checked 2026-10-03):
 * - A worker cannot call another plugin's action, so the steps that need another
 *   plugin (save its settings, its start-hire, its sync) run from the Setup page
 *   with the board session, like Team and "Do it for me". The worker keeps the
 *   state and does what it can itself (modules, the Finish setup issue, template
 *   hire tasks).
 * - Saving a plugin's settings needs an instance admin, so a worker cannot do it:
 *   the page does. That is also why a company whose Setup settings were never
 *   saved is skipped by Setup's own jobs (host rule: a job acts only for a
 *   company with a saved config row); the bootstrap saves them (Q7-7).
 * - Every step checks what is already there first, so a run can be repeated or
 *   resumed after a failure and never opens a second hire task.
 */
import { MODULES, type ModuleKey, type SetupItem, type SetupStatus } from "./kit-setup.js";
import { ORDERED_MODULES } from "./modules.js";
import { linkFor } from "./status.js";
import { isTeamPath } from "./team.js";
import type { HiringPick } from "./hiring.js";

export type StepStatus = "pending" | "running" | "done" | "skipped" | "blocked" | "failed" | "needs_owner";
export type StepWhere = "worker" | "page" | "owner";

export const STEP_IDS = [
  "modules",
  "setup-settings",
  "plugin-settings",
  "skills",
  "roles",
  "templates",
  "company-wiki",
  "starter-pack",
  "finish-issue",
  "owner-list",
] as const;
export type StepId = (typeof STEP_IDS)[number];

export interface StepDef {
  id: StepId;
  title: string;
  where: StepWhere;
  /** One line: what the step does. */
  summary: string;
}

export const BOOTSTRAP_STEPS: readonly StepDef[] = [
  { id: "modules", title: "Choose the modules this company uses", where: "worker", summary: "Saves the module switches (every module on unless you chose otherwise) and tells the other plugins." },
  { id: "setup-settings", title: "Save Setup's own settings", where: "page", summary: "Setup's hourly and weekly jobs act only for a company whose Setup settings are saved." },
  { id: "plugin-settings", title: "Save every plugin's settings", where: "page", summary: "Fills in the defaults of each plugin that has none saved, and copies another company's settings when you chose one. Secrets are never copied." },
  { id: "skills", title: "Put each plugin's skills in the company's library", where: "page", summary: "Runs each plugin's skill sync for this company." },
  { id: "roles", title: "Open a hire task for every team role", where: "page", summary: "One prefilled task per missing role of a switched-on module, assigned to the agent that does the hiring." },
  { id: "templates", title: "Open hire tasks for the dev team and the other template agents", where: "page", summary: "From the team template pack: the CEO, the dev team and the support agents you selected." },
  { id: "company-wiki", title: "Set up the company wiki", where: "page", summary: "Creates the wiki folder, the Wiki Maintainer and its routines (LLM Wiki)." },
  { id: "starter-pack", title: "Seed company memory with the starter pack", where: "page", summary: "A small pack of company-wide lessons. Off until the owner approves this version." },
  { id: "finish-issue", title: "Open the Finish setup issue", where: "worker", summary: "One issue for the owner that lists what is still missing and this list of grants." },
  { id: "owner-list", title: "What only you can do", where: "owner", summary: "One batched list of one-time grants, each with a link and exact steps." },
];

export function stepDef(id: string): StepDef | null {
  return BOOTSTRAP_STEPS.find((step) => step.id === id) ?? null;
}

export interface StepItem {
  key: string;
  label: string;
  status: "done" | "skipped" | "failed" | "blocked" | "needs_owner";
  detail?: string;
}

export interface StepRecord {
  status: StepStatus;
  detail: string | null;
  at: string | null;
  items?: StepItem[];
}

export const EMPTY_STEP: StepRecord = { status: "pending", detail: null, at: null };

export type RunStatus = "created" | "running" | "partial" | "complete";

export interface BootstrapOptions {
  /** Saved by the first call; leave out to keep the saved choice (or every module on). */
  modules?: Partial<Record<ModuleKey, boolean>>;
  /** Copy this company's plugin settings (secrets and ids are never copied). */
  copyFromCompanyId?: string | null;
  /** Also open hire tasks for the optional roles (Reviewer, Payroll Clerk, the sales roles). */
  includeOptionalRoles?: boolean;
  /** Template keys to hire; leave out for the pack's defaults. */
  templates?: string[];
  /** The agent that does the hiring (the page picks it with `pickHiringAgent`). */
  hiringAgentId?: string | null;
  /** Seed memory with the starter pack when the owner approved it. */
  starterPack?: boolean;
}

export interface BootstrapRunState {
  companyId: string;
  status: RunStatus;
  options: BootstrapOptions;
  steps: Partial<Record<StepId, StepRecord>>;
  grants: OwnerGrant[];
  source: string;
  startedBy: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

/** Facts the plan can derive without a stored record (they are true or false whatever the run said). */
export interface PlanFacts {
  modulesSaved: boolean;
  setupSettingsSaved: boolean;
  finishIssueId: string | null;
  requiredLeft: number | null;
}

export interface PlannedStep extends StepDef, StepRecord {
  /** The status came from a live fact, not from the stored run. */
  derived: boolean;
}

/** The ordered steps with their status: a live fact wins over the stored record, because the world changes under a run. */
export function planSteps(run: Pick<BootstrapRunState, "steps"> | null, facts: PlanFacts): PlannedStep[] {
  return BOOTSTRAP_STEPS.map((def) => {
    const stored = run?.steps[def.id] ?? EMPTY_STEP;
    let derived = false;
    let record: StepRecord = stored;
    if (def.id === "modules" && facts.modulesSaved && stored.status !== "done") {
      record = { status: "done", detail: stored.detail ?? "The module choice is saved.", at: stored.at };
      derived = true;
    } else if (def.id === "setup-settings" && facts.setupSettingsSaved && stored.status !== "done") {
      record = { status: "done", detail: "Setup's settings are saved.", at: stored.at };
      derived = true;
    } else if (def.id === "finish-issue" && stored.status !== "done" && (facts.finishIssueId || facts.requiredLeft === 0)) {
      record = { status: "done", detail: facts.finishIssueId ? "The Finish setup issue is open." : "Nothing required is missing.", at: stored.at };
      derived = true;
    }
    return { ...def, ...record, derived };
  });
}

const OPEN: ReadonlySet<StepStatus> = new Set(["pending", "running"]);
const BAD: ReadonlySet<StepStatus> = new Set(["failed", "blocked"]);

/** complete: nothing pending, running, failed or blocked (a step that waits for the owner is the owner's list, not a failure). */
export function runStatus(steps: ReadonlyArray<Pick<StepRecord, "status">>): RunStatus {
  if (steps.every((step) => step.status === "pending")) return "created";
  if (steps.some((step) => OPEN.has(step.status))) return "running";
  if (steps.some((step) => BAD.has(step.status))) return "partial";
  return "complete";
}

/** Live agents from which a company that was never bootstrapped counts as one that already works (a hand-staffed company, not a new one). */
export const MATURE_AGENT_COUNT = 6;

/**
 * What to say before a FIRST run on a company that already works: the run only adds what is missing, but it saves
 * default settings for any plugin whose settings were never saved and opens hire tasks for roles nobody holds, which
 * is not what a curated company wants unasked. Null for a new company, a company that is already being bootstrapped,
 * or when the agents could not be read (the run itself then fails loudly).
 */
export function matureCompanyWarning(input: { agents: ReadonlyArray<{ status: string }> | null; runStatus: RunStatus }): string | null {
  if (input.runStatus !== "created" || !input.agents) return null;
  const live = input.agents.filter((agent) => !["terminated", "archived", "deleted"].includes(agent.status)).length;
  if (live < MATURE_AGENT_COUNT) return null;
  return `This company already has ${live} agents, so it does not look new. The run only adds what is missing, but it saves default settings for every plugin whose settings were never saved and opens hire tasks for roles nobody holds yet. Read the steps first, and use it on a company you are setting up from scratch.`;
}

export function isStepStatus(value: unknown): value is StepStatus {
  return typeof value === "string" && (["pending", "running", "done", "skipped", "blocked", "failed", "needs_owner"] as string[]).includes(value);
}

export function isStepId(value: unknown): value is StepId {
  return typeof value === "string" && (STEP_IDS as readonly string[]).includes(value);
}

/** One line for a step row. */
export function stepLabel(status: StepStatus): string {
  return { pending: "Not run yet", running: "Running", done: "Done", skipped: "Skipped", blocked: "Blocked", failed: "Failed", needs_owner: "Needs you" }[status];
}

// ---------------------------------------------------------------------------
// Plugin settings: defaults and skill sync
// ---------------------------------------------------------------------------

/** The skill sync action of each PiB plugin (the Cockpit refreshes its skills on `cockpit.load`). Setup and the wiki have none. */
export const SKILL_SYNC_ACTIONS: Record<string, string> = {
  "partnersinbiz.cockpit": "cockpit.load",
  "partnersinbiz.crm": "crm.sync-skills",
  "partnersinbiz.mailbox": "mailbox.sync-skills",
  "partnersinbiz.social": "social.sync-skills",
  "partnersinbiz.seo": "seo.sync-skills",
  "partnersinbiz.campaigns": "campaigns.sync-skills",
  "partnersinbiz.billing": "billing.sync-skills",
  "partnersinbiz.accounting": "accounting.sync-skills",
  "partnersinbiz.payroll": "payroll.sync-skills",
  "partnersinbiz.partners": "partners.sync-skills",
};

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null);

/** The defaults a plugin's `instanceConfigSchema` declares, nested objects included (what a first "Save Configuration" would store). */
export function defaultsFromSchema(schema: unknown): Rec {
  const out: Rec = {};
  const properties = rec(rec(schema)?.properties);
  if (!properties) return out;
  for (const [key, sub] of Object.entries(properties)) {
    const node = rec(sub);
    if (!node) continue;
    if ("default" in node) out[key] = node.default;
    else if (node.type === "object" && node.properties) {
      const nested = defaultsFromSchema(node);
      if (Object.keys(nested).length) out[key] = nested;
    }
  }
  return out;
}

/** The error a plugin gives when an action reaches it for a company whose settings were never saved. */
export function needsSettingsError(message: string): boolean {
  return /company context is required/i.test(message);
}

/** The host's answer when a plugin is older than the action (no handler registered). */
export function missingHandlerError(message: string): boolean {
  return /no action handler|action handler registered|not registered|unknown action|action not found/i.test(message);
}

// ---------------------------------------------------------------------------
// The one list of grants only a person can give
// ---------------------------------------------------------------------------

export interface OwnerGrant {
  id: string;
  title: string;
  /** Why it is a person's step, in one sentence. */
  why: string;
  steps: string[];
  href: string | null;
  hrefLabel: string | null;
  /** A command the owner (or the person running the server scripts) runs, when there is one. */
  command: string | null;
  /** What happens once it is done. */
  after: string;
  /** A decision the owner makes (not an action): shown apart. */
  decision: boolean;
}

export interface GrantInput {
  company: { id: string; name: string; prefix: string | null };
  modules: Record<ModuleKey, boolean>;
  installed: Record<string, unknown> | null;
  /** The hiring agent as the page worked it out; null when it has not been looked up. */
  hiring: HiringPick | null;
  /** The company asks the board to approve new agents. */
  requireApproval: boolean | null;
  /** Stored setup statuses per plugin key. */
  statuses: Record<string, SetupStatus | null | undefined>;
  starterPackApproved: boolean;
  /** Name of the company the keys are copied from (shown in the command). */
  sourceCompany?: { id: string; name: string } | null;
}

const SECRETS_PAGE = "/company/settings/secrets";

/** What each module needs from a person while its plugin has not reported yet. */
const MODULE_INPUTS: Partial<Record<ModuleKey, Array<{ key: string; title: string; why: string; steps: string[]; href: string; label: string; after: string }>>> = {
  mailbox: [{
    key: "gmail",
    title: "Connect Gmail",
    why: "Google asks the mailbox owner to consent once; no agent can click that.",
    steps: ["Open the Mailbox.", "Click Connect and sign in with the company's Google account.", "Allow the requested access."],
    href: "/mailbox",
    label: "Open Mailbox",
    after: "The Mailbox triages mail into issues and sends for invoices, sequences and campaigns.",
  }],
  social: [{
    key: "accounts",
    title: "Connect the social accounts",
    why: "Each platform asks the account owner to log in and allow access once.",
    steps: ["Open Social -> Accounts.", "Connect each platform the company posts on."],
    href: "/social",
    label: "Open Social",
    after: "The Social agent plans, schedules and publishes approved posts.",
  }],
  seo: [{
    key: "search-console",
    title: "Give SEO access to each site's Search Console",
    why: "Only a site's owner can add the service account to its Search Console property.",
    steps: ["Open SEO.", "For each site, add the service account email as a user in Search Console.", "Click Check access."],
    href: "/seo",
    label: "Open SEO",
    after: "The SEO agent runs the 90-day sprint with real ranking data.",
  }],
  billing: [{
    key: "billing-details",
    title: "Enter the billing details",
    why: "Bank (EFT) details, VAT number and the sender name are the company's own facts.",
    steps: ["Open Billing -> Settings.", "Fill in the EFT details, VAT number and sender."],
    href: "/billing",
    label: "Open Billing",
    after: "Invoices and quotes go out with the right details.",
  }],
  accounting: [{
    key: "ledger",
    title: "Set up the books",
    why: "The chart of accounts, bank accounts and opening balances are the company's own facts.",
    steps: ["Open Accounting.", "Confirm the chart of accounts, add the bank account and enter the opening balances."],
    href: "/accounting",
    label: "Open Accounting",
    after: "The Bookkeeper matches bank lines and prepares VAT and month-end.",
  }],
  payroll: [{
    key: "employer",
    title: "Enter the employer details and employees",
    why: "Employer registration numbers and employee records are the company's own facts.",
    steps: ["Open Payroll.", "Fill in the employer details and add the employees."],
    href: "/payroll",
    label: "Open Payroll",
    after: "The Payroll Clerk prepares pay runs.",
  }],
  cockpit: [{
    key: "profile",
    title: "Confirm the company profile",
    why: "The legal name, VAT number and address are the company's own facts; the Operator drafts the rest from the website.",
    steps: ["Open the Cockpit.", "Answer the Operator's one question card with the legal name, VAT number and address."],
    href: "/cockpit",
    label: "Open Cockpit",
    after: "Agents use the profile for brand voice, sender details and documents.",
  }],
  memory: [{
    key: "wiki-adapter",
    title: "Give the Wiki Maintainer a working model",
    why: "Its adapter and model key stay a person's step.",
    steps: ["Open the Wiki Maintainer agent.", "Set its adapter and model key, then resume it."],
    href: "/agents",
    label: "Open Agents",
    after: "Finished work becomes wiki pages and the routines run.",
  }],
};

/** Items a person must do, from a plugin's own status: required, not done, with nothing the page can do for them and not a hire. */
export function personItems(status: SetupStatus): SetupItem[] {
  return (status.items ?? []).filter((item) => item.required && item.status !== "done" && item.key !== "settings" && !item.action && !isTeamPath(item.href));
}

export function ownerGrants(input: GrantInput): OwnerGrant[] {
  const out: OwnerGrant[] = [];
  const add = (grant: OwnerGrant) => {
    if (!out.some((existing) => existing.id === grant.id)) out.push(grant);
  };
  if (input.hiring && !input.hiring.agent) {
    add({
      id: "hiring-agent",
      title: "Create the company's CEO agent",
      why: input.hiring.problem ?? "Nobody can do the company's hiring.",
      steps: [input.hiring.fix ?? "Create the CEO agent."],
      href: "/agents/new",
      hrefLabel: "New agent",
      command: "python3 /root/pib-ops/new-company.py --company <id> --create-ceo --apply",
      after: "Setup then opens every hire task for the CEO to execute.",
      decision: false,
    });
  }
  if (input.requireApproval) {
    add({
      id: "approve-hires",
      title: "Approve the new agents",
      why: "This company asks the board to approve every new agent.",
      steps: ["Open Approvals.", "Approve each hire the CEO submits (read the requested model and skills first)."],
      href: "/approvals/pending",
      hrefLabel: "Open Approvals",
      command: null,
      after: "Each approved agent appears in Setup -> Team and the plugin that asked for it links and wires it.",
      decision: false,
    });
  }
  const source = input.sourceCompany;
  add({
    id: "plugin-secrets",
    title: "Put this company's keys in place",
    why: "Secrets are strictly per company and nothing can copy a value for you through the API: the keys for storage (R2), the model service (TypeSafe), Hugging Face, SEO (Google, Bing, PageSpeed) and the social apps must be added to this company once.",
    steps: [
      source
        ? `On the server, copy them from ${source.name} (the values never touch a log or a file): run the command below. Add --apply after you read the dry run.`
        : "On the server, run the command below from a company that has the keys (the values never touch a log or a file). Add --apply after you read the dry run.",
      "Then run `python3 /root/pib-ops/copy-company-secrets.py --from <source id> --to <this company id> --relink-config --apply` so the plugin settings point at the new secrets.",
      "Or paste each key yourself in Settings -> Secrets (the page lists the names).",
    ],
    href: SECRETS_PAGE,
    hrefLabel: "Open Secrets",
    command: `python3 /root/pib-ops/copy-company-secrets.py --from ${source ? source.id : "<source company id>"} --to ${input.company.id}`,
    after: "The plugins' key items turn green and agents can use storage, the model service and the social apps.",
    decision: false,
  });
  add({
    id: "github-token",
    title: "Create this company's GitHub token",
    why: "Agents push to the company's repos with a token of its own, so one company's agents can never touch another's repos. Only the account owner can create it, and no agent may ever type it.",
    steps: [
      "On GitHub open Settings -> Developer settings -> Fine-grained tokens -> Generate new token.",
      "Owner: the company's organisation. Repositories: only its repos. Permissions: Contents (read and write), Pull requests (read and write), Metadata (read). No admin, no workflows. Expiry: at most 1 year.",
      "Add it as a company secret named GITHUB_TOKEN (Settings -> Secrets). Paperclip uses a secret with that name for its own checkouts.",
      "Write the expiry date in the credentials register so it is renewed in time.",
    ],
    href: SECRETS_PAGE,
    hrefLabel: "Open Secrets",
    command: null,
    after: "Managed checkouts and the agents' pushes work for this company only; no shared token is used.",
    decision: false,
  });
  for (const module of ORDERED_MODULES) {
    if (!input.modules[module]) continue;
    for (const pluginKey of MODULES[module].plugins as readonly string[]) {
      if (input.installed && !input.installed[pluginKey]) continue;
      const status = input.statuses[pluginKey];
      const title = MODULES[module].title;
      const live = status ? personItems(status) : [];
      if (live.length > 0) {
        for (const item of live) {
          add({
            id: `${pluginKey}:${item.key}`,
            title: `${title}: ${item.title}`,
            why: item.detail ?? "Only a person can do this.",
            steps: item.steps ?? [],
            href: item.href ?? null,
            hrefLabel: item.hrefLabel ?? (item.href ? "Open" : null),
            command: null,
            after: item.agentNext ?? "The plugin carries on by itself.",
            decision: false,
          });
        }
      } else if (!status) {
        for (const entry of MODULE_INPUTS[module] ?? []) {
          add({
            id: `${pluginKey}:${entry.key}`,
            title: `${title}: ${entry.title}`,
            why: entry.why,
            steps: entry.steps,
            href: entry.href,
            hrefLabel: entry.label,
            command: null,
            after: entry.after,
            decision: false,
          });
        }
      }
    }
  }
  add({
    id: "resume-agents",
    title: "Resume the new agents once their model key works",
    why: "Every hired agent starts paused so none runs on a model nobody checked.",
    steps: ["Open each new agent.", "Check its adapter has a working model key (or Claude login).", "Click Resume."],
    href: "/agents/all",
    hrefLabel: "Open Agents",
    command: null,
    after: "The agent picks up its first task.",
    decision: false,
  });
  add({
    id: "tools-grant",
    title: "Decide how agents get the plugin tools (tools:use)",
    why: "Without the grant an agent cannot use the memory or any PiB tool. Setup never grants it for you: the owner decision is still open.",
    steps: [
      "Recommended: the narrow grant for the four memory tools only (the Cockpit offers it as one card).",
      "Wider: all plugin tools, which also opens CRM, billing and payroll tools to that agent. Only for a module agent that needs them.",
    ],
    href: "/agents/all",
    hrefLabel: "Open Agents",
    command: null,
    after: "Agents can recall memory and use the tools of their module.",
    decision: true,
  });
  if (!input.starterPackApproved) {
    add({
      id: "starter-pack",
      title: "Decide whether to seed memory with the starter pack",
      why: "A small pack of company-wide lessons can start the company's memory. It is off until you approve this exact version.",
      steps: ["Open Setup -> New company.", "Read the facts in the Memory starter pack card.", "Approve the version if they fit, then run the step again."],
      href: "/setup?section=new-company",
      hrefLabel: "Open the starter pack",
      command: null,
      after: "Agents start with a few verified platform lessons instead of nothing.",
      decision: true,
    });
  }
  return out;
}

/**
 * The grants that are still true now. The list is a snapshot from the last owner-list step; a grant that came from a
 * plugin's own item (id `<pluginKey>:<itemKey>`) is dropped once that plugin reports the item done, so the Finish setup
 * issue and the page never list something the owner already did. Grants Setup cannot check for itself (the keys, the
 * GitHub token, the decisions) stay until the owner-list step runs again.
 */
export function currentGrants(grants: readonly OwnerGrant[], statuses: Record<string, SetupStatus | null | undefined>): OwnerGrant[] {
  return grants.filter((grant) => {
    const cut = grant.id.indexOf(":");
    if (cut <= 0) return true;
    const item = statuses[grant.id.slice(0, cut)]?.items?.find((entry) => entry.key === grant.id.slice(cut + 1));
    return !(item && item.status === "done");
  });
}

/** The grants as markdown (the Finish setup issue). Paths get the company prefix. */
export function grantsMarkdown(grants: readonly OwnerGrant[], prefix: string | null): string {
  if (grants.length === 0) return "";
  const lines: string[] = ["## Needs you (one time)", "", "Everything an agent cannot do for this company, in one list. Do each once; nothing here repeats.", ""];
  grants.forEach((grant, index) => {
    lines.push(`${index + 1}. **${grant.title}**${grant.decision ? " (a decision)" : ""}: ${grant.why}`);
    for (const step of grant.steps) lines.push(`   - ${step}`);
    if (grant.command) lines.push(`   - Command: \`${grant.command}\``);
    if (grant.href) lines.push(`   - [${grant.hrefLabel ?? "Open"}](${linkFor(grant.href, prefix)})`);
    lines.push(`   - Once done: ${grant.after}`);
  });
  return lines.join("\n");
}


// ---------------------------------------------------------------------------
// What the page may report (the worker never trusts its size or shape)
// ---------------------------------------------------------------------------

export function clip(value: unknown, max: number): string {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const ITEM_STATUSES: readonly string[] = ["done", "skipped", "failed", "blocked", "needs_owner"];

/** Per-item results of a step (one plugin, one role, one template): at most 40, short text, nothing else. */
export function sanitizeItems(raw: unknown): StepItem[] {
  if (!Array.isArray(raw)) return [];
  const out: StepItem[] = [];
  for (const entry of raw.slice(0, 40)) {
    const row = rec(entry);
    const key = clip(row?.key, 80);
    const label = clip(row?.label, 120);
    if (!row || !key || !label || !ITEM_STATUSES.includes(String(row.status))) continue;
    const detail = clip(row.detail, 300);
    out.push({ key, label, status: row.status as StepItem["status"], ...(detail ? { detail } : {}) });
  }
  return out;
}

function safeHref(value: unknown): string | null {
  const href = typeof value === "string" ? value.trim() : "";
  if (!href) return null;
  // A Paperclip path or an https link; never a script or a data URL.
  return /^\/[A-Za-z0-9/_?=&#.%-]*$/.test(href) || /^https:\/\/[^\s]+$/.test(href) ? href.slice(0, 300) : null;
}

/** The owner list the page sends: at most 40 grants, short text, safe links. Anything else is dropped. */
export function sanitizeGrants(raw: unknown): OwnerGrant[] {
  if (!Array.isArray(raw)) return [];
  const out: OwnerGrant[] = [];
  for (const entry of raw.slice(0, 40)) {
    const row = rec(entry);
    const id = clip(row?.id, 100);
    const title = clip(row?.title, 160);
    if (!row || !id || !title || out.some((grant) => grant.id === id)) continue;
    const steps = (Array.isArray(row.steps) ? row.steps : []).slice(0, 8).map((step) => clip(step, 500)).filter(Boolean);
    const href = safeHref(row.href);
    out.push({
      id,
      title,
      why: clip(row.why, 500),
      steps,
      href,
      hrefLabel: href ? clip(row.hrefLabel, 60) || "Open" : null,
      command: clip(row.command, 300) || null,
      after: clip(row.after, 300),
      decision: row.decision === true,
    });
  }
  return out;
}
