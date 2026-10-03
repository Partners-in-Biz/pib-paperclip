/**
 * Pure helpers for the client care card (no React, no host): how a case, a request, a
 * report, a website and the health score read in a line. Tested without a browser.
 */

export type CareTone = "ok" | "warn" | "bad" | "info" | "neutral";

export interface CareSla {
  firstResponse: "met" | "ok" | "at_risk" | "breached" | "paused";
  resolution: "met" | "ok" | "at_risk" | "breached" | "paused";
}

export interface CareCaseView {
  caseId: string;
  title: string;
  severity: "low" | "normal" | "high" | "urgent";
  status: "new" | "open" | "waiting_client" | "resolved" | "closed";
  source: string;
  firstResponseDueAt: string;
  resolutionDueAt: string;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  sla: CareSla;
  issueId: string | null;
}

export interface CareActionView {
  actionId: string;
  kind: "sign_off" | "grant" | "approval" | "info";
  title: string;
  status: "draft" | "waiting" | "replied" | "done" | "cancelled";
  to: string | null;
  link: string | null;
  requestedAt: string | null;
  waitingDays: number | null;
  reminders: number;
  nextReminderAt: string | null;
  dueAt: string | null;
  escalated: boolean;
  answer: string | null;
}

export interface CareReportView {
  reportId: string;
  period: string;
  periodLabel: string;
  status: "built" | "awaiting_approval" | "sent" | "dry_run" | "skipped";
  narrativeWritten: boolean;
  builtAt: string | null;
  sentAt: string | null;
  issueId: string | null;
}

export interface CareSiteView {
  siteId: string;
  url: string;
  monitored: boolean;
  status: "unknown" | "up" | "down";
  downMinutes: number;
  lastCheckedAt: string | null;
  certificate: { expiresAt: string | null; daysLeft: number | null; problem: string | null };
  domain: { name: string | null; expiresAt: string | null; daysLeft: number | null; manual: boolean; problem: string | null };
}

export interface CareHealthView {
  score: number;
  band: "healthy" | "watch" | "at_risk";
  parts: Array<{ part: string; score: number; why: string }>;
  notMeasured: string[];
  computedAt: string | null;
  previousScore: number | null;
  customer: boolean;
}

export interface CareView {
  customer: boolean;
  health: CareHealthView | null;
  cases: CareCaseView[];
  actions: CareActionView[];
  reports: CareReportView[];
  sites: CareSiteView[];
  feedback: { items: Array<{ feedbackId: string; kind: "nps" | "csat"; status: string; score: number | null }>; nps: { nps: number; answers: number; promoters: number; passives: number; detractors: number } | null };
  sensitivity: { level: "standard" | "sensitive"; reason: string | null; keepOffSystems: string[] };
  /** The consent and basis on file for the client's people. */
  consent: CareConsentView[];
}

export interface CareConsentView {
  person: string;
  purpose: string;
  basis: string;
  granted: boolean;
  source: string;
  recordedAt: string;
  expiresAt: string | null;
}

const PURPOSE_LABEL: Record<string, string> = { marketing_email: "marketing email", marketing_sms: "marketing SMS", newsletter: "newsletter", profiling: "profiling", service_messages: "service messages" };
const BASIS_LABEL: Record<string, string> = { consent: "consent", contract: "contract", legitimate_interest: "legitimate interest", legal_obligation: "legal obligation" };

/** "Ada: marketing email, consent (website form), 3 Oct 2026" / "...withdrawn". */
export function consentLine(c: CareConsentView): string {
  const day = c.recordedAt.slice(0, 10);
  const expired = c.expiresAt && Date.parse(c.expiresAt) < Date.now() ? ", expired" : "";
  return `${c.person}: ${PURPOSE_LABEL[c.purpose] ?? c.purpose}, ${c.granted ? BASIS_LABEL[c.basis] ?? c.basis : "withdrawn"} (${c.source.replace("_", " ")}), ${day}${expired}`;
}

export const SEVERITY_LABEL: Record<CareCaseView["severity"], string> = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };
export const CASE_STATUS_LABEL: Record<CareCaseView["status"], string> = { new: "New", open: "Open", waiting_client: "Waiting on the client", resolved: "Resolved", closed: "Closed" };
export const ACTION_STATUS_LABEL: Record<CareActionView["status"], string> = { draft: "Waiting for approval", waiting: "Waiting on the client", replied: "The client replied", done: "Done", cancelled: "Cancelled" };
export const ACTION_KIND_LABEL: Record<CareActionView["kind"], string> = { sign_off: "Sign-off", grant: "Access", approval: "Approval", info: "Information" };
export const REPORT_STATUS_LABEL: Record<CareReportView["status"], string> = { built: "Being written", awaiting_approval: "Waiting for approval", sent: "Sent", dry_run: "Dry run (canary)", skipped: "Skipped" };
export const BAND_LABEL: Record<CareHealthView["band"], string> = { healthy: "Healthy", watch: "Watch", at_risk: "At risk" };

export const caseOpen = (c: Pick<CareCaseView, "status">) => c.status !== "resolved" && c.status !== "closed";

export function severityTone(severity: CareCaseView["severity"]): CareTone {
  return severity === "urgent" ? "bad" : severity === "high" ? "warn" : "neutral";
}

export function bandTone(band: CareHealthView["band"]): CareTone {
  return band === "healthy" ? "ok" : band === "watch" ? "warn" : "bad";
}

export function reportTone(status: CareReportView["status"]): CareTone {
  return status === "sent" ? "ok" : status === "awaiting_approval" ? "info" : status === "built" ? "warn" : "neutral";
}

