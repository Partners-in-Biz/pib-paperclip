/**
 * Setup checklist lines for the client care features: the monthly report, website monitoring and the
 * data-processing register. Optional lines (they never block Finish setup), each with what the agent does
 * once the person has done their part.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { SetupItem } from "@partnersinbiz/pib-plugin-kit";
import { customerClients } from "./care-clients.js";
import { previousPeriod, periodLabel } from "./report-render.js";
import { reportsOfPeriod } from "./care-store.js";
import { table } from "./db.js";
import { esignSetupItem } from "./esign.js";
import { dateLabel } from "./esign-render.js";
import { eventInstallSteps, eventUrls } from "./events-embed.js";
import { urlsFor } from "./lead-capture.js";
import { listEventKeys } from "./site-events-store.js";
import { crmLink } from "./refs.js";
import { REGISTER, ruleOf } from "./register.js";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface CareSetupFacts {
  /** The Account Manager is linked. */
  amLinked: boolean;
  /** The Mailbox module is on for the company. */
  mailboxOn: boolean;
}

export async function careSetupItems(ctx: PluginContext, companyId: string, facts: CareSetupFacts, now = new Date()): Promise<SetupItem[]> {
  const items: SetupItem[] = [];

  // Monthly client reports.
  const customers = (await customerClients(ctx, companyId).catch(() => [])).filter((info) => !info.canary);
  const period = previousPeriod(now);
  const reports = await reportsOfPeriod(ctx, companyId, period).catch(() => []);
  const sent = reports.filter((r) => r.status === "sent" || r.status === "dry_run" || r.status === "skipped").length;
  const waitingOn = !facts.amLinked ? "agent" : !facts.mailboxOn ? "mailbox" : null;
  items.push({
    key: "client-reports",
    title: "Monthly client reports",
    status: customers.length === 0 ? "optional" : waitingOn ? (waitingOn === "mailbox" ? "blocked" : "missing") : "done",
    required: false,
    detail: customers.length === 0
      ? "No customers yet. When a deal is won the client gets a report on the 1st of every month."
      : waitingOn === "agent"
        ? `${plural(customers.length, "customer")} would get a report on the 1st at 06:00, but nobody writes it: hire the Account Manager in Setup → Team.`
        : waitingOn === "mailbox"
          ? "The report goes to the client by email through the Mailbox (a person approves each one). Turn the Mailbox on and connect Gmail."
          : `${plural(customers.length, "customer")} get a report on the 1st at 06:00. ${periodLabel(period)}: ${reports.length} opened, ${sent} sent or skipped.`,
    href: "/crm",
    hrefLabel: "Open CRM",
    steps: waitingOn === "agent" ? ["Open Setup → Team → Account Manager.", "Hire one or pick an agent you already have."] : waitingOn === "mailbox" ? ["Open Setup and switch the Mailbox on.", "Connect Gmail in the Mailbox."] : undefined,
    blockedBy: waitingOn === "mailbox" ? ["mailbox"] : waitingOn === "agent" ? ["agent"] : undefined,
    agentNext: "On the 1st the CRM gathers each customer's numbers and opens a report issue; the Account Manager records any missing module numbers, writes the summary and sends it for your approval. You approve each email with one click.",
  });

  // Website monitoring.
  const sites = await ctx.db.query<{ id: string }>(`SELECT id FROM ${table(ctx, "client_sites")} WHERE company_id = $1 LIMIT 500`, [companyId]).catch(() => []);
  const monitors = await ctx.db.query<{ site_id: string; status: string; enabled: boolean; domain_expires_at: unknown; domain_error: string | null; domain_manual: boolean }>(`SELECT site_id, status, enabled, domain_expires_at, domain_error, domain_manual FROM ${table(ctx, "site_monitor")} WHERE company_id = $1 LIMIT 1000`, [companyId]).catch(() => []);
  const down = monitors.filter((m) => m.status === "down" && m.enabled !== false).length;
  // A domain whose lookup was tried and gave no date (the public registry has no data for .co.za): nobody is warned before it lapses until its date is set by hand.
  const noDomainDate = monitors.filter((m) => m.enabled !== false && !m.domain_expires_at && m.domain_error && m.domain_manual !== true).length;
  items.push({
    key: "site-monitoring",
    title: "Client website monitoring",
    status: sites.length === 0 ? "optional" : "done",
    required: false,
    detail: sites.length === 0
      ? "No client websites are registered yet. Add each client's site on its CRM page (Websites) and it is watched from then on."
      : `${plural(sites.length, "client website")} watched: a page check every 5 minutes, the certificate twice a day, the domain once a day where the public registry knows it.${down ? ` ${plural(down, "site")} down now.` : ""}${noDomainDate ? ` ${plural(noDomainDate, "site")} ${noDomainDate === 1 ? "has" : "have"} no domain expiry date: the registry lookup has no data for some endings (.co.za is one), so nobody is warned before that domain lapses until its renewal date is set from the registrar with set-site-monitoring.` : ""}`,
    steps: noDomainDate ? ["Ask the agent which sites have no domain date (tool site-monitoring on each client).", "Read each renewal date from the domain's registrar (or the invoice) and have the agent set it with set-site-monitoring (domainExpiresAt)."] : undefined,
    href: "/crm",
    hrefLabel: "Open CRM",
    agentNext: "A site down for 5 minutes, a certificate under 14 days or a domain under 30 days opens an issue for the Delivery Lead in the client's project.",
  });

  // Data-processing register.
  const unverified = REGISTER.rows.filter((row) => /^unverified/i.test(row.agreement));
  const notCleared = REGISTER.rows.filter((row) => ruleOf(row) !== "cleared").length;
  items.push({
    key: "data-processing",
    title: "Data-processing register",
    status: unverified.length === 0 ? "done" : "optional",
    required: false,
    detail: unverified.length === 0
      ? `Every one of the ${REGISTER.rows.length} systems that hold personal data has its agreement on file.`
      : `${unverified.length} of ${REGISTER.rows.length} systems that hold personal data have no confirmed agreement (${unverified.slice(0, 3).map((row) => row.name).join(", ")}${unverified.length > 3 ? ", ..." : ""}). A client flagged sensitive stays off the ${notCleared} that are not cleared.`,
    href: "/crm",
    hrefLabel: "Open CRM",
    steps: unverified.length === 0 ? undefined : [
      "Ask the agent for the list (tool list-data-processing): each unverified system has the one thing to check, in its owner-action column.",
      "For each, accept or find the data-processing agreement in that provider's console (Hetzner, Anthropic, Google, Cloudflare, GitHub, Vercel), and keep a copy.",
      "Tell the Operator which are done; a Developer updates docs/data-processing-register.md in the CRM plugin and ships it.",
    ],
    agentNext: "The register marks each system cleared, conditional or not cleared for a client flagged sensitive, and the Cockpit and routing read that. Once an agreement is on file the system can be cleared.",
  });
  // E-sign acceptance: an owner decision per client.
  items.push(await esignSetupItem(ctx, companyId));
  // Site visit counters: one line per key that is not the canary's, done once it has counted something.
  items.push(...(await eventKeyItems(ctx, companyId).catch(() => [])));
  return items;
}

