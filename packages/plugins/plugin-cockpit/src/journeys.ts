/**
 * The acceptance journeys, from `journeys/*.json` (versioned data files, bundled
 * into the worker at build time: the deploy copies `dist`, not loose files).
 * Each is validated when this module loads, so a bad file fails the build and
 * the tests, never a night's run.
 */
import { TEAM_ROLES } from "@partnersinbiz/pib-plugin-kit/team";
import clientReport from "../journeys/client-report.json" with { type: "json" };
import emailSequenceDryRun from "../journeys/email-sequence-dry-run.json" with { type: "json" };
import leadCapture from "../journeys/lead-capture.json" with { type: "json" };
import quoteToInvoice from "../journeys/quote-to-invoice.json" with { type: "json" };
import seoSprintDraft from "../journeys/seo-sprint-draft.json" with { type: "json" };
import socialDraftReview from "../journeys/social-draft-review.json" with { type: "json" };
import { parseJourney, type Journey, type Trigger } from "./acceptance-model.js";

/** Roles a failure can be routed to: the kit's team, the Operator, and the Acceptance agent itself. */
export const JOURNEY_ROLES: readonly string[] = [...TEAM_ROLES.map((role) => role.key), "acceptance"];

export const JOURNEYS: Journey[] = [leadCapture, quoteToInvoice, emailSequenceDryRun, socialDraftReview, seoSprintDraft, clientReport].map((raw) => parseJourney(raw, JOURNEY_ROLES));

export function journeyByKey(key: string): Journey | null {
  return JOURNEYS.find((j) => j.key === key) ?? null;
}

/** The journeys a trigger runs: the nightly set, those that exercise a released plugin, or all of them on demand. */
export function journeysFor(trigger: Trigger, pluginKey?: string): Journey[] {
  return JOURNEYS.filter((j) => j.schedule.includes(trigger) && (trigger !== "release" || !pluginKey || j.plugins.includes(pluginKey)));
}