export function actionTone(action: Pick<CareActionView, "status" | "escalated">): CareTone {
  if (action.escalated) return "bad";
  return action.status === "done" ? "ok" : action.status === "replied" ? "warn" : action.status === "cancelled" ? "neutral" : "info";
}

/** "in 3 h" / "2 h ago" / "in 2 days": how far an ISO time is from `now`. */
export function relativeHours(iso: string | null, now: number): string | null {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  const hours = Math.round(Math.abs(at - now) / 3_600_000);
  const text = hours < 1 ? "under an hour" : hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
  return at >= now ? `in ${text}` : `${text} ago`;
}

/** What a case's targets say, in one line: the one that matters now. */
export function slaLine(c: CareCaseView, now: number): { text: string; tone: CareTone } {
  if (!caseOpen(c)) return { text: c.resolvedAt ? "Resolved" : CASE_STATUS_LABEL[c.status], tone: "ok" };
  if (c.sla.firstResponse === "breached") return { text: `First response overdue (was due ${relativeHours(c.firstResponseDueAt, now)})`, tone: "bad" };
  if (c.sla.resolution === "breached") return { text: `Resolution overdue (was due ${relativeHours(c.resolutionDueAt, now)})`, tone: "bad" };
  if (c.sla.firstResponse === "at_risk") return { text: `First response due ${relativeHours(c.firstResponseDueAt, now)}`, tone: "warn" };
  if (c.sla.resolution === "at_risk") return { text: `Resolution due ${relativeHours(c.resolutionDueAt, now)}`, tone: "warn" };
  if (c.sla.firstResponse !== "met") return { text: `First response due ${relativeHours(c.firstResponseDueAt, now)}`, tone: "neutral" };
  if (c.sla.resolution === "paused") return { text: "Clock paused while the client owes us something", tone: "info" };
  return { text: `Resolution due ${relativeHours(c.resolutionDueAt, now)}`, tone: "neutral" };
}

/** The facts under a client request, in one line. */
export function actionLine(a: CareActionView, now: number): string {
  const parts: string[] = [];
  if (a.status === "waiting" || a.status === "replied") {
    if (a.waitingDays !== null) parts.push(`asked ${a.waitingDays === 0 ? "today" : `${a.waitingDays} day${a.waitingDays === 1 ? "" : "s"} ago`}`);
    parts.push(`${a.reminders} reminder${a.reminders === 1 ? "" : "s"}`);
    if (a.status === "waiting" && a.nextReminderAt) parts.push(`next reminder ${relativeHours(a.nextReminderAt, now)}`);
    if (a.escalated) parts.push("the Account Manager is reaching them another way");
  }
  if (a.dueAt && a.status !== "done" && a.status !== "cancelled") parts.push(`wanted ${relativeHours(a.dueAt, now)}`);
  if (a.answer) parts.push(`answer: ${a.answer}`);
  if (a.to) parts.push(`to ${a.to}`);
  return parts.join(" · ");
}

/** A website in one line: up or down, the last check, the certificate and the domain. */
export function siteLine(s: CareSiteView, now: number): { text: string; tone: CareTone } {
  if (!s.monitored) return { text: "Monitoring paused", tone: "neutral" };
  if (s.status === "unknown") return { text: "Not checked yet", tone: "neutral" };
  const parts: string[] = [s.status === "down" ? `Down for ${s.downMinutes} min` : "Up"];
  const last = relativeHours(s.lastCheckedAt, now);
  if (last) parts.push(`checked ${last.replace(/^in /, "")}`);
  if (s.certificate.problem && s.certificate.daysLeft === null) parts.push(s.certificate.problem);
  else if (s.certificate.daysLeft !== null) parts.push(s.certificate.daysLeft < 0 ? "certificate expired" : `certificate ${s.certificate.daysLeft} days left`);
  if (s.domain.daysLeft !== null) parts.push(s.domain.daysLeft < 0 ? "domain expired" : `domain ${s.domain.daysLeft} days left`);
  else if (s.domain.problem) parts.push("domain expiry unknown");
  const cert = s.certificate.daysLeft;
  const dom = s.domain.daysLeft;
  const bad = s.status === "down" || (cert !== null && cert < 3) || (dom !== null && dom < 7);
  const warn = (cert !== null && cert < 14) || (dom !== null && dom < 30);
  return { text: parts.join(" · "), tone: bad ? "bad" : warn ? "warn" : "ok" };
}

/** A report row's label, e.g. "September 2026: Waiting for approval". */
export function reportLine(r: CareReportView): string {
  return `${r.periodLabel}: ${REPORT_STATUS_LABEL[r.status]}${r.status === "built" && !r.narrativeWritten ? " (summary not written)" : ""}`;
}

/** Whether the "send for approval" button makes sense for a report. */
export function canSendReport(r: CareReportView): boolean {
  return r.status === "built" && r.narrativeWritten;
}

/** Last month as YYYY-MM in South African time, for the "Build last month's report" button. */
export function lastMonth(now: Date): string {
  const sast = new Date(now.getTime() + 2 * 3_600_000);
  const month = sast.getUTCMonth();
  return month === 0 ? `${sast.getUTCFullYear() - 1}-12` : `${sast.getUTCFullYear()}-${String(month).padStart(2, "0")}`;
}

/** Whether the care card has anything to show or do for this client. */
export function careVisible(care: CareView | null | undefined): boolean {
  if (!care) return false;
  return care.customer || care.cases.length > 0 || care.actions.length > 0 || care.reports.length > 0 || care.sites.length > 0 || care.sensitivity.level === "sensitive";
}
