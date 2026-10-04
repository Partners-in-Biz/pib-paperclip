/** The words around a proposal: the approval issue, the Reviewer's checklist, and the plain message a client can be asked with. */
import type { ProposalRow } from "./db.js";
import { formatMoney, pct } from "./money.js";
import { PROPOSAL_KIND_LABELS, type ProposalKind } from "./platforms.js";
import type { CampaignTarget, Creative } from "./proposal-input.js";

export interface ImpactSnapshot {
  month: string;
  currency: string;
  capMinor: number | null;
  spentMinor: number;
  committedDailyMinor: number;
  projectedBeforeMinor: number;
  projectedAfterMinor: number;
  addedThisMonthMinor: number;
  headroomAfterMinor: number | null;
  state: "no_cap" | "within" | "exceeds";
}

export function impactOf(p: Pick<ProposalRow, "impact">): ImpactSnapshot | null {
  const i = p.impact as Partial<ImpactSnapshot>;
  return typeof i.month === "string" && typeof i.currency === "string" ? (i as ImpactSnapshot) : null;
}

const money = (minor: unknown, currency: string) => (typeof minor === "number" ? formatMoney(minor, currency) : "n/a");

/** The number lines an approver reads, one per fact. */
export function numberLines(p: ProposalRow, currency: string): string[] {
  const x = p.payload;
  const lines: string[] = [];
  if (p.kind === "create_campaign") {
    lines.push(`Campaign: **${String(x.name)}** (${String(x.objective)}) on ${String(x.accountName)} (${String(x.platform)})`);
    lines.push(`Daily budget: **${money(x.dailyBudgetMinor, currency)}**`);
    if (x.startDate || x.endDate) lines.push(`Runs: ${String(x.startDate ?? "from approval")} to ${String(x.endDate ?? "no end date")}${typeof x.totalCommitmentMinor === "number" ? ` (${money(x.totalCommitmentMinor, currency)} in total)` : ""}`);
    else lines.push("Runs: no end date (it keeps spending its daily budget until someone stops it)");
    lines.push("It is created **paused**. Switching it on is a separate change with its own approval.");
    const audience = typeof x.audience === "string" ? x.audience : null;
    if (audience) lines.push(`Audience (to build in the platform): ${audience}`);
    if (Array.isArray(x.specialAdCategories) && x.specialAdCategories.length) lines.push(`Special ad categories: ${x.specialAdCategories.join(", ")}`);
  } else if (p.kind === "change_budget") {
    lines.push(`Campaign: **${String(x.campaignName)}** on ${String(x.accountName)} (${String(x.platform)}), currently ${String(x.campaignStatus)}`);
    lines.push(`Daily budget: ${money(x.currentDailyBudgetMinor, currency)} to **${money(x.newDailyBudgetMinor, currency)}**`);
  } else if (p.kind === "pause_campaign" || p.kind === "resume_campaign") {
    const targets = (Array.isArray(x.targets) ? x.targets : []) as CampaignTarget[];
    for (const t of targets.slice(0, 25)) {
      lines.push(`${p.kind === "pause_campaign" ? "Pause" : "Resume"} **${t.campaignName}** on ${t.accountName} (${t.platform}), daily budget ${money(t.dailyBudgetMinor, currency)}${typeof t.spendMonthMinor === "number" ? `, spent this month ${money(t.spendMonthMinor, currency)}` : ""}`);
    }
  } else {
    lines.push(`Platform: ${String(x.platform)}`);
  }
  const creative = x.creative as Creative | null | undefined;
  if (creative) {
    if (creative.headline) lines.push(`Headline: "${creative.headline}"`);
    if (creative.primaryText) lines.push(`Text: "${creative.primaryText}"`);
    if (creative.description) lines.push(`Description: "${creative.description}"`);
    if (creative.callToAction) lines.push(`Button: ${creative.callToAction}`);
    if (creative.landingUrl) lines.push(`Landing page: ${creative.landingUrl}`);
  }
  if (typeof x.reason === "string" && x.reason) lines.push(`Why: ${x.reason}`);
  return lines;
}

export function impactLines(p: ProposalRow): string[] {
  const i = impactOf(p);
  if (!i) return [];
  const lines: string[] = [];
  if (i.capMinor === null) {
    lines.push(`Budget cap for ${i.month}: **none set**. A change that adds spend cannot run until a person sets a monthly cap for this scope.`);
    lines.push(`Spent so far this month: ${money(i.spentMinor, i.currency)}.`);
    return lines;
  }
  lines.push(`Budget cap for ${i.month}: ${money(i.capMinor, i.currency)}; spent so far ${money(i.spentMinor, i.currency)} (${pct(i.capMinor ? i.spentMinor / i.capMinor : null)}).`);
  lines.push(`Active campaigns are committed to about ${money(i.projectedBeforeMinor, i.currency)} by month end${i.addedThisMonthMinor ? `; this change adds ${money(i.addedThisMonthMinor, i.currency)}, so ${money(i.projectedAfterMinor, i.currency)}` : ""}.`);
  lines.push(i.state === "exceeds" ? `**This goes over the cap by ${money(-(i.headroomAfterMinor ?? 0), i.currency)}.** Approve it on the Ads page with "over the cap" ticked, or refuse it.` : `Within the cap (${money(i.headroomAfterMinor, i.currency)} left after it).`);
  return lines;
}

