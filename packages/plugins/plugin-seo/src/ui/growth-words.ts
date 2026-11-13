/** Growth tab words and rules (PAR-10101). Pure, so the tests need no browser. */
import type { GrowthExperimentRow, GrowthLoad } from "./types.js";

export const GROWTH_UNLINKED_TEXT = "This sprint is not linked to a CRM record, so its experiments cannot be shown. Link it to a client in the sprint's More menu.";

export function growthScopeLabel(g: Pick<GrowthLoad, "scope" | "clientName" | "legacyClientName">): string {
  if (g.scope === "own") return "Our own sites (shared by every own sprint)";
  return g.clientName?.trim() || g.legacyClientName?.trim() || "this client";
}

/** Who decides, from the autopilot mode (meaning copied from growth-host.ts). */
export function growthDecider(autopilot: string | null): string {
  switch (autopilot) {
    case "off": return "Autopilot off: the agent only reads, a person decides.";
    case "reviewed": return "Autopilot reviewed: the Reviewer decides what stays internal.";
    case "full": return "Autopilot full: the agent approves and wins are kept automatically.";
    default: return "Autopilot safe: a person approves.";
  }
}

export const canStart = (g: Pick<GrowthLoad, "running" | "maxRunning">): boolean => g.running < g.maxRunning;

export function splitExperiments(list: GrowthExperimentRow[]) {
  return {
    proposed: list.filter((x) => x.status === "proposed"),
    running: list.filter((x) => x.status === "running"),
    finished: list.filter((x) => x.status === "measured" || x.status === "rejected" || x.status === "abandoned"),
  };
}

export const playbookPointer = (n: number | null): string | null => (n && n > 0 ? `${n} playbook ${n === 1 ? "change waits" : "changes wait"} on the Playbook tab` : null);
