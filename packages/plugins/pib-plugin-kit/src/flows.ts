/**
 * The company graph (browser-safe): which work flows exist, the stages each
 * piece of work passes through, which module and role own each stage, and
 * who it waits on there. One definition drives the Cockpit's Flows view and
 * keeps the operating manual honest.
 *
 * Each plugin reports live numbers for the stages it owns in its Cockpit
 * snapshot (`CockpitSnapshot.flows`, see `FlowStageReport`). The Cockpit
 * draws every flow from `FLOWS`, fills in the reported numbers, and marks a
 * stage "switched off" when its module is off, its settings are not saved or
 * its role has no running agent.
 */
import { PIB_PLUGINS } from "./contracts.js";
import type { ModuleKey } from "./setup.js";
import type { TeamRoleKey } from "./team.js";

export type FlowKey = "lead-to-cash" | "onboarding" | "content" | "campaigns" | "books" | "payroll";

/** Who work waits on at a stage: an agent doing it, a person deciding, the customer, or the system. */
export type FlowWaitingOn = "agent" | "person" | "customer" | "system";

export interface FlowStage {
  /** Stable key, unique across all flows, e.g. `quote.approval`. */
  key: string;
  label: string;
  /** One line: what happens here. */
  description: string;
  module: ModuleKey;
  plugin: string;
  /** The role that works this stage (null when it waits on a person or the customer). */
  role: TeamRoleKey | null;
  waitingOn: FlowWaitingOn;
  /** The page that lists the items (no company prefix). */
  href: string;
}

export interface FlowDefinition {
  key: FlowKey;
  title: string;
  /** One line: what the flow achieves. */
  summary: string;
  stages: FlowStage[];
}

const s = (stage: FlowStage): FlowStage => stage;

