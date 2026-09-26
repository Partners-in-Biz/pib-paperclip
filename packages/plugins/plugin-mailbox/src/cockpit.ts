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
  publishCockpitSnapshot,
  type ActivityItem,
  type CockpitKpi,
  type CockpitSnapshot,
  type HealthCheck,
  type QualityMetric,
  type Tone,
} from "@partnersinbiz/pib-plugin-kit";
import { loadMailboxConfig } from "./config.js";
import { SETUP_STATUS_JOB_KEY, SYNC_JOB_KEY } from "./constants.js";
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
         FROM ${t(ctx, "accounts")} WHERE company_id = $1 AND status IN ('connected', 'needs_reconnect') ORDER BY created_at`,
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
  snap.health.push(await jobHealth(ctx, SYNC_JOB_KEY, "Gmail sync", 2));
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
