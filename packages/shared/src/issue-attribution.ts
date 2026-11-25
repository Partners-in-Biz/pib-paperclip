import type { Issue } from "./types/issue.js";

export type ResponsibleUserSource = "explicit" | "creator" | "none";

export interface ResponsibleUserAttribution {
  userId: string | null;
  source: ResponsibleUserSource;
  isAutoDerived: boolean;
}

export function deriveResponsibleUser(
  issue: Pick<Issue, "responsibleUserId" | "createdByUserId">,
): ResponsibleUserAttribution {
  if (issue.responsibleUserId) {
    return { userId: issue.responsibleUserId, source: "explicit", isAutoDerived: false };
  }

  if (issue.createdByUserId) {
    return { userId: issue.createdByUserId, source: "creator", isAutoDerived: true };
  }

  return { userId: null, source: "none", isAutoDerived: false };
}

/**
 * The actor to display as an issue's "Originating" attribution.
 *
 * A human creator always wins (`createdByUserId`). When an agent created the
 * issue but a transitive human responsible user is known, we attribute the
 * originator to that human and record the creating agent as `viaAgentId` so the
 * UI can show a "via <agent>" affordance. Agent-only creators fall back to the
 * agent, and routine executions (no `createdBy*`) surface the responsible user.
 */
export type OriginatingActor =
  | { kind: "user"; id: string; viaAgentId?: string }
  | { kind: "agent"; id: string };

export function deriveOriginatingActor(
  issue: Pick<Issue, "createdByUserId" | "createdByAgentId" | "responsibleUserId">,
): OriginatingActor | null {
  if (issue.createdByUserId) {
    return { kind: "user", id: issue.createdByUserId };
  }

  if (issue.createdByAgentId) {
    if (issue.responsibleUserId) {
      return { kind: "user", id: issue.responsibleUserId, viaAgentId: issue.createdByAgentId };
    }
    return { kind: "agent", id: issue.createdByAgentId };
  }

  if (issue.responsibleUserId) {
    return { kind: "user", id: issue.responsibleUserId };
  }

  return null;
}

/** The three kinds of "Created by" shown on a task. */
export type IssueCreatorKind = "person" | "agent" | "automation";

export const ISSUE_CREATOR_KINDS: readonly IssueCreatorKind[] = ["person", "agent", "automation"];

export type IssueCreator =
  | { kind: "person"; id: string }
  | { kind: "agent"; id: string }
  | { kind: "automation"; name: string };

const KNOWN_PLUGIN_NAMES: Record<string, string> = {
  seo: "SEO",
  crm: "CRM",
  mailbox: "Mailbox",
  cockpit: "Cockpit",
  social: "Social",
  billing: "Billing",
  campaigns: "Campaigns",
  ads: "Ads",
  studio: "Studio",
  partners: "Partners",
  payroll: "Payroll",
  accounting: "Accounting",
  voice: "Voice",
  setup: "Setup",
};

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** "plugin:partnersinbiz.seo:operation" -> "SEO". */
export function pluginSourceName(originKind: string): string {
  const key = originKind.split(":")[1] ?? "";
  const last = (key.split(".").pop() ?? key).replace(/^(pib-)?(plugin-)?/, "");
  return KNOWN_PLUGIN_NAMES[last] ?? (titleCase(last) || "Plugin");
}

/**
 * Who created a task, as one of three kinds. A person (`createdByUserId`) wins,
 * then an agent (`createdByAgentId`). A task with neither came from an
 * automation and is named by its source: a plugin ("SEO", "Mailbox"), a routine
 * ("Routine: <name>", `routineName` from the routine lookup) or the system.
 * Never returns blank, so new tasks always show a creator.
 */
export function deriveIssueCreator(
  issue: Pick<Issue, "createdByUserId" | "createdByAgentId"> & { originKind?: string | null },
  options: { routineName?: string | null } = {},
): IssueCreator {
  if (issue.createdByUserId) return { kind: "person", id: issue.createdByUserId };
  if (issue.createdByAgentId) return { kind: "agent", id: issue.createdByAgentId };
  const originKind = issue.originKind ?? "";
  if (originKind === "routine_execution") {
    const name = options.routineName?.trim();
    return { kind: "automation", name: name ? `Routine: ${name}` : "Routine" };
  }
  if (originKind.startsWith("plugin:")) return { kind: "automation", name: pluginSourceName(originKind) };
  if (originKind && originKind !== "manual") return { kind: "automation", name: `System: ${titleCase(originKind)}` };
  return { kind: "automation", name: "System" };
}
