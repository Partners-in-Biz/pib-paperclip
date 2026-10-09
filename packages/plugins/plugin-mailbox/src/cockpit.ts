/**
 * Mailbox snapshot for the Company Cockpit (`GET /cockpit` and the hourly
 * `cockpit.snapshot` event). Read-only and cheap: a few SELECTs on our own
 * tables, no Gmail calls. Each part is wrapped so one failing query never
 * breaks the whole snapshot.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  decisionStats,
  emptySnapshot,
  isModuleEnabled,
  jobHealth,
  outboxHealth,
  publishCockpitSnapshot,
  type ActivityItem,
  type CockpitKpi,
  type CockpitSnapshot,
  type HealthCheck,
  type QualityMetric,
  type Tone,
} from "@partnersinbiz/pib-plugin-kit";
import { espReadiness, loadMailboxConfig } from "./config.js";
import { DOMAIN_JOB_KEY, SETUP_STATUS_JOB_KEY, SYNC_JOB_KEY } from "./constants.js";
import { SqlStore } from "./db.js";
import { domainHealthChecks } from "./domain-health.js";
import { readEspState } from "./esp/runtime.js";
import { dailyCap, utcDay } from "./esp/warmup.js";
import type { DomainCheckRow } from "./gmail/types.js";
import { TRIAGE_PURPOSE } from "./gmail/triage.js";
import { PLUGIN_ID } from "./namespace.js";
import { knownCompanies } from "./setup-status.js";

/** A connected account with no sync for longer than this is bad on the Cockpit. */
export const COCKPIT_SYNC_STALE_MS = 30 * 60_000;
const HREF = "/mailbox";

function t(ctx: PluginContext, name: string): string {
  const ns = ctx.db.namespace;
  if (!/^plugin_[a-z0-9_]+$/.test(ns) || !/^[a-z_]+$/.test(name)) throw new Error("Unsafe identifier");
  return `${ns}.${name}`;
}

async function part<T>(ctx: PluginContext, label: string, run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    ctx.logger.info("Mailbox cockpit part failed", { part: label, error: error instanceof Error ? error.message : String(error) });
    return fallback;
  }
}

const n = (value: unknown) => {
  const num = Number(value ?? 0);
  return Number.isFinite(num) ? num : 0;
};
const iso = (value: unknown): string | null => (value == null ? null : value instanceof Date ? value.toISOString() : String(value));

/** `partnersinbiz.billing` → `Billing`. */
export function pluginLabel(pluginId: string | null | undefined): string {
  const last = (pluginId ?? "").split(".").pop() ?? "";
  return last ? last.charAt(0).toUpperCase() + last.slice(1).replace(/-/g, " ") : "a plugin";
}

interface Counts {
  needs_reply: string;
  sent_today: string;
  sent_7d: string;
  failed_7d: string;
  failed_24h: string;
  retrying_stuck: string;
  oldest_failed: string | null;
  triaged_24h: string;
  last_triaged_at: string | null;
}

export interface AccountHealthRow {
  id: string;
  address: string;
  status: string;
  last_sync_at: string | null;
  last_error: string | null;
  alert_issue_id: string | null;
  connected_at: string | null;
  updated_at: string | null;
}

