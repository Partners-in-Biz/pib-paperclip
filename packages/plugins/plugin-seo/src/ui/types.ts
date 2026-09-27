/**
 * What the SEO worker's page actions return (`seo.load`, `seo.sprint`). Type
 * aliases, not interfaces, so the host DataTable accepts them as records.
 */
import type { NextTask } from "../engine/due.js";
import type { BusinessType } from "../templates/plans.js";
import type { NeedsYouView, ProjectOption, SetupItem, SiteLink } from "./autonomy.js";
import type { RoutineRef } from "./routines.js";
import type { TrafficDay } from "./series.js";

/** A sprint's counts (service/overview.ts; due, overdue, stuck and waiting follow engine/due.ts). */
export type SprintNumbers = {
  total: number;
  done: number;
  skipped: number;
  open: number;
  due: number;
  overdue: number;
  stuck: number;
  waiting: number;
  upcoming: number;
  openIssues: number;
  proposals: number;
  needsYou: number;
  waitingOnYou: number;
};

export type SprintSummary = {
  sprintId: string;
  siteName: string;
  siteUrl: string;
  /** `company:<id>` / `contact:<id>`; null = Partners in Biz's own site. */
  client: string | null;
  clientKind: "company" | "contact" | null;
  clientRef: string | null;
  clientName: string | null;
  legacyClientName?: string;
  status: string;
  legacy: boolean;
  startDate: string;
  day: number;
  week: number;
  phase: number;
  phaseName: string;
  businessType: BusinessType;
  /** The plan's name for people, e.g. "Local service business". */
  plan: string;
  autopilotMode: string;
  ownerUserId: string | null;
  rootIssueId: string | null;
  rootIssueIdentifier: string | null;
  health: { score?: number; signals?: Array<{ type: string; severity: string }> };
  lastDailyOn: string | null;
  notes: string | null;
  site?: SiteLink;
  tasks?: SprintNumbers;
  next?: NextTask | null;
};

export type ScopeClient = { kind: "company" | "contact"; id: string; name: string; domain: string | null; email: string | null; known: boolean };

export type HireAgent = { id: string; name: string; title: string | null; role: string | null; status: string; icon: string | null; createdAt: string | null };
export type HireRecord = {
  issueId: string;
  identifier: string | null;
  title: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  createdAt: string;
  status: "open" | "linked" | "cancelled";
};
export type HireView = {
  agent: HireAgent | null;
  linkedBy: "auto" | "manual" | "managed" | null;
  hire: (HireRecord & { issueStatus: string | null; assigneeName: string | null }) | null;
  candidates: HireAgent[];
};

/** The SEO agent as the page sees it: its status decides whether due work is stuck. */
export type AgentState = { id: string; status: string; name?: string | null } | null;

export type LoadResult = {
  today: string;
  timezone: string;
  userId: string | null;
  settings: {
    saved: boolean;
    publicBaseUrl: string | null;
    redirectUri: string | null;
    googleClientId: boolean;
    googleClientSecret: boolean;
    encryptionKey: boolean;
    pagespeedApiKey: boolean;
    bingApiKey: boolean;
    serviceAccountEmail: string | null;
    serviceAccountError: string | null;
    defaultAutopilotMode: string;
    dailyHourLocal: number;
  };
  agent: AgentState;
  /** The SEO agent's hire state; own page only (null in a client workspace). */
  hire: HireView | null;
  /** Company-level setup checklist (own page only). */
  setup: SetupItem[];
  /** The SEO routines and the page's last schedule report (own page only). */
  routines?: RoutineRef[];
  /** The page's scope: null = the SEO home (our own sites and every client's). */
  scope: string | null;
  client: ScopeClient | null;
  clientError: string | null;
  sprints: SprintSummary[];
};

export type Task = {
  id: string;
  templateKey: string | null;
  title: string;
  week: number;
  phase: number;
  dueDay: number | null;
  focus: string;
  taskType: string;
  owner: string;
  autopilotEligible: boolean;
  status: string;
  source: string;
  issueId: string | null;
  issueIdentifier: string | null;
  issueStatus: string | null;
  assigneeKind: string | null;
  blockerReason: string | null;
  humanAsk: string | null;
  completedAt: string | null;
};

export type Keyword = {
  id: string;
  phrase: string;
  intent: string | null;
  isPriority: boolean;
  targetUrl: string | null;
  rankingUrl: string | null;
  currentPosition: number | null;
  impressions: number | null;
  clicks: number | null;
  ctr: number | null;
  status: string;
  retiredAt: string | null;
  difficultyDr: number | null;
  history: Array<{ on: string | null; position: number | null; source: string }>;
};

export type Backlink = { id: string; source: string; domain: string; url: string | null; type: string; dr: number | null; status: string; notes: string | null; submittedAt: string | null; liveAt: string | null };
export type Content = { id: string; title: string; type: string; status: string; targetUrl: string | null; publishedOn: string | null; impressions: number | null; clicks: number | null; position: number | null; linksToPillarIds: string[]; socialPostIds: string[] };
export type Snapshot = { id: string; day: number; kind: string; capturedOn: string | null; source: string; traffic: Record<string, unknown>; rankings: Record<string, unknown>; authority: Record<string, unknown>; content: Record<string, unknown>; notes: string | null };
export type Finding = { id: string; finding: string; severity: string; category: string | null; url: string | null; source: string | null };
export type Optimization = {
  id: string;
  status: string;
  signalType: string;
  severity: string;
  hypothesis: string;
  hypothesisType: string;
  proposedAction: string;
  evidence: Record<string, unknown>;
  proposedTasks: Array<{ title: string }>;
  detectedOn: string | null;
  measureOn: string | null;
  result: string | null;
  outcome: { reasons?: string[] } | null;
  rejectedReason: string | null;
};
export type Integration = { provider: string; status: string; propertyUrl: string | null; lastPullAt: string | null; lastError: string | null; connected: boolean; auth?: "service_account" | "oauth" | null; stats: Record<string, unknown> };
export type PageHealth = { url: string; strategy: string; performance: number | null; seo: number | null; lcpMs: number | null; cls: number | null; inpMs: number | null; source: string; pulledOn: string | null };

export type SprintBundle = {
  sprint: SprintSummary;
  prefix: string | null;
  scoreboard: Record<string, { wins: number; losses: number; noChange: number; inconclusive?: number }>;
  today: { next?: string[]; warnings?: string[]; asOf?: string };
  tasks: Task[];
  keywords: Keyword[];
  backlinks: Backlink[];
  content: Content[];
  snapshots: Snapshot[];
  findings: Finding[];
  optimizations: Optimization[];
  integrations: Integration[];
  pageHealth: PageHealth[];
  /** Search Console impressions/clicks of tracked keywords per day. */
  traffic?: TrafficDay[];
  needsYou: NeedsYouView | null;
  setup: SetupItem[];
  projects: ProjectOption[];
  /** The scope's learned playbook: version and changes waiting for a decision. */
  playbook?: { playbookId: string | null; version: number | null; pending: number } | null;
};

export type TabId = "plan" | "keywords" | "backlinks" | "content" | "audits" | "optimizations" | "playbook" | "integrations";

export type CallFn = (tool: string, params: Record<string, unknown>, success?: string) => Promise<unknown>;
