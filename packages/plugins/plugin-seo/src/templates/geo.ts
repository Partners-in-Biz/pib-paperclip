/**
 * The GEO (AI search) workstream every 90-day plan carries from template version 5: eight tasks that make a site
 * readable by AI answer engines (ChatGPT, Claude, Perplexity, Google AI Overviews, Copilot), say who the business is,
 * and check whether the answers name it. Their playbooks are in playbooks.ts; the checks and tools are in
 * checks/geo.ts and service/geo.ts.
 *
 * Week 0 and 1 are one-time setup; weeks 2, 8 and 13 sample AI answers against a baseline; after day 90 the weekly
 * job opens a monthly re-check (`geo-recheck:<yyyy-mm>`, see service/geo.ts).
 */
import { phaseForWeek, type SeoTaskTemplate } from "./outrank-90.js";

function geoTask(input: Omit<SeoTaskTemplate, "phase" | "playbook" | "owner" | "focus"> & { focus?: string }): SeoTaskTemplate {
  return { owner: "agent", focus: "AI search", ...input, phase: phaseForWeek(input.week) as SeoTaskTemplate["phase"], playbook: input.templateKey };
}

export const GEO_TASKS: SeoTaskTemplate[] = [
  geoTask({ templateKey: "w0-geo-crawlers", week: 0, title: "Make sure AI search tools can read the site (ChatGPT, Claude, Perplexity, Google)", taskType: "geo-crawler-access", autopilotEligible: true }),
  geoTask({ templateKey: "w1-geo-llms-txt", week: 1, title: "Add an llms.txt file that points AI tools to the key pages", taskType: "geo-llms-txt", autopilotEligible: true }),
  geoTask({ templateKey: "w1-geo-entity", week: 1, title: "Tell AI tools who the business is: organisation details and links to its real profiles", taskType: "geo-entity-schema", autopilotEligible: true }),
  geoTask({ templateKey: "w2-geo-baseline", week: 2, title: "Ask AI assistants the questions customers ask and record whether the business is mentioned", taskType: "geo-mention-check", autopilotEligible: true }),
  geoTask({ templateKey: "w4-geo-answers", week: 4, title: "Put a short direct answer under each main question on the core pages", taskType: "geo-answer-blocks", autopilotEligible: true }),
  geoTask({ templateKey: "w6-geo-brand", week: 6, title: "Make the business name, description and contact details match everywhere it is listed", taskType: "geo-brand-consistency", autopilotEligible: true }),
  geoTask({ templateKey: "w8-geo-recheck", week: 8, title: "Ask the same AI questions again and compare with the baseline", taskType: "geo-mention-check", autopilotEligible: true }),
  geoTask({ templateKey: "w13-geo-recheck", week: 13, dueDay: 90, title: "Day-90 AI search check: readiness score and AI answers compared with the baseline", taskType: "geo-mention-check", autopilotEligible: true }),
];

export const GEO_TASK_KEYS: string[] = GEO_TASKS.map((t) => t.templateKey);

/** Template keys added in version 5 (existing sprints get them from the daily run's plan upgrade). */
export const TEMPLATE_V5_ADDED = GEO_TASK_KEYS;

/** Task types whose work is a change to the site (they open in the site project). The other GEO types are research and records. */
export const GEO_CODE_TYPES = ["geo-crawler-access", "geo-llms-txt", "geo-entity-schema", "geo-answer-blocks"] as const;

/** Task types `complete-task` checks against a recorded geo-audit. */
export const GEO_AUDIT_TYPES = ["geo-crawler-access", "geo-llms-txt", "geo-entity-schema", "geo-answer-blocks", "geo-brand-consistency"] as const;

/** The monthly re-check key for a calendar month (`2026-11`). */
export function monthlyGeoKey(month: string): string {
  return `geo-recheck:${month}`;
}

export function isMonthlyGeoKey(key: string | null | undefined): boolean {
  return Boolean(key && /^geo-recheck:\d{4}-\d{2}$/.test(key));
}
