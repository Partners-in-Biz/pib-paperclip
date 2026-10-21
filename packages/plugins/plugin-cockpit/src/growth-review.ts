/**
 * The weekly growth review's text (Monday 06:30 SAST). Pure: the worker part
 * (who owns what, what the ledger holds, the issues) is in `growth-review-run.ts`.
 *
 * The Cockpit cannot read the channels' own tables, so the review is a
 * checklist for the agents: one issue per scope owner (reconcile the ledger,
 * one closing line per channel, goal proposals) and one hand-off issue per
 * channel agent (performance review, at most two new experiments, pending
 * playbook changes). Every list is built from one company's rows, so one
 * client's scope never appears in another owner's issue.
 */
import type { TeamRoleKey } from "@partnersinbiz/pib-plugin-kit";

/** Most new experiments one channel may get from a weekly review. */
export const REVIEW_MAX_EXPERIMENTS = 2;

/** Channel to the plugin whose tools run it and the role that works it (Revenue Lead for the Cockpit's own channels, campaigns and ads). */
const CHANNELS: Record<string, { plugin: string; role: TeamRoleKey }> = {
  social: { plugin: "partnersinbiz.social", role: "social" },
  seo: { plugin: "partnersinbiz.seo", role: "seo-specialist" },
  campaigns: { plugin: "partnersinbiz.campaigns", role: "revenue-lead" },
  ads: { plugin: "partnersinbiz.ads", role: "revenue-lead" },
  website: { plugin: "partnersinbiz.cockpit", role: "revenue-lead" },
  aso: { plugin: "partnersinbiz.cockpit", role: "revenue-lead" },
  book: { plugin: "partnersinbiz.cockpit", role: "revenue-lead" },
  revenue: { plugin: "partnersinbiz.cockpit", role: "revenue-lead" },
};
/** Channels reviewed for `own` even before they have a row. */
export const DEFAULT_OWN_CHANNELS = ["social", "seo", "campaigns"] as const;

export const channelPlugin = (channel: string): string => CHANNELS[channel]?.plugin ?? `partnersinbiz.${channel}`;
export const channelRole = (channel: string): TeamRoleKey => CHANNELS[channel]?.role ?? "revenue-lead";

/** One verdict from the ledger, this week. */
export interface ReviewLedgerLine {
  experimentId: string;
  verdict: string | null;
  /** A fraction: 0.12 is +12%. */
  relativeChange: number | null;
  playbookDecision: string | null;
}

export interface ReviewChannel {
  channel: string;
  /** This week's verdicts for this channel and scope only. */
  ledger: ReviewLedgerLine[];
}

export interface ReviewScope {
  scopeKey: string;
  channels: ReviewChannel[];
}

const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
/** Not every channel has its experiment tools yet (SEO and Campaigns come later), so a missing tool is skipped, not guessed. */
const MISSING_TOOL_RULE = "If a tool named here is not registered yet, say so in one line and skip it; do not guess another tool.";

const pct = (v: number | null): string => (v === null ? "n/a" : `${v >= 0 ? "+" : ""}${Math.round(v * 1000) / 10}%`);
const tool = (channel: string, name: string): string => `\`${channelPlugin(channel)}:${name}\``;

/** The rule for a scope's autopilot, in the words of the lifecycle (`off|safe|reviewed|full`). */
const AUTOPILOT_RULE =
  "Pending playbook changes (`get-playbook`): on autopilot `full` decide each one yourself with `decide-playbook-change` (keep a win, discard a loss); on `reviewed` only the Reviewer decides, so if you are not the Reviewer leave it on its approval issue; on `safe` or `off` leave it pending. On a `client:*` scope a client-facing post still needs the person's approval.";

function ledgerTable(channels: ReviewChannel[]): string[] {
  const rows = channels.flatMap((c) => c.ledger.map((l) => `| ${cell(c.channel)} | ${cell(l.experimentId)} | ${l.verdict ?? "pending"} | ${pct(l.relativeChange)} | ${l.playbookDecision ?? "–"} |`));
  if (rows.length === 0) return ["No verdicts reached the ledger this week."];
  return ["| Channel | Experiment | Verdict | Change | Playbook |", "|---|---|---|---|---|", ...rows];
}

/** The issue for one scope owner: reconcile, close out, propose goals. */
export function growthReviewContent(input: { weekLabel: string; scopes: ReviewScope[]; proposeGoals: boolean; cockpitHref: string }): { title: string; description: string } {
  const { scopes } = input;
  const lines: string[] = [
    `The weekly growth review for the week of ${input.weekLabel}. You own ${scopes.length} ${scopes.length === 1 ? "scope" : "scopes"}: ${scopes.map((s) => `\`${s.scopeKey}\``).join(", ")}. Each channel's agent got its own hand-off issue for the performance review and the new experiments; yours is to check the ledger and close the week out.`,
    "",
    MISSING_TOOL_RULE,
    "",
    "## 1. Reconcile the ledger",
    "Verdict events are best effort. For each channel and scope below, call the channel's `list-experiments`, and for every measured experiment that `partnersinbiz.cockpit:growth-ledger` does not show, call `partnersinbiz.cockpit:ledger-upsert` with the experiment's own `decidedAt` (a repeat is then a no-op).",
    "",
  ];
  for (const scope of scopes) {
    lines.push(`### \`${scope.scopeKey}\``, "");
    lines.push(...ledgerTable(scope.channels), "");
    lines.push(`Check: ${scope.channels.map((c) => `${tool(c.channel, "list-experiments")} with scope \`${scope.scopeKey}\``).join("; ")}.`, "");
  }
  lines.push("## 2. One line per channel", "Comment one line for each channel and scope above: what won, what lost, what runs next. Keep it to the numbers.", "");
  if (input.proposeGoals) {
    lines.push("## 3. Goals", "The company has no goal yet. Propose one to three with `goal-set` (a metric key, a target, a period). The owner confirms them together through the one question the Cockpit already asks; do not ask again.", "");
  }
  lines.push(`Cockpit: ${input.cockpitHref}`);
  return { title: `Weekly growth review: week of ${input.weekLabel}`, description: lines.join("\n") };
}

/** The hand-off issue for one channel agent: review, experiments, playbook. `scopes` maps a channel to the scopes it covers. */
export function growthHandoffContent(input: { weekLabel: string; channels: Array<{ channel: string; scopes: string[] }> }): { title: string; description: string } {
  const lines: string[] = [
    `Your part of the weekly growth review for the week of ${input.weekLabel}. For each channel and scope below, pass the scope to every tool.`,
    MISSING_TOOL_RULE,
    "",
  ];
  for (const { channel, scopes } of input.channels) {
    lines.push(`## ${channel}`, "");
    for (const scope of scopes) {
      lines.push(
        `### \`${scope}\``,
        `1. Run ${tool(channel, "performance-review")} and read \`partnersinbiz.cockpit:growth-ledger\` so a lost idea is not run again.`,
        `2. Propose at most ${REVIEW_MAX_EXPERIMENTS} new experiments with ${tool(channel, "propose-experiment")}: one variable each, no more than ${REVIEW_MAX_EXPERIMENTS} this week for this channel and scope.`,
        `3. ${AUTOPILOT_RULE}`,
        "",
      );
    }
  }
  lines.push("Comment what you did, one line per channel and scope, and mark this issue done.");
  return { title: `Weekly growth review, hand-off: week of ${input.weekLabel}`, description: lines.join("\n") };
}
