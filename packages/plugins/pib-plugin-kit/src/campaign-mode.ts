/**
 * Campaign modes (pure). Each campaign has a mode, `off | safe | full` (shown as Off, Safe, Auto), that says what an agent
 * may do on it without a person. `agentMay` holds the whole rule table of the Campaigns plan (PAR-9192 rev. 2, section 5.2).
 *
 * The rules around the mode follow SEO's (plugin-seo keeps its own code): an agent may lower a mode, never raise it, and
 * cannot create a campaign in `full`. A mode change applies from that moment on.
 *
 * Only agents are asked: a person acting on the campaign screen is not checked here.
 */

export type CampaignMode = "off" | "safe" | "full";

export const CAMPAIGN_MODES: readonly CampaignMode[] = ["off", "safe", "full"];
/** New campaigns start in Safe (also the column default). */
export const DEFAULT_CAMPAIGN_MODE: CampaignMode = "safe";
export const CAMPAIGN_MODE_LABELS: Readonly<Record<CampaignMode, string>> = { off: "Off", safe: "Safe", full: "Auto" };

const RANK: Readonly<Record<CampaignMode, number>> = { off: 0, safe: 1, full: 2 };

export function isCampaignMode(value: unknown): value is CampaignMode {
  return typeof value === "string" && (CAMPAIGN_MODES as readonly string[]).includes(value);
}

/** A known mode, or null. */
export function parseCampaignMode(value: unknown): CampaignMode | null {
  return isCampaignMode(value) ? value : null;
}

/** Every path that starts, widens or changes a send (plan 3.2), one id per row of the table in 5.2. */
export type CampaignAgentAction =
  /** Read results, write the review. */
  | "read-results"
  /** Create and edit a draft, add steps, add a draft B version, ask for approval. */
  | "edit-draft"
  /** First launch of a draft. */
  | "first-launch"
  /** `launch-campaign` on a paused campaign: resumes it and enrolls the whole current audience again. */
  | "launch-paused"
  /** Resume a campaign this agent paused itself. */
  | "resume-own-pause"
  /** Resume after an automatic pause or a person's pause. */
  | "resume-other-pause"
  /** Enroll anyone into a launched campaign (`enroll-contact`). */
  | "enroll-launched"
  /** Enroll into a draft, before approval; the approver sees the audience. */
  | "enroll-draft"
  /** Pick the A/B winner between approved versions. */
  | "declare-winner"
  /** A new B version on a running campaign. */
  | "add-running-variant"
  | "complete"
  /** Pause, stop an enrollment, add to do-not-contact. */
  | "stop"
  /** Change sender, audience definition, delivery or dates on a launched campaign. */
  | "change-launched"
  | "raise-mode"
  /** A playbook change: the Growth Lab setting for the scope decides (`agentMayDecide`), not the campaign mode. */
  | "playbook-change";

export const CAMPAIGN_AGENT_ACTIONS: readonly CampaignAgentAction[] = [
  "read-results",
  "edit-draft",
  "first-launch",
  "launch-paused",
  "resume-own-pause",
  "resume-other-pause",
  "enroll-launched",
  "enroll-draft",
  "declare-winner",
  "add-running-variant",
  "complete",
  "stop",
  "change-launched",
  "raise-mode",
  "playbook-change",
];

/**
 * yes: the agent may (after checking `condition`, when set). no: not in this mode (or not at all).
 * person: refused; a person does it on the campaign screen. propose: the agent may propose it; a person approves.
 * growth-lab: not decided by the campaign mode; ask the Growth Lab setting.
 */
export type AgentMayVerdict = "yes" | "no" | "person" | "propose" | "growth-lab";
/** Who acts instead of the agent: any signed-in person of the company, or only the company owner. */
export type CampaignApprover = "person" | "owner";
/** What the caller must still check before a "yes" goes ahead. */
export type AgentMayCondition =
  /** The existing A/B significance rule passes. */
  | "significance"
  /** Every enrollment is finished. */
  | "all-enrollments-finished"
  /** The limits for an agent's B version (plan Q2: Reviewer pass, mechanical check, at most half of later enrollments). */
  | "variant-limits";

export interface CampaignScope {
  /** A client campaign: it goes out under the client's name. */
  isClient: boolean;
  /** An own campaign whose approved audience includes a current client (CRM lifecycle `customer`). */
  reachesClients: boolean;
}

export interface AgentMayDecision {
  action: CampaignAgentAction;
  mode: CampaignMode;
  verdict: AgentMayVerdict;
  /** True only for "yes". */
  allowed: boolean;
  condition?: AgentMayCondition;
  /** For "person" and "propose": who does or approves it. */
  approver?: CampaignApprover;
  /** The client's written yes must be recorded on the campaign first. */
  clientYes?: boolean;
  /** One sentence for the agent when it is not a plain yes: what it may not do and who does it. */
  reason: string;
}

type Cell = Omit<AgentMayDecision, "action" | "mode" | "allowed" | "reason"> & { reason?: string };

const YES: Cell = { verdict: "yes" };
const PERSON: Cell = { verdict: "person", approver: "person" };
const OWNER: Cell = { verdict: "person", approver: "owner" };
const OWNER_CLIENT_YES: Cell = { verdict: "person", approver: "owner", clientYes: true };

/** Off allows nothing but stopping; Safe and Auto allow drafting and reading. */
function draftingCell(mode: CampaignMode): Cell {
  return mode === "off" ? { verdict: "no" } : YES;
}