export async function cockpitSnapshot(ctx: PluginContext, companyId: string, now = Date.now()): Promise<CockpitSnapshot> {
  const snap = emptySnapshot(PLUGIN_ID, "Mailbox");
  snap.checkedAt = new Date(now).toISOString();

  const counts = await part(ctx, "counts", async () => {
    const rows = await ctx.db.query<Counts>(
      `SELECT
         (SELECT count(*) FROM ${t(ctx, "messages")} WHERE company_id = $1 AND direction = 'inbound' AND read_at IS NULL AND needs_reply >= 0.7 AND bulk = false AND COALESCE(category, '') <> 'spam')::text AS needs_reply,
         (SELECT count(*) FROM ${t(ctx, "send_requests")} WHERE company_id = $1 AND status = 'sent' AND sent_at >= date_trunc('day', now()))::text AS sent_today,
         (SELECT count(*) FROM ${t(ctx, "send_requests")} WHERE company_id = $1 AND status = 'sent' AND sent_at >= now() - interval '7 days')::text AS sent_7d,
         (SELECT count(*) FROM ${t(ctx, "send_requests")} WHERE company_id = $1 AND status = 'failed' AND updated_at >= now() - interval '7 days')::text AS failed_7d,
         (SELECT count(*) FROM ${t(ctx, "send_requests")} WHERE company_id = $1 AND status = 'failed' AND updated_at >= now() - interval '1 day')::text AS failed_24h,
         (SELECT count(*) FROM ${t(ctx, "send_requests")} WHERE company_id = $1 AND status = 'retrying' AND updated_at < now() - interval '1 hour')::text AS retrying_stuck,
         (SELECT min(updated_at) FROM ${t(ctx, "send_requests")} WHERE company_id = $1 AND status = 'failed' AND updated_at >= now() - interval '1 day')::text AS oldest_failed,
         (SELECT count(*) FROM ${t(ctx, "messages")} WHERE company_id = $1 AND direction = 'inbound' AND triaged_at >= now() - interval '1 day')::text AS triaged_24h,
         (SELECT max(triaged_at) FROM ${t(ctx, "messages")} WHERE company_id = $1 AND direction = 'inbound')::text AS last_triaged_at`,
      [companyId],
    );
    return rows[0] ?? null;
  }, null as Counts | null);

  if (counts) {
    const needsReply = n(counts.needs_reply);
    const sentToday = n(counts.sent_today);
    const sent7 = n(counts.sent_7d);
    const failed7 = n(counts.failed_7d);
    const kpis: CockpitKpi[] = [
      { key: "mail_needs_reply", label: "Unread needing a reply", value: String(needsReply), raw: needsReply, tone: needsReply > 0 ? "warn" : "ok", href: HREF, group: "delivery" },
      { key: "mail_sent_today", label: "Mail sent today", value: String(sentToday), raw: sentToday, tone: "neutral", delta: `${sent7} in the last 7 days`, href: HREF, group: "delivery" },
      { key: "mail_sent_7d", label: "Mail sent (7 days)", value: String(sent7), raw: sent7, tone: "neutral", href: HREF, group: "delivery" },
      { key: "mail_send_failures", label: "Send failures (7 days)", value: String(failed7), raw: failed7, tone: failed7 > 0 ? "bad" : "ok", href: HREF, group: "delivery" },
    ];
    snap.kpis.push(...kpis);
  }

  const accounts = await part(ctx, "accounts", async () => {
    return ctx.db.query<AccountHealthRow>(
      `SELECT id, address, status, last_sync_at::text AS last_sync_at, last_error, alert_issue_id, connected_at::text AS connected_at, updated_at::text AS updated_at
         FROM ${t(ctx, "accounts")} WHERE company_id = $1 AND provider = 'gmail' AND status IN ('connected', 'needs_reconnect') ORDER BY created_at`,
      [companyId],
    );
  }, null as AccountHealthRow[] | null);

  if (accounts) {
    for (const account of accounts) snap.health.push(accountHealth(account, now));
    for (const account of accounts.filter((a) => a.status === "needs_reconnect")) {
      snap.waiting.push({
        key: `mailbox:reconnect:${account.id}`,
        title: `Reconnect Gmail for ${account.address}`,
        why: "Google needs the account owner to sign in again. Mail cannot sync or send from this address until then.",
        href: HREF,
        issueId: account.alert_issue_id,
        kind: "grant",
        since: iso(account.updated_at),
      });
    }
  }

  if (counts) snap.health.push(sendQueueHealth(counts));
  snap.health.push(await leadHandoffHealth(ctx, companyId));
  // Mail authentication of each sending domain (SPF, DKIM, DMARC, MX) and client mail nobody has mapped yet.
  const store = new SqlStore(ctx.db);
  snap.health.push(...domainHealthChecks(await part(ctx, "domains", () => store.listDomainChecks(companyId), [] as DomainCheckRow[]), now));
  // The email provider (0.6.0): the key, the webhook, a domain at its daily cap. Reputation problems come with the domain's own check above.
  const esp = await part(ctx, "esp", () => espHealth(ctx, companyId, store, now), { kpis: [] as CockpitKpi[], health: [] as HealthCheck[] });
  snap.kpis.push(...esp.kpis);
  snap.health.push(...esp.health);
  const unmapped = await part(ctx, "unmapped", () => store.unmappedSummary(companyId, 30), [] as Awaited<ReturnType<SqlStore["unmappedSummary"]>>);
  const flagged = unmapped.reduce((sum, row) => sum + Number(row.n), 0);
  if (flagged > 0) {
    snap.health.push({
      key: "mailbox:client-mail-unmapped",
      title: "Client mail without a mapping",
      status: "warn",
      detail: `${flagged} message${flagged === 1 ? "" : "s"} in the last 30 days look like a client's mail (${unmapped.slice(0, 3).map((row) => row.domain).join(", ")}) but are filed as the company's own.`,
      href: HREF,
      fix: "The Account Manager maps each sender with map-client-mail (list-client-mail-maps shows them), or add a mapping on the Mailboxes tab.",
    });
  }
  snap.health.push(await jobHealth(ctx, SYNC_JOB_KEY, "Gmail sync", 2));
  snap.health.push(await jobHealth(ctx, DOMAIN_JOB_KEY, "Sender domain checks", 24 * 60));
  snap.health.push(await jobHealth(ctx, SETUP_STATUS_JOB_KEY, "Setup and cockpit report", 60));

  snap.activity = await part(ctx, "activity", () => activityItems(ctx, companyId, counts), [] as ActivityItem[]);
  snap.quality = await part(ctx, "quality", () => qualityMetrics(ctx, companyId, counts), [] as QualityMetric[]);
  return snap;
}

