/**
 * Guided setup for Payroll (kit `SetupStatus`): what a company still needs
 * before pay runs, payslips and the Payroll Clerk can work on their own.
 * Served at `GET /setup-status` and pushed hourly to the Setup plugin.
 *
 * Every probe is defensive: a failing check shows as "unknown" and never
 * breaks the whole status. No personal details, user ids or secret values
 * go into the status.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  hireStatus,
  isModuleEnabled,
  PIB_PLUGINS,
  pluginUiBase,
  settingsItem,
  type SetupItem,
  type SetupStatus,
} from "@partnersinbiz/pib-plugin-kit";
import * as db from "../db.js";
import { LOCAL_BOARD_USER_ID, type Actor } from "../domain.js";
import { CLERK_ROLE } from "../hire.js";
import manifest from "../manifest.js";
import { PLUGIN_ID } from "../namespace.js";
import { ruleVersionFor, taxYearOf, type RuleVersion } from "../rules.js";
import { members } from "./agent-tools.js";
import { requireUser, today, type Env } from "./env.js";

const SETTINGS_FALLBACK = "/company/settings/instance/plugins";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The settings page path: by installation uuid once the Payroll page has been opened, else the plugin list. */
export async function settingsHref(ctx: PluginContext): Promise<{ pluginId: string | null; href: string }> {
  let base: string | null = null;
  try {
    base = await pluginUiBase(ctx);
  } catch {
    base = null;
  }
  const match = base ? /^\/_plugins\/([^/]+)\/ui\/$/.exec(base) : null;
  const id = match && UUID.test(match[1]!) ? match[1]!.toLowerCase() : null;
  return { pluginId: id, href: id ? `${SETTINGS_FALLBACK}/${id}` : SETTINGS_FALLBACK };
}

// ---------------------------------------------------------------------------
// Rules review (the person confirms an accountant checked the unconfirmed rules)
// ---------------------------------------------------------------------------

const RULES_REVIEW_STATE = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "payroll-setup", stateKey: "rules-review" });

interface RulesReview {
  ruleVersionId: string;
  contentHash: string;
  paths: string[];
  at: string;
}

function reviewCovers(review: RulesReview | null, version: RuleVersion): boolean {
  if (!review || review.ruleVersionId !== version.id || review.contentHash !== version.contentHash) return false;
  const reviewed = new Set(review.paths);
  return version.unverified.every((u) => reviewed.has(u.path));
}

async function readRulesReview(ctx: PluginContext, companyId: string): Promise<RulesReview | null> {
  const value = (await ctx.state.get(RULES_REVIEW_STATE(companyId))) as RulesReview | null;
  return value && typeof value === "object" && typeof value.ruleVersionId === "string" ? value : null;
}

/** Whether the unconfirmed rules of the rule version in force today were marked as reviewed. */
export async function rulesReviewed(e: Env, companyId: string): Promise<boolean> {
  try {
    const version = ruleVersionFor(await db.listRuleVersions(e.ctx), today(e));
    if (!version || !version.unverified.length) return true;
    return reviewCovers(await readRulesReview(e.ctx, companyId), version);
  } catch {
    return false;
  }
}