/**
 * One line per site visit counter ("Count visits on acme.co.za"): done once the script has counted something. Putting the script on a
 * client's site is a change to that site, so the steps say it needs the owner's OK and goes through the client's repo project.
 */
export async function eventKeyItems(ctx: PluginContext, companyId: string): Promise<SetupItem[]> {
  const keys = (await listEventKeys(ctx, companyId)).filter((key) => key.status === "active" && !key.canary);
  if (keys.length === 0) return [];
  const base = await urlsFor(ctx, companyId).catch(() => null);
  const urls = base ? eventUrls(base) : null;
  return keys.map((key) => {
    const counting = key.acceptedCount > 0;
    const site = key.siteUrl ? key.siteUrl.replace(/^https?:\/\//, "") : null;
    return {
      key: `site-events:${key.id}`,
      title: site ? `Count visits on ${site}` : `Count visits: ${key.label}`,
      status: counting ? "done" : "missing",
      required: false,
      detail: counting
        ? `Counting: ${key.acceptedCount} events so far${key.lastEventAt ? `, the last on ${dateLabel(key.lastEventAt)}` : ""}.`
        : "Nothing counted yet: the script is not on the site. Putting it there changes the client's site, so it needs the owner's OK and goes through the client's repo project.",
      href: key.clientKind && key.clientRef ? crmLink(null, key.clientKind, key.clientRef) : "/crm",
      hrefLabel: key.clientKind ? "Open the client page" : "Open CRM",
      steps: counting ? undefined : urls ? eventInstallSteps(key, urls, key.siteUrl) : ["Open the CRM page once (CRM in the sidebar) so the plugin learns its public address, then ask the agent for the snippet with list-event-keys."],
      agentNext: "Once the first events arrive, the monthly client report shows visits, conversions and where they came from, and attribution-report credits enquiries and revenue to channels.",
    } satisfies SetupItem;
  });
}