export function accountHealth(account: AccountHealthRow, now: number): HealthCheck {
  const key = `mailbox:sync:${account.id}`;
  const title = `Gmail sync: ${account.address}`;
  if (account.status === "needs_reconnect") {
    return {
      key,
      title,
      status: "bad",
      detail: account.last_error ? `Needs reconnecting. ${account.last_error}` : "Needs reconnecting.",
      href: HREF,
      fix: "Open the Mailbox and click Reconnect on the account, then sign in with Google.",
      since: iso(account.updated_at),
    };
  }
  const lastSync = account.last_sync_at ? Date.parse(account.last_sync_at) : Number.NaN;
  const reference = Number.isFinite(lastSync) ? lastSync : account.connected_at ? Date.parse(account.connected_at) : Number.NaN;
  if (Number.isFinite(reference) && now - reference > COCKPIT_SYNC_STALE_MS) {
    const minutes = Math.round((now - reference) / 60_000);
    return {
      key,
      title,
      status: "bad",
      detail: `${Number.isFinite(lastSync) ? `Last sync ${minutes} minutes ago.` : `No sync since it was connected ${minutes} minutes ago.`}${account.last_error ? ` Last error: ${account.last_error}` : ""}`,
      href: HREF,
      fix: "Open the Mailbox and click Sync on the account. If it keeps failing, check the Mailbox settings are saved and the sync job is on.",
      since: Number.isFinite(lastSync) ? new Date(lastSync).toISOString() : iso(account.connected_at),
    };
  }
  if (account.last_error) return { key, title, status: "warn", detail: `Last error: ${account.last_error}`, href: HREF };
  return { key, title, status: "ok" };
}

/** Leads waiting for the CRM's answer (the kit outbox): stuck over an hour is a warning, given up is bad. */
async function leadHandoffHealth(ctx: PluginContext, companyId: string): Promise<HealthCheck> {
  const check = await outboxHealth(ctx, companyId);
  return {
    ...check,
    key: "mailbox:lead-handoff",
    title: "Leads handed to the CRM",
    fix: check.status === "ok" ? check.fix ?? null : "Check the CRM plugin is installed and switched on and its settings are saved: it answers each lead. Leads are re-sent for about 3 days.",
    href: check.status === "ok" ? null : "/crm",
  };
}

