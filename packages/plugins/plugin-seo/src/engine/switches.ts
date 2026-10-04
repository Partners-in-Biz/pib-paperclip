/**
 * The three extras that came with 0.23.0 (AI search, Google Analytics, page groups) are off until a person switches
 * them on, per sprint. Pure: which extras exist, the plain words the page shows for each (what turning it on adds, what
 * it needs, what turning it off does), and the rules for reading a switch from a request.
 *
 * Nothing here decides who may switch: that is `service/switches.ts` (a signed-in person only, never an agent).
 */
import { GEO_TASKS } from "../templates/geo.js";

export const SWITCH_FEATURES = ["geo", "ga4", "chunks"] as const;
export type SwitchFeature = (typeof SWITCH_FEATURES)[number];

export type Switches = Record<SwitchFeature, boolean>;

export const ALL_OFF: Switches = { geo: false, ga4: false, chunks: false };

export interface FeatureCopy {
  key: SwitchFeature;
  label: string;
  /** One sentence on the page: what turning it on adds. */
  adds: string;
  /** What else it does, in plain words (shown under the one-liner and in the confirmation). */
  detail: string;
  /** What has to be done first (a one-time grant), or null. */
  needs: string | null;
  /** What turning it off does. */
  off: string;
}

export const GEO_TASK_COUNT = GEO_TASKS.length;

export const FEATURES: Record<SwitchFeature, FeatureCopy> = {
  geo: {
    key: "geo",
    label: "AI search (GEO)",
    adds: `Adds up to ${GEO_TASK_COUNT} AI-search (GEO) tasks to this sprint and checks the site's AI-search readiness every 4 weeks.`,
    detail:
      "The agent works the tasks like any other: let AI crawlers in, add an llms.txt, say who the business is in the site's data, ask AI assistants the customers' questions and record the answers, add short direct answers, make the business name match everywhere, and re-check at week 8 and day 90 (then once a month after day 90). The readiness check reads robots.txt, llms.txt, the home page and a few key pages, and asks the site's server for the home page the way ChatGPT's, Claude's and Perplexity's crawlers do. The tasks that change the site go through the sprint's change policy and sign-off like every other change.",
    needs: null,
    off: "Closes the AI-search tasks that are not finished (marked not needed, their issues cancelled) and stops the checks. What was recorded stays. A pull request one of those tasks already opened on the client's repository is not closed for you.",
  },
  ga4: {
    key: "ga4",
    label: "Google Analytics (GA4)",
    adds: "Reads this site's Google Analytics (read only) every morning and shows organic visits and key events in the weekly review and the snapshots.",
    detail:
      "It looks for the site's property by its address every few days until it finds one, then pulls the weekly numbers through our Google service account. It can read only: it cannot change anything in the client's Analytics. A missing grant is listed on the sprint's Needs you page as optional advice (it never opens an issue by itself).",
    needs:
      "Two one-time Google steps first (not done yet): the Google Analytics Data and Admin APIs are enabled for our Google Cloud project, and the property's owner adds our service account as a Viewer in Analytics. Until both are done nothing is read.",
    off: "Stops the daily look-up and pull and clears its optional Needs you lines. The numbers already pulled stay.",
  },
  chunks: {
    key: "chunks",
    label: "Page groups",
    adds: "Splits big site-wide tasks (titles, alt text, noindex, canonicals) into groups of pages, one child issue at a time.",
    detail:
      "When a site-wide task is opened or started on a site with more pages than one agent run does well, the plugin reads the site's sitemap and splits the task into groups of 10 to 40 pages. Each group is its own child issue, opened when the one before it is done; the task is completed after the last group.",
    needs: null,
    off: "Stops new splits. Groups that are already open are finished as planned.",
  },
};

export function isSwitchFeature(value: unknown): value is SwitchFeature {
  return typeof value === "string" && (SWITCH_FEATURES as readonly string[]).includes(value);
}

/** The switches of a sprint (or a company default) from its row; anything that is not exactly true is off. */
export function switchesOf(source: { geoEnabled?: boolean; ga4Enabled?: boolean; chunksEnabled?: boolean } | null | undefined): Switches {
  return { geo: source?.geoEnabled === true, ga4: source?.ga4Enabled === true, chunks: source?.chunksEnabled === true };
}

/**
 * The switches a person chose in a request (`{ geo: true, ... }`). Only a real boolean counts, so "false", "no" and 0 can
 * never turn anything on by accident. Unknown keys are an error: the caller should know it asked for something that does
 * not exist.
 */
export function parseSwitches(value: unknown): { switches: Partial<Switches>; errors: string[] } {
  const switches: Partial<Switches> = {};
  const errors: string[] = [];
  if (value == null) return { switches, errors };
  if (typeof value !== "object" || Array.isArray(value)) return { switches, errors: ["switches must be an object like { geo: true }"] };
  for (const [key, flag] of Object.entries(value as Record<string, unknown>)) {
    if (!isSwitchFeature(key)) errors.push(`Unknown extra "${key}": ${SWITCH_FEATURES.join(", ")}`);
    else if (typeof flag !== "boolean") errors.push(`"${key}" must be true or false`);
    else switches[key] = flag;
  }
  return { switches, errors };
}

/** The refusal an agent tool gives for a sprint where the extra is off: it says who can turn it on, and that nothing changed. */
export function offMessage(feature: SwitchFeature): string {
  const f = FEATURES[feature];
  return `${f.label} is off for this sprint, so nothing was read, recorded or changed. It is off until a person turns it on (SEO page → the sprint → Integrations → Extras); you cannot turn it on.`;
}