/** Who approves new or first-sent copy: the owner with the client's yes (Q5b, Q3), the owner (Q7), else any person (Q5a). */
function copyApprover(scope: CampaignScope): Cell {
  if (scope.isClient) return OWNER_CLIENT_YES;
  if (scope.reachesClients) return OWNER;
  return PERSON;
}

function cell(mode: CampaignMode, action: CampaignAgentAction, scope: CampaignScope): Cell {
  const auto = mode === "full";
  switch (action) {
    case "read-results":
    case "edit-draft":
    case "enroll-draft":
      return draftingCell(mode);
    case "first-launch":
      // Q1: a launch is a person's click in every mode.
      return copyApprover(scope);
    case "launch-paused":
    case "resume-other-pause":
    case "enroll-launched": // Q4: newcomers are enrolled by a person in every mode.
    case "raise-mode":
      return PERSON;
    case "resume-own-pause":
      return auto ? YES : PERSON;
    case "declare-winner":
      return auto ? { verdict: "yes", condition: "significance" } : PERSON;
    case "complete":
      return auto ? { verdict: "yes", condition: "all-enrollments-finished" } : PERSON;
    case "add-running-variant": {
      if (mode === "off") return { verdict: "no" };
      const approver = copyApprover(scope);
      if (mode === "safe") return { ...approver, verdict: "propose" };
      // Auto: own campaigns to leads only (Q2); never under a client's name (Q3) or to current clients (Q7).
      return approver.approver === "person" ? { verdict: "yes", condition: "variant-limits" } : approver;
    }
    case "stop":
      return YES;
    case "change-launched":
      return { verdict: "no", reason: "A launched campaign's sender, audience, delivery and dates cannot change. Pause it and make a new campaign." };
    case "playbook-change":
      return { verdict: "growth-lab", reason: "The campaign mode does not decide playbook changes; the Growth Lab setting for this scope does." };
  }
}

const ACTION_TEXT: Readonly<Record<CampaignAgentAction, string>> = {
  "read-results": "read this campaign's results",
  "edit-draft": "edit this draft",
  "first-launch": "launch this campaign",
  "launch-paused": "launch a paused campaign (that resumes it and enrolls the whole audience again)",
  "resume-own-pause": "resume this campaign",
  "resume-other-pause": "resume a campaign that a person or the automatic pause stopped",
  "enroll-launched": "enroll people into a launched campaign",
  "enroll-draft": "enroll people into this draft",
  "declare-winner": "pick the A/B winner",
  "add-running-variant": "add a new version to a running campaign",
  complete: "complete this campaign",
  stop: "stop sends",
  "change-launched": "change a launched campaign",
  "raise-mode": "raise the campaign mode",
  "playbook-change": "change the playbook",
};

function reasonFor(mode: CampaignMode, action: CampaignAgentAction, c: Cell): string {
  if (c.reason) return c.reason;
  if (c.verdict === "yes") return "";
  const what = ACTION_TEXT[action];
  const label = CAMPAIGN_MODE_LABELS[mode];
  if (c.verdict === "no") return `An agent may not ${what} in ${label} mode. Ask a person to raise the mode on the campaign screen, or leave it.`;
  const who = c.approver === "owner" ? "the company owner" : "a person";
  const yes = c.clientYes ? ", after the client's written yes is recorded on the campaign" : "";
  if (c.verdict === "propose") return `In ${label} mode an agent may only propose this: say so on the campaign's task, and ${who} approves it on the campaign screen${yes}.`;
  return `An agent may not ${what} in ${label} mode. Say so on the campaign's task; ${who} does it on the campaign screen${yes}.`;
}

/**
 * What an agent may do on a campaign without a person (plan 5.2). An unknown mode is read as Off, the strictest.
 * A "yes" with a `condition` still needs the caller to check that condition.
 */
export function agentMay(mode: CampaignMode, action: CampaignAgentAction, scope: CampaignScope): AgentMayDecision {
  const m: CampaignMode = isCampaignMode(mode) ? mode : "off";
  const c = cell(m, action, scope);
  if (!c) throw new Error(`unknown campaign action: ${String(action)}`);
  const decision: AgentMayDecision = { action, mode: m, verdict: c.verdict, allowed: c.verdict === "yes", reason: reasonFor(m, action, c) };
  if (c.condition) decision.condition = c.condition;
  if (c.approver) decision.approver = c.approver;
  if (c.clientYes) decision.clientYes = true;
  return decision;
}

export interface ModeRuleResult {
  allowed: boolean;
  /** Empty when allowed. */
  reason: string;
}

/** An agent may keep or lower a campaign's mode, never raise it. A person may set any mode (callers gate `full` until it ships). */
export function agentMaySetMode(current: CampaignMode, next: CampaignMode): ModeRuleResult {
  if (!isCampaignMode(next)) return { allowed: false, reason: "mode must be off, safe or full" };
  const from: CampaignMode = isCampaignMode(current) ? current : "off";
  if (RANK[next] <= RANK[from]) return { allowed: true, reason: "" };
  return {
    allowed: false,
    reason: `An agent can lower a campaign's mode but not raise it (${CAMPAIGN_MODE_LABELS[from]} to ${CAMPAIGN_MODE_LABELS[next]}). Ask a person to change it on the campaign screen.`,
  };
}

/** An agent cannot create a campaign in `full` (Auto): it creates it in Safe or Off and a person raises it. */
export function agentMayCreateIn(mode: CampaignMode): ModeRuleResult {
  if (!isCampaignMode(mode)) return { allowed: false, reason: "mode must be off, safe or full" };
  if (mode !== "full") return { allowed: true, reason: "" };
  return { allowed: false, reason: "An agent cannot create a campaign in Auto mode. Create it in Safe and ask a person to raise it on the campaign screen." };
}
