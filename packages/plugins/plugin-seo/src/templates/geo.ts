/**
 * The GEO (AI search) workstream: eleven tasks that make a site readable by AI answer engines (ChatGPT, Claude,
 * Perplexity, Google AI Overviews, Copilot), say who the business is, and check whether the answers name it. Their
 * playbooks are in playbooks.ts; the checks and tools are in checks/geo.ts and service/geo.ts.
 *
 * It is an add-on, not part of any plan: `plans.ts` never lists these tasks, so no plan, seed or plan change can add them.
 * They reach a sprint only when a person switches AI search on for it (`service/switches.ts` adds them, and closes the
 * unfinished ones when it is switched off).
 *
 * Week 0 and 1 are one-time setup; weeks 2, 8 and 13 sample AI answers against a baseline; after day 90 the daily run
 * opens a monthly re-check (`geo-recheck:<yyyy-mm>`, see service/geo.ts) while the switch is on.
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
  geoTask({ templateKey: "w3-geo-queries", week: 3, title: "Map the searches AI assistants run for this business and which ranking pages list it", taskType: "geo-query-map", autopilotEligible: true }),
  geoTask({ templateKey: "w4-geo-answers", week: 4, title: "Put a short direct answer under each main question on the core pages", taskType: "geo-answer-blocks", autopilotEligible: true }),
  geoTask({ templateKey: "w5-geo-self-rank", week: 5, title: "Find pages where the site ranks itself first and fix the ones that earn no clicks", taskType: "geo-self-rank", autopilotEligible: true }),
  geoTask({ templateKey: "w6-geo-brand", week: 6, title: "Make the business name, description and contact details match everywhere it is listed", taskType: "geo-brand-consistency", autopilotEligible: true }),
  geoTask({ templateKey: "w8-geo-recheck", week: 8, title: "Ask the same AI questions again and compare with the baseline", taskType: "geo-mention-check", autopilotEligible: true }),
  geoTask({ templateKey: "w10-geo-outreach", week: 10, title: "Get listed in other sites' \"best of\" rankings: leads and drafted emails for approval", taskType: "geo-citation-outreach", autopilotEligible: true }),
  geoTask({ templateKey: "w13-geo-recheck", week: 13, dueDay: 90, title: "Day-90 AI search check: readiness score and AI answers compared with the baseline", taskType: "geo-mention-check", autopilotEligible: true }),
];

export const GEO_TASK_KEYS: string[] = GEO_TASKS.map((t) => t.templateKey);

/** Task types whose work is a change to the site (they open in the site project). The other GEO types are research and records. */
export const GEO_CODE_TYPES = ["geo-crawler-access", "geo-llms-txt", "geo-entity-schema", "geo-answer-blocks", "geo-self-rank"] as const;

/** Task types `complete-task` checks against a recorded geo-audit. */
export const GEO_AUDIT_TYPES = ["geo-crawler-access", "geo-llms-txt", "geo-entity-schema", "geo-answer-blocks", "geo-brand-consistency"] as const;

/** The monthly re-check key for a calendar month (`2026-11`). */
export function monthlyGeoKey(month: string): string {
  return `geo-recheck:${month}`;
}

export function isMonthlyGeoKey(key: string | null | undefined): boolean {
  return Boolean(key && /^geo-recheck:\d{4}-\d{2}$/.test(key));
}

/** Whether a task key belongs to the AI-search add-on: its eight tasks and the monthly re-checks. No plan owns these keys. */
export function isGeoTemplateKey(key: string | null | undefined): boolean {
  return Boolean(key && (GEO_TASK_KEYS.includes(key) || isMonthlyGeoKey(key)));
}