export function precheckLines(p: ProposalRow): string[] {
  const findings = Array.isArray((p.precheck as { findings?: unknown }).findings) ? ((p.precheck as { findings: Array<{ level: string; where: string; text: string }> }).findings) : [];
  return findings.map((f) => `- ${f.level === "blocker" ? "**Blocker**" : "Warning"} (${f.where}): ${f.text}`);
}

/** What the Reviewer checks, per kind. Plain; the Reviewer reads the client's brand profile itself. */
export function reviewerChecks(kind: ProposalKind): string[] {
  const common = [
    "The numbers on this issue are the numbers the request asked for (budget, account, campaign, dates), in the right currency.",
    "The cap and pacing lines are right: nothing here pushes the month past its cap without saying so.",
    "It is for the right scope: PiB's own ads or this client only.",
  ];
  const copy = [
    "Read the client's brand profile (`partnersinbiz.crm:get-client-profile`) and check the copy against its voice and **banned words**: the plugin checked only the words it holds, you read the profile itself.",
    "Claims: nothing unsubstantiated, no guarantees or superlatives without proof, nothing the platform's ad policy rejects, no personal-attribute wording.",
    "The landing page is the client's, loads over https and matches what the ad promises.",
  ];
  if (kind === "create_campaign") return [...common, ...copy, "It is created paused and has a sensible daily budget for the client's size."];
  if (kind === "creative_check") return [...common.slice(2), ...copy];
  if (kind === "change_budget") return [...common, "The reason is real (performance, a plan), not a guess."];
  return [...common, kind === "resume_campaign" ? "The campaign is safe to switch on: its copy and landing page are still right." : "Pausing is right for this reason: look at the numbers on the issue."];
}

/** A plain message the Account Manager can pass to `create-client-action`: what we want to do and what it costs, no jargon. */
export function clientMessage(p: ProposalRow, clientName: string | null, currency: string): string {
  const x = p.payload;
  const i = impactOf(p);
  const lines: string[] = [`We would like your OK before we change your ads${clientName ? ` (${clientName})` : ""}.`, ""];
  if (p.kind === "create_campaign") lines.push(`New campaign: ${String(x.name)}. Daily budget ${money(x.dailyBudgetMinor, currency)}${x.endDate ? `, until ${String(x.endDate)}` : ""}.`);
  else if (p.kind === "change_budget") lines.push(`${String(x.campaignName)}: change the daily budget from ${money(x.currentDailyBudgetMinor, currency)} to ${money(x.newDailyBudgetMinor, currency)}.`);
  else if (p.kind === "resume_campaign") lines.push(`Switch your ads back on: ${((x.targets as CampaignTarget[]) ?? []).map((t) => t.campaignName).join(", ")}.`);
  else if (p.kind === "creative_check") lines.push(`The wording of a new ad: ${(x.creative as Creative | null)?.headline ?? ""} ${(x.creative as Creative | null)?.primaryText ?? ""}`.trim());
  else lines.push(`Pause your ads: ${((x.targets as CampaignTarget[]) ?? []).map((t) => t.campaignName).join(", ")}.`);
  if (i && i.capMinor !== null) lines.push(`Your agreed ad budget this month is ${money(i.capMinor, currency)}; so far ${money(i.spentMinor, currency)} has been spent.`);
  lines.push("", "Please reply to say yes or no, or tell us what you would change.");
  return lines.join("\n");
}

export function approvalIssueText(p: ProposalRow, input: { scopeLabel: string; currency: string; signoffs: string[]; writesNote: string }): string {
  const warnings = precheckLines(p);
  return [
    `**${PROPOSAL_KIND_LABELS[p.kind]} for ${input.scopeLabel}**`,
    "",
    p.summary,
    "",
    "## The numbers",
    ...numberLines(p, input.currency).map((l) => `- ${l}`),
    "",
    "## Budget",
    ...impactLines(p).map((l) => `- ${l}`),
    ...(warnings.length ? ["", "## Checks the plugin made on the copy", ...warnings] : []),
    "",
    "## How this is decided",
    `- Sign-offs needed: ${input.signoffs.join(" and ")}. ${input.signoffs.includes("client") ? "The client's own yes is recorded by a person on the Ads page after the client answers (the Account Manager asks the client)." : ""}`.trim(),
    "- Mark this issue **done** to approve exactly these numbers, or **cancelled** to refuse. Only a person can; an agent closing it is reopened. Changing the numbers cancels every earlier yes.",
    `- ${input.writesNote}`,
    `- Proposal id: \`${p.id}\` (the approval is valid for 72 hours after it is given).`,
  ].join("\n");
}