export const FLOWS: FlowDefinition[] = [
  {
    key: "lead-to-cash",
    title: "Lead to cash",
    summary: "A lead becomes a client, is quoted, invoiced and paid, and the money lands in the books.",
    stages: [
      s({ key: "lead.in", label: "New leads", description: "Leads from Social and the Mailbox, waiting for a first follow-up.", module: "crm", plugin: PIB_PLUGINS.crm, role: "inbound-qualifier", waitingOn: "agent", href: "/crm?tab=contacts" }),
      s({ key: "deal.open", label: "Open deals", description: "Qualified leads being worked towards a quote.", module: "crm", plugin: PIB_PLUGINS.crm, role: "sales-lead", waitingOn: "agent", href: "/crm?tab=deals" }),
      s({ key: "quote.draft", label: "Quotes to send", description: "Drafted quotes nobody has asked to send yet.", module: "billing", plugin: PIB_PLUGINS.billing, role: "deal-desk", waitingOn: "agent", href: "/billing?tab=quotes" }),
      s({ key: "quote.approval", label: "Quotes to approve", description: "Quotes waiting for a person to approve sending.", module: "billing", plugin: PIB_PLUGINS.billing, role: null, waitingOn: "person", href: "/billing?tab=quotes" }),
      s({ key: "quote.sent", label: "Quotes with the customer", description: "Sent quotes waiting for the customer's answer.", module: "billing", plugin: PIB_PLUGINS.billing, role: null, waitingOn: "customer", href: "/billing?tab=quotes" }),
      s({ key: "invoice.draft", label: "Invoices to send", description: "Drafted invoices nobody has asked to send yet.", module: "billing", plugin: PIB_PLUGINS.billing, role: "account-manager", waitingOn: "agent", href: "/billing?tab=invoices" }),
      s({ key: "invoice.approval", label: "Invoices to approve", description: "Invoices waiting for a person to approve sending.", module: "billing", plugin: PIB_PLUGINS.billing, role: null, waitingOn: "person", href: "/billing?tab=invoices" }),
      s({ key: "invoice.open", label: "Owed to you", description: "Sent invoices not yet paid; overdue ones are stuck.", module: "billing", plugin: PIB_PLUGINS.billing, role: null, waitingOn: "customer", href: "/billing?tab=invoices" }),
      s({ key: "bank.match", label: "Bank lines to match", description: "Money in and out of the bank waiting to be matched to invoices and bills.", module: "accounting", plugin: PIB_PLUGINS.accounting, role: "bookkeeper", waitingOn: "agent", href: "/accounting?tab=bank" }),
    ],
  },
  {
    key: "onboarding",
    title: "Onboarding",
    summary: "A client's first win becomes a set-up client with its first work scheduled.",
    stages: [
      s({ key: "onboarding.open", label: "Clients being onboarded", description: "Onboarding issues the Operator is working through.", module: "cockpit", plugin: PIB_PLUGINS.cockpit, role: "operator", waitingOn: "agent", href: "/cockpit" }),
      s({ key: "onboarding.grants", label: "Access you still have to give", description: "Logins and access only a person can grant (asked once, with links).", module: "cockpit", plugin: PIB_PLUGINS.cockpit, role: null, waitingOn: "person", href: "/cockpit" }),
    ],
  },
  {
    key: "content",
    title: "Content",
    summary: "SEO work becomes live pages, and live pages become approved, published social posts.",
    stages: [
      s({ key: "seo.tasks", label: "SEO tasks due", description: "Sprint tasks due now for the SEO Specialist.", module: "seo", plugin: PIB_PLUGINS.seo, role: "seo-specialist", waitingOn: "agent", href: "/seo" }),
      s({ key: "seo.signoff", label: "SEO changes to sign off", description: "Site changes and content waiting for a person's sign-off.", module: "seo", plugin: PIB_PLUGINS.seo, role: null, waitingOn: "person", href: "/seo" }),
      s({ key: "social.drafts", label: "Posts being drafted", description: "Repurpose and planned posts the Social agent is drafting.", module: "social", plugin: PIB_PLUGINS.social, role: "social", waitingOn: "agent", href: "/social" }),
      s({ key: "social.approval", label: "Posts to approve", description: "Posts waiting for a person's approval.", module: "social", plugin: PIB_PLUGINS.social, role: null, waitingOn: "person", href: "/social" }),
      s({ key: "social.scheduled", label: "Posts scheduled", description: "Approved posts waiting for their publish time.", module: "social", plugin: PIB_PLUGINS.social, role: null, waitingOn: "system", href: "/social" }),
    ],
  },
  {
    key: "campaigns",
    title: "Campaigns",
    summary: "Email programmes are built, approved, sent step by step, and replies handled.",
    stages: [
      s({ key: "campaign.draft", label: "Campaigns being built", description: "Draft campaigns the Account Manager is preparing.", module: "campaigns", plugin: PIB_PLUGINS.campaigns, role: "account-manager", waitingOn: "agent", href: "/campaigns" }),
      s({ key: "campaign.approval", label: "Campaigns to approve", description: "Campaigns waiting for a person's approval.", module: "campaigns", plugin: PIB_PLUGINS.campaigns, role: null, waitingOn: "person", href: "/campaigns" }),
      s({ key: "campaign.running", label: "Campaigns running", description: "Campaigns sending their steps; failed sends are stuck.", module: "campaigns", plugin: PIB_PLUGINS.campaigns, role: null, waitingOn: "system", href: "/campaigns" }),
      s({ key: "campaign.replies", label: "Replies to handle", description: "Replies from campaigns and sequences waiting for an answer.", module: "campaigns", plugin: PIB_PLUGINS.campaigns, role: "account-manager", waitingOn: "agent", href: "/campaigns" }),
    ],
  },
  {
    key: "books",
    title: "Books",
    summary: "Bank statements come in, are matched and reconciled, and VAT and month-end are prepared for approval.",
    stages: [
      s({ key: "books.statements", label: "Statements to import", description: "Bank statements received but not yet imported.", module: "accounting", plugin: PIB_PLUGINS.accounting, role: "bookkeeper", waitingOn: "agent", href: "/accounting?tab=bank" }),
      s({ key: "books.approval", label: "Books to approve", description: "Reconciliations, journals and VAT201 waiting for a person's approval.", module: "accounting", plugin: PIB_PLUGINS.accounting, role: null, waitingOn: "person", href: "/accounting" }),
    ],
  },
  {
    key: "payroll",
    title: "Payroll",
    summary: "Pay runs are prepared, approved and locked, payslips go out, and EMP201 is filed.",
    stages: [
      s({ key: "payroll.prepare", label: "Pay runs being prepared", description: "Pay runs the Payroll Clerk is preparing.", module: "payroll", plugin: PIB_PLUGINS.payroll, role: "payroll-clerk", waitingOn: "agent", href: "/payroll?tab=runs" }),
      s({ key: "payroll.approval", label: "Pay runs to approve", description: "Pay runs waiting for a person to approve (and lock).", module: "payroll", plugin: PIB_PLUGINS.payroll, role: null, waitingOn: "person", href: "/payroll?tab=runs" }),
      s({ key: "payroll.emp201", label: "EMP201 to file", description: "Monthly PAYE, UIF and SDL returns to file and pay by the 7th.", module: "payroll", plugin: PIB_PLUGINS.payroll, role: "bookkeeper", waitingOn: "person", href: "/payroll" }),
    ],
  },
];

/** Every stage by key. */
export const FLOW_STAGES: Record<string, FlowStage & { flow: FlowKey }> = Object.fromEntries(
  FLOWS.flatMap((flow) => flow.stages.map((stage) => [stage.key, { ...stage, flow: flow.key }])),
);

/** The stages a plugin reports. */
export function flowStagesFor(pluginKey: string): Array<FlowStage & { flow: FlowKey }> {
  return Object.values(FLOW_STAGES).filter((stage) => stage.plugin === pluginKey);
}

/**
 * What a plugin reports for one of its stages in its Cockpit snapshot.
 * `count` is the items at the stage now; `stuck` those that are late,
 * blocked or unowned (with the reason in plain words); `amountMinor` an
 * optional money total in `currency`.
 */
export interface FlowStageReport {
  stage: string;
  count: number;
  stuck?: number;
  stuckReason?: string | null;
  amountMinor?: number | null;
  currency?: string | null;
  /** Oldest item's age in days, when it helps (e.g. oldest overdue invoice). */
  oldestDays?: number | null;
}

/** Keeps only reports for known stages this plugin owns, with sane numbers. */
export function cleanFlowReports(pluginKey: string, reports: FlowStageReport[]): FlowStageReport[] {
  const own = new Set(flowStagesFor(pluginKey).map((stage) => stage.key));
  return reports
    .filter((r) => own.has(r.stage) && Number.isFinite(r.count))
    .map((r) => ({ ...r, count: Math.max(0, Math.round(r.count)), stuck: r.stuck ? Math.max(0, Math.min(Math.round(r.stuck), Math.round(r.count))) : 0 }));
}