/** Board action `payroll.review-rules`: records that an accountant checked the unconfirmed rules. */
export async function markRulesReviewed(e: Env, companyId: string, actor: Actor) {
  const user = requireUser(actor);
  const version = ruleVersionFor(await db.listRuleVersions(e.ctx), today(e));
  if (!version) return { reviewed: false, unverified: 0 };
  const review: RulesReview = { ruleVersionId: version.id, contentHash: version.contentHash, paths: version.unverified.map((u) => u.path), at: e.now().toISOString() };
  await e.ctx.state.set(RULES_REVIEW_STATE(companyId), review);
  await db.audit(e.ctx, companyId, { userId: user.userId, agentId: null }, "rules.reviewed", "rule_version", version.id, { paths: review.paths });
  return { reviewed: true, unverified: version.unverified.length };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

type ItemBase = Pick<SetupItem, "key" | "title" | "required"> & Partial<Pick<SetupItem, "href" | "hrefLabel">>;

/** Runs one check; a failure becomes "unknown" instead of breaking the status. */
async function probe(e: Env, base: ItemBase, check: () => Promise<Omit<SetupItem, "key" | "title" | "required">>): Promise<SetupItem> {
  try {
    return { ...base, ...(await check()) };
  } catch (error) {
    e.ctx.logger.info("Payroll setup check failed", { key: base.key, error: error instanceof Error ? error.message : String(error) });
    return { ...base, status: "unknown", detail: "Could not check this right now. Try again later." };
  }
}

const done = (required: boolean, missing: boolean) => (missing ? (required ? "missing" : "optional") : "done") as SetupItem["status"];

export async function setupStatus(e: Env, companyId: string): Promise<SetupStatus> {
  const { ctx } = e;
  const date = today(e);
  const settings = await settingsHref(ctx).catch(() => ({ pluginId: null, href: SETTINGS_FALLBACK }));
  const config = await e.config(companyId).catch(() => null);
  const inSettings = { href: settings.href, hrefLabel: "Open settings" };
  const items: SetupItem[] = [];

  const first = settingsItem({
    saved: Boolean(config?.saved),
    pluginId: settings.pluginId ?? "",
    title: "Save the Payroll settings",
    agentNext: "Once saved, the plugin can make payslips, post locked runs to Accounting and link the Payroll Clerk for this company.",
  });
  items.push(settings.pluginId ? first : { ...first, href: settings.href, steps: first.steps ? ["Open Settings → Plugins → Payroll.", ...first.steps.slice(1)] : undefined });

  items.push(
    await probe(e, { key: "employer", title: "Employer details and SARS reference numbers", required: true, ...inSettings }, async () => {
      if (!config) throw new Error("settings unavailable");
      const er = config.employer;
      const clean = (v: string) => v.replace(/\s+/g, "");
      const problems: string[] = [];
      if (!er.legalName) problems.push("legal name");
      if (!er.address) problems.push("address (shown on payslips)");
      if (!er.payeReference) problems.push("PAYE reference number");
      else if (!/^7\d{9}$/.test(clean(er.payeReference))) problems.push("PAYE reference number (10 digits starting with 7)");
      if (!er.uifReference) problems.push("UIF reference number");
      else if (!/^U/i.test(clean(er.uifReference))) problems.push("UIF reference number (starts with U)");
      if (config.sdlMode === "registered" && !er.sdlReference) problems.push("SDL reference number (SDL is set to registered)");
      else if (er.sdlReference && !/^L/i.test(clean(er.sdlReference))) problems.push("SDL reference number (starts with L)");
      return {
        status: done(true, problems.length > 0),
        detail: problems.length
          ? `Missing or not in the expected format: ${problems.join(", ")}. Payslips, the EMP201 and IRP5 certificates need them.`
          : "Payslips, the EMP201 and IRP5 certificates use these details.",
        steps: problems.length
          ? [
              "Find the numbers on your SARS eFiling profile or the EMP201 return (PAYE starts with 7, UIF with U, SDL with L).",
              "Open the Payroll settings and fill in the Employer section.",
              "Leave the SDL number empty only if the company is exempt, and set Skills development levy to match.",
              "Click Save Configuration.",
            ]
          : undefined,
        agentNext: "Payslips and SARS packs show the employer details and reference numbers.",
      };
    }),
  );

  items.push(
    await probe(e, { key: "encryption_key", title: "Set the encryption key", required: true, ...inSettings }, async () => {
      if (!config) throw new Error("settings unavailable");
      const ok = config.encryptionKeyConfigured;
      return {
        status: done(true, !ok),
        detail: ok
          ? "ID numbers, tax numbers and bank details are sealed with this key."
          : "ID numbers, tax numbers and bank details are sealed with this key. Without it they cannot be entered, and without the same key they cannot be read again.",
        steps: ok
          ? undefined
          : [
              "Make a long random key (at least 16 characters, e.g. from a password manager).",
              "Keep a copy somewhere safe: sealed details cannot be read without it.",
              "In the Payroll settings, add it under Encryption key (it is stored as a Paperclip secret).",
              "Click Save Configuration.",
            ],
        agentNext: "Employees' ID, tax and bank details can be entered and are stored sealed.",
      };
    }),
  );

  items.push(
    await probe(e, { key: "private_storage", title: "Private storage for payslips (Cloudflare R2)", required: true, ...inSettings }, async () => {
      if (!config) throw new Error("settings unavailable");
      const ok = config.r2Configured;
      return {
        status: done(true, !ok),
        detail: ok
          ? "Payslips, bank files and SARS exports are stored in the private bucket."
          : "Payslips, bank files and SARS exports hold personal and pay details, so they go to a private bucket, never the public media bucket.",
        steps: ok
          ? undefined
          : [
              "In Cloudflare, open R2 and create a new bucket for payroll documents.",
              "Keep it private: do not turn on a public r2.dev URL or a custom domain.",
              "Under the bucket's CORS policy, allow PUT (and GET) from your Paperclip address.",
              "Create an R2 API token with Object Read & Write for this bucket only.",
              "In the Payroll settings, fill in the R2 section: account ID, bucket, access key ID and secret access key.",
              "Click Save Configuration.",
            ],
        agentNext: "Payslips are made when a run is locked, and the Mailbox gets 7-day download links to attach.",
      };
    }),
  );

  items.push(
    await probe(e, { key: "approver", title: "Choose a default approver", required: true, ...inSettings }, async () => {
      if (!config) throw new Error("settings unavailable");
      const approver = config.defaultApproverUserId;
      const rule =
        "Every pay run is approved by a board member who did not prepare it. The person (or agent) that calculates a run cannot approve it, and the approver gets an approval issue before the run can be locked.";
      if (!approver) {
        return {
          status: "missing",
          detail: `No default approver is set. ${rule}`,
          steps: [
            "Pick a board member who does not prepare the pay runs (for example the owner or finance lead).",
            "Copy their user ID from Company settings → Members.",
            "In the Payroll settings, paste it under Approval → Default approver.",
            "Click Save Configuration.",
          ],
          agentNext: "Runs sent for approval go to this person automatically.",
        };
      }
      const runs = await db.listRuns(ctx, companyId, 60);
      const prepared = runs.filter((r) => r.preparedByUserId && r.preparedByUserId === approver).length;
      if (prepared > 0) {
        return {
          status: "missing",
          detail: `The default approver also prepared ${prepared} recent pay run${prepared === 1 ? "" : "s"}, and cannot approve those. ${rule}`,
          steps: [
            "Choose a default approver who does not prepare runs, or let someone else (or the Payroll Clerk) prepare them.",
            "Update Approval → Default approver in the Payroll settings and click Save Configuration.",
          ],
          agentNext: "Runs sent for approval go to someone who did not prepare them.",
        };
      }
      const list = await members(e, companyId, null);
      if (list.length && approver !== LOCAL_BOARD_USER_ID && !list.some((m) => m.userId === approver)) {
        return {
          status: "missing",
          detail: `The default approver is not an active member of this company. ${rule}`,
          steps: ["Copy the user ID of an active board member from Company settings → Members.", "Update Approval → Default approver in the Payroll settings and click Save Configuration."],
          agentNext: "Runs sent for approval go to this person automatically.",
        };
      }
      return { status: "done", detail: rule, agentNext: "Runs sent for approval go to the default approver." };
    }),
  );

  const keyReady = Boolean(config?.encryptionKeyConfigured);
  items.push(
    await probe(e, { key: "employees", title: "Add employees with ID, tax and bank details", required: true, href: "/payroll?tab=employees", hrefLabel: "Open employees" }, async () => {
      const active = await db.listEmployees(ctx, companyId, { status: "active" });
      const complete = active.filter((x) => x.hasIdentity && x.hasTax && x.hasBank).length;
      const steps = [
        "Open Payroll → Employees and click Add employee.",
        "Fill in the name, start date and ID or passport number, tax reference number and bank details.",
        "Add the employment terms (salary or hourly rate and pay frequency).",
      ];
      if (complete > 0) {
        const partial = active.length - complete;
        return {
          status: "done",
          detail: `${complete} of ${active.length} active employee${active.length === 1 ? " has" : "s have"} sealed ID, tax and bank details.${partial ? ` ${partial} still need some of them.` : ""}`,
          agentNext: "The Payroll Clerk can prepare pay runs for these employees.",
        };
      }
      return {
        status: keyReady ? "missing" : "blocked",
        detail: keyReady
          ? active.length
            ? `None of the ${active.length} active employee${active.length === 1 ? " has" : "s have"} all of ID, tax and bank details yet. Pay runs, IRP5s and the net pay file need them.`
            : "No employees yet. Pay runs, IRP5s and the net pay file need their ID, tax and bank details."
          : "Set the encryption key first: ID, tax and bank details are sealed with it.",
        steps,
        blockedBy: keyReady ? undefined : ["encryption_key"],
        agentNext: "The Payroll Clerk can prepare pay runs for these employees.",
      };
    }),
  );

  let version: RuleVersion | null = null;
  items.push(
    await probe(e, { key: "tax_rules", title: "Payroll rules for this tax year", required: true, href: "/payroll?tab=statutory", hrefLabel: "Open rules" }, async () => {
      version = ruleVersionFor(await db.listRuleVersions(ctx), date);
      return version
        ? { status: "done", detail: `The ${version.taxYear} PAYE, UIF, SDL and ETI rules are loaded.` }
        : {
            status: "missing",
            detail: `No payroll rules are loaded for ${taxYearOf(date)}, so pay runs cannot be calculated. Update the Payroll plugin to a version with this year's rules.`,
            steps: ["Ask your Paperclip admin to update the Payroll plugin to the latest version."],
          };
    }),
  );

  items.push(
    await probe(e, { key: "rules_review", title: "Have an accountant check the unconfirmed rules", required: false, href: "/payroll?tab=statutory", hrefLabel: "Open rules" }, async () => {
      const v = version ?? ruleVersionFor(await db.listRuleVersions(ctx), date);
      if (!v) return { status: "blocked", detail: "No payroll rules are loaded for this tax year.", blockedBy: ["tax_rules"] };
      if (!v.unverified.length) return { status: "done", detail: `Every ${v.taxYear} rule is confirmed.` };
      const names = v.unverified.map((u) => u.path).join(", ");
      const reviewed = reviewCovers(await readRulesReview(ctx, companyId), v);
      return {
        status: reviewed ? "done" : "optional",
        detail: reviewed
          ? `Marked as checked for ${v.taxYear}: ${names}.`
          : `${v.unverified.length} ${v.taxYear} treatment${v.unverified.length === 1 ? " is" : "s are"} not confirmed by SARS yet: ${names}. The figures use them until an accountant says otherwise.`,
        steps: reviewed
          ? undefined
          : [
              "Open Payroll → Statutory and read the notes on the unconfirmed rules.",
              "Ask your accountant to check each one against how your company pays staff.",
              "Once they agree, mark them as checked here.",
            ],
        action: reviewed ? null : { plugin: PLUGIN_ID, key: "payroll.review-rules", label: "Mark as checked" },
      };
    }),
  );

  items.push(
    await probe(e, { key: "mailbox", title: "Connect the Mailbox to email payslips", required: false, href: "/mailbox", hrefLabel: "Open Mailbox" }, async () => {
      const mailboxOn = await isModuleEnabled(ctx, companyId, PIB_PLUGINS.mailbox);
      const slips = await db.listPayslips(ctx, companyId);
      const sent = slips.some((p) => p.status === "sent");
      if (sent) return { status: "done", detail: "Payslips are emailed through the Mailbox." };
      const failed = slips.some((p) => p.status === "failed" && p.mailKey);
      return {
        status: "optional",
        detail: !mailboxOn
          ? "The Mailbox module is switched off, so payslips can be downloaded but not emailed."
          : failed
            ? "A payslip email failed. Check that a Gmail account is connected in the Mailbox."
            : "Payslips are emailed through the Mailbox's Gmail account. Without it you can still download them.",
        steps: [
          "Open the Mailbox and connect the Gmail account payslips should come from.",
          "Optionally set Payslip email → Send from in the Payroll settings, and turn on emailing when a run is locked.",
        ],
        agentNext: "Payslips are emailed to employees once a run is locked (or when you click Email payslips).",
      };
    }),
  );

  items.push(
    await probe(e, { key: "clerk", title: "Hire the Payroll Clerk (optional agent)", required: false, href: "/payroll", hrefLabel: "Open Payroll" }, async () => {
      const status = await hireStatus(ctx, companyId, CLERK_ROLE);
      if (status.agent) return { status: "done", detail: "The Payroll Clerk prepares pay runs and checks variances. A board member still approves and locks." };
      const open = status.hire?.status === "open";
      return {
        status: "optional",
        detail: open
          ? "A hire request is open. The plugin links the agent when it appears."
          : "An agent can prepare each month's run, enter hours and bonuses, and explain changes against last month. It never approves runs or sees personal details.",
        action: open ? null : { plugin: PLUGIN_ID, key: "payroll.start-hire", label: "Open a hire request" },
        agentNext: "The Payroll Clerk prepares each run and sends it to the approver.",
      };
    }),
  );

  return {
    plugin: PLUGIN_ID,
    module: "payroll",
    title: "Payroll",
    version: manifest.version,
    items,
    checkedAt: e.now().toISOString(),
  };
}