function sendQueueHealth(counts: Counts): HealthCheck {
  const failed = n(counts.failed_24h);
  const stuck = n(counts.retrying_stuck);
  if (failed > 0) {
    return {
      key: "mailbox:send-queue",
      title: "Send queue",
      status: "bad",
      detail: `${failed} send${failed === 1 ? "" : "s"} failed in the last day${stuck ? `, ${stuck} retrying for over an hour` : ""}.`,
      href: HREF,
      fix: "Open the Mailbox → Sent, read the error and click Retry (reconnect Gmail first if it asks).",
      since: counts.oldest_failed,
    };
  }
  if (stuck > 0) {
    return { key: "mailbox:send-queue", title: "Send queue", status: "warn", detail: `${stuck} send${stuck === 1 ? "" : "s"} retrying for over an hour.`, href: HREF };
  }
  return { key: "mailbox:send-queue", title: "Send queue", status: "ok" };
}

async function activityItems(ctx: PluginContext, companyId: string, counts: Counts | null): Promise<ActivityItem[]> {
  const sends = await ctx.db.query<{ source_plugin: string; subject: string; sent_at: string }>(
    `SELECT source_plugin, subject, sent_at::text AS sent_at FROM ${t(ctx, "send_requests")}
      WHERE company_id = $1 AND status = 'sent' AND sent_at IS NOT NULL ORDER BY sent_at DESC LIMIT 10`,
    [companyId],
  );
  const items: ActivityItem[] = sends.map((row) => ({
    at: row.sent_at,
    text: row.source_plugin === PLUGIN_ID ? `Sent "${row.subject}"` : `Sent "${row.subject}" for ${pluginLabel(row.source_plugin)}`,
    href: HREF,
  }));
  const triaged = n(counts?.triaged_24h);
  if (triaged > 0 && counts?.last_triaged_at) {
    items.push({ at: counts.last_triaged_at, text: `Triaged ${triaged} new message${triaged === 1 ? "" : "s"} in the last day`, href: HREF });
  }
  return items.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 10);
}

function rateTone(rate: number): Tone {
  if (rate > 0.25) return "bad";
  if (rate > 0.1) return "warn";
  return "ok";
}

async function qualityMetrics(ctx: PluginContext, companyId: string, counts: Counts | null): Promise<QualityMetric[]> {
  const out: QualityMetric[] = [];
  const stats = (await decisionStats(ctx, companyId, 30)).filter((row) => row.purpose === TRIAGE_PURPOSE);
  const category = stats.find((row) => row.question_key === "category");
  const total = n(category?.total);
  const corrected = n(category?.corrected);
  if (total > 0) {
    const rate = corrected / total;
    out.push({
      key: "triage_corrected_rate",
      label: "Mail triage corrected by people (30 days)",
      value: `${Math.round(rate * 100)}% (${corrected} of ${total})`,
      raw: Math.round(rate * 1000) / 1000,
      tone: rateTone(rate),
    });
  }
  if (counts) {
    const failed = n(counts.failed_7d);
    const sent = n(counts.sent_7d);
    out.push({
      key: "send_failures",
      label: "Send failures (7 days)",
      value: sent + failed > 0 ? `${failed} of ${sent + failed}` : "0",
      raw: failed,
      tone: failed > 0 ? "bad" : "ok",
    });
  }
  return out;
}

/** Hourly: push the snapshot for every company with saved settings and the Mailbox on. */
export async function publishAllCockpit(ctx: PluginContext): Promise<number> {
  let published = 0;
  for (const companyId of await knownCompanies(ctx)) {
    try {
      if (!(await isModuleEnabled(ctx, companyId, PLUGIN_ID))) continue;
      const loaded = await loadMailboxConfig(ctx, companyId);
      if (!loaded.config.saved) continue;
      await publishCockpitSnapshot(ctx, companyId, await cockpitSnapshot(ctx, companyId));
      published += 1;
    } catch (error) {
      ctx.logger.info("Mailbox cockpit snapshot skipped", { companyId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return published;
}

/** The email provider's key and webhook, and a domain whose daily cap is used up. Nothing here calls the provider. */
export async function espHealth(ctx: PluginContext, companyId: string, store: Pick<SqlStore, "listEspDomains" | "espDayRows">, now: number): Promise<{ kpis: CockpitKpi[]; health: HealthCheck[] }> {
  const out = { kpis: [] as CockpitKpi[], health: [] as HealthCheck[] };
  const loaded = await loadMailboxConfig(ctx, companyId);
  const config = loaded.config.esp;
  const domains = await store.listEspDomains(companyId);
  // A company that never set the provider up has nothing to report.
  if (!config.enabled && !config.hasCredentials && domains.length === 0) return out;
  const readiness = espReadiness(config);
  const state = await readEspState(ctx, companyId);
  const HREF_ESP = "/mailbox?tab=mailboxes";
  if (state && !state.ok) {
    out.health.push({
      key: "mailbox:esp",
      title: "Email provider",
      status: "bad",
      detail: state.code === "quota" ? `Resend says the sending quota is used up${state.detail ? `: ${state.detail}` : ""}. Mail through the provider waits.` : `Resend refused the Mailbox's API key${state.detail ? `: ${state.detail}` : ""}. Mail through the provider waits.`,
      href: HREF_ESP,
      fix: state.code === "quota" ? "Upgrade the Resend plan or wait for the quota to reset (daily quotas reset at midnight UTC)." : "Create a new Resend API key with Full access, save it as a Paperclip secret and pick it in the Mailbox settings, Email provider.",
      since: state.at,
    });
  } else if (domains.length > 0 && !readiness.sending) {
    out.health.push({ key: "mailbox:esp", title: "Email provider", status: "warn", detail: readiness.blockers.join(" "), href: HREF_ESP, fix: "Finish the Setup items for the email provider: nothing is sent through it until they are done." });
  } else {
    // Sends went through the provider but no delivery event has come back: the webhook is not reaching the Mailbox.
    const rows = await ctx.db.query<{ sent: string; events: string }>(
      `SELECT (SELECT count(*) FROM ${t(ctx, "send_requests")} WHERE company_id = $1 AND provider IS NOT NULL AND status = 'sent' AND sent_at >= now() - interval '3 days' AND sent_at < now() - interval '1 hour')::text AS sent,
              (SELECT count(*) FROM ${t(ctx, "esp_events")} WHERE company_id = $1 AND received_at >= now() - interval '3 days')::text AS events`,
      [companyId],
    );
    const sent = n(rows[0]?.sent);
    const events = n(rows[0]?.events);
    out.health.push(
      sent > 0 && events === 0
        ? { key: "mailbox:esp", title: "Email provider", status: "warn", detail: `${sent} message${sent === 1 ? "" : "s"} went out through the provider in the last 3 days but no delivery event has come back, so bounces and complaints are not being seen.`, href: HREF_ESP, fix: "Check the Resend webhook: its Endpoint URL, that it is enabled, and that its signing secret is the one saved in the Mailbox settings (resend.com/webhooks shows recent deliveries and their answers)." }
        : { key: "mailbox:esp", title: "Email provider", status: "ok" },
    );
  }
  const today = utcDay(now);
  let sentToday = 0;
  for (const row of domains.filter((entry) => entry.status === "verified")) {
    const days = await store.espDayRows(companyId, row.domain, today);
    const used = days.find((day) => day.day === today)?.sent ?? 0;
    sentToday += used;
    const cap = dailyCap(row, config.steadyDailyCap, now);
    if (used >= cap.cap) {
      out.health.push({
        key: `mailbox:esp-cap:${row.domain}`,
        title: `Daily send cap: ${row.domain}`,
        status: "warn",
        detail: `${used} of ${cap.cap} recipients today${cap.warming ? ` (warm-up day ${cap.day})` : ""}: marketing mail from this domain waits until tomorrow (UTC). Transactional mail is not held back.`,
        href: HREF_ESP,
        fix: cap.warming ? "This is the warm-up ramp protecting the domain's reputation: it grows every day. A person can mark a domain as already established on the Mailboxes tab." : "Raise the steady daily cap in the Mailbox settings, or give this domain its own cap on the Mailboxes tab.",
      });
    }
  }
  if (domains.length > 0) out.kpis.push({ key: "esp_sent_today", label: "Sent through the email provider today", value: String(sentToday), raw: sentToday, tone: "neutral", href: HREF_ESP, group: "delivery" });
  return out;
}
