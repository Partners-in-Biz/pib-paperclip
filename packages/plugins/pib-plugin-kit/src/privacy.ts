/**
 * Consent and erasure contract between the PiB plugins (Q10-13, POPIA).
 *
 * Contract only: no plugin UI here. The CRM, Mailbox, Campaigns and Social
 * builders implement their side with these types and helpers. What exists
 * today: suppression/opt-out, POPIA copy rules in skills, approval gates for
 * all-contacts campaigns. What did not: a record of why a person may be emailed
 * (consent or another lawful basis, source, wording, time), and any way to
 * erase or export one person across CRM, Mailbox, Campaigns and Social.
 *
 * Events (at-most-once; a plugin cannot call another plugin):
 * - `consent.recorded`: someone gave or withdrew consent, or a lawful basis was
 *   noted. The receivers upsert by `consentSubjectKey` + purpose and ignore an
 *   older `recordedAt` (use `consentIsNewer`).
 * - `contact.erase.requested`: erase one person. Irreversible, so the sender
 *   must carry `approvedByUserId` (a real person's yes, asked with a `legal`
 *   ask or an approval issue); a receiver refuses a request without it.
 * - `contact.erase.completed`: one plugin's answer (what it erased, what the law
 *   obliges it to keep). The sender keeps an `EraseLedger` and re-announces the
 *   request hourly until every participant has answered.
 *
 * Receivers use `registerEraseReceiver`: at-most-once per request (a stored
 * result is re-sent, never re-run), refused without approval, and a failure
 * stores nothing so the next announcement retries. It keeps its memo in plugin
 * state, so a receiver needs no migration (the `contact.suppressed` receivers in
 * the CRM and Mailbox use an inbox table; this pattern is the same without one).
 *
 * Legal retention is not erasure: invoices, quotes and ledger entries that tax
 * law makes the company keep are reported in `retained` by Billing and
 * Accounting, with the reason, not deleted.
 *
 * The sender's ledger holds the subject's email and phone only while a
 * participant still has to erase (they are needed to retry). When every
 * participant has answered the ledger keeps a SHA-256 of the subject key
 * (`subjectHash`) and drops the identifiers, so the log can show that an erasure
 * happened without keeping the data it erased. A participant that never answers
 * keeps the request open; `staleErasuresCheck` makes that visible.
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import type { ClientKind } from "./client-ref.js";
import { HANDOFF_EVENTS, type HealthCheck } from "./cockpit.js";
import { PIB_PLUGINS } from "./contracts.js";

/** Plugins that hold personal data about contacts and answer erasure requests. */
export const ERASURE_PARTICIPANTS: string[] = [PIB_PLUGINS.crm, PIB_PLUGINS.mailbox, PIB_PLUGINS.campaigns, PIB_PLUGINS.social, PIB_PLUGINS.billing, PIB_PLUGINS.accounting];

/** Plugins that may start an erasure (the CRM owns contacts). */
export const ERASURE_SOURCES: string[] = [PIB_PLUGINS.crm];

/** Plugins that announce consent (forms, replies and unsubscribes arrive in these). */
export const CONSENT_SOURCES: string[] = [PIB_PLUGINS.crm, PIB_PLUGINS.mailbox, PIB_PLUGINS.campaigns, PIB_PLUGINS.social];

export type ConsentPurpose = "marketing_email" | "marketing_sms" | "newsletter" | "profiling" | "service_messages";
export type LawfulBasis = "consent" | "contract" | "legitimate_interest" | "legal_obligation";
export type ConsentSource = "form" | "import" | "manual" | "reply" | "unsubscribe_link" | "api";

/** Who the record is about; at least one identifier. */
export interface PrivacySubject {
  email?: string | null;
  phone?: string | null;
  contactId?: string | null;
  clientKind?: ClientKind | null;
  clientRef?: string | null;
}

export interface ConsentRecorded {
  /** `consent:<subject key>:<purpose>:<recordedAt>` (build with `consentKey`). */
  key: string;
  subject: PrivacySubject;
  purpose: ConsentPurpose;
  basis: LawfulBasis;
  /** True when given or renewed, false when withdrawn. */
  granted: boolean;
  source: ConsentSource;
  /** What the person saw, and where (no personal data). */
  evidence?: { wording?: string | null; formId?: string | null; url?: string | null; policyVersion?: string | null };
  recordedAt: string;
  expiresAt?: string | null;
  /** The plugin that recorded it. */
  recordedBy?: string | null;
}

export type ErasureScope = "all" | "marketing_only";
export type ErasureReason = "data_subject_request" | "retention_expired" | "client_offboarding" | "withdrawn_consent";

export interface ContactEraseRequested {
  /** `erase:<requestId>`. */
  key: string;
  requestId: string;
  subject: PrivacySubject;
  scope: ErasureScope;
  reason: ErasureReason;
  /** The person who approved the erasure. Required: receivers refuse without it. */
  approvedByUserId: string;
  approvalIssueId?: string | null;
  requestedAt: string;
  /** The statutory deadline for the request, when there is one. */
  dueBy?: string | null;
  /** The plugin that sent it. */
  source: string;
}

export type EraseStatus = "erased" | "nothing_found" | "retained" | "partial" | "failed";

export interface ContactEraseCompleted {
  /** `erase:<requestId>:<plugin>`. */
  key: string;
  requestId: string;
  plugin: string;
  status: EraseStatus;
  /** Rows erased, by kind (`contacts`, `messages`, `enrollments`...). */
  counts: Record<string, number>;
  /** What the plugin keeps because the law requires it, with the reason. */
  retained: Array<{ what: string; why: string }>;
  completedAt: string;
  error?: string | null;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** A stable key for a subject: the lower-cased email, else the phone digits, else the contact id. Null when it has none. */
export function consentSubjectKey(subject: PrivacySubject): string | null {
  const email = subject.email?.trim().toLowerCase();
  if (email && email.includes("@")) return `email:${email}`;
  const phone = subject.phone?.replace(/[^0-9+]/g, "");
  if (phone && phone.length >= 7) return `phone:${phone}`;
  return subject.contactId ? `contact:${subject.contactId}` : null;
}

export function consentKey(subject: PrivacySubject, purpose: ConsentPurpose, recordedAt: string): string | null {
  const who = consentSubjectKey(subject);
  return who ? `consent:${who}:${purpose}:${recordedAt}` : null;
}

export function eraseRequestKey(requestId: string): string {
  return `erase:${requestId}`;
}

/** True when `incoming` is not older than `current` (equal counts as newer, so a re-send is harmless). */
export function consentIsNewer(current: Pick<ConsentRecorded, "recordedAt"> | null | undefined, incoming: Pick<ConsentRecorded, "recordedAt">): boolean {
  const have = Date.parse(current?.recordedAt ?? "");
  const next = Date.parse(incoming.recordedAt);
  return !Number.isFinite(have) || !Number.isFinite(next) || next >= have;
}

// ---------------------------------------------------------------------------
// Parsing what arrives
// ---------------------------------------------------------------------------

const PURPOSES: ConsentPurpose[] = ["marketing_email", "marketing_sms", "newsletter", "profiling", "service_messages"];
const BASES: LawfulBasis[] = ["consent", "contract", "legitimate_interest", "legal_obligation"];
const SOURCES: ConsentSource[] = ["form", "import", "manual", "reply", "unsubscribe_link", "api"];
const REASONS: ErasureReason[] = ["data_subject_request", "retention_expired", "client_offboarding", "withdrawn_consent"];

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asSubject(value: unknown): PrivacySubject | null {
  const v = record(value);
  const subject: PrivacySubject = {
    email: typeof v.email === "string" ? v.email : null,
    phone: typeof v.phone === "string" ? v.phone : null,
    contactId: typeof v.contactId === "string" ? v.contactId : null,
    clientKind: v.clientKind === "company" || v.clientKind === "contact" ? v.clientKind : null,
    clientRef: typeof v.clientRef === "string" ? v.clientRef : null,
  };
  return consentSubjectKey(subject) ? subject : null;
}

/** A well-formed `ConsentRecorded` from an event payload, or null. */
export function asConsentRecorded(payload: unknown): ConsentRecorded | null {
  const v = record(payload);
  const subject = asSubject(v.subject);
  if (!subject || typeof v.key !== "string" || !v.key) return null;
  if (!PURPOSES.includes(v.purpose as ConsentPurpose) || !BASES.includes(v.basis as LawfulBasis) || typeof v.granted !== "boolean") return null;
  const evidence = record(v.evidence);
  return {
    key: v.key,
    subject,
    purpose: v.purpose as ConsentPurpose,
    basis: v.basis as LawfulBasis,
    granted: v.granted,
    source: SOURCES.includes(v.source as ConsentSource) ? (v.source as ConsentSource) : "api",
    evidence: { wording: typeof evidence.wording === "string" ? evidence.wording : null, formId: typeof evidence.formId === "string" ? evidence.formId : null, url: typeof evidence.url === "string" ? evidence.url : null, policyVersion: typeof evidence.policyVersion === "string" ? evidence.policyVersion : null },
    recordedAt: typeof v.recordedAt === "string" ? v.recordedAt : new Date().toISOString(),
    expiresAt: typeof v.expiresAt === "string" ? v.expiresAt : null,
    recordedBy: typeof v.recordedBy === "string" ? v.recordedBy : null,
  };
}

/** A well-formed `ContactEraseRequested` from an event payload, or null (no subject, request id or sender). */
export function asEraseRequested(payload: unknown): ContactEraseRequested | null {
  const v = record(payload);
  const subject = asSubject(v.subject);
  if (!subject || typeof v.requestId !== "string" || !v.requestId) return null;
  return {
    key: eraseRequestKey(v.requestId),
    requestId: v.requestId,
    subject,
    scope: v.scope === "marketing_only" ? "marketing_only" : "all",
    reason: REASONS.includes(v.reason as ErasureReason) ? (v.reason as ErasureReason) : "data_subject_request",
    approvedByUserId: typeof v.approvedByUserId === "string" ? v.approvedByUserId : "",
    approvalIssueId: typeof v.approvalIssueId === "string" ? v.approvalIssueId : null,
    requestedAt: typeof v.requestedAt === "string" ? v.requestedAt : new Date().toISOString(),
    dueBy: typeof v.dueBy === "string" ? v.dueBy : null,
    source: typeof v.source === "string" ? v.source : "unknown",
  };
}

/** A well-formed `ContactEraseCompleted` from an event payload, or null. */
export function asEraseCompleted(payload: unknown): ContactEraseCompleted | null {
  const v = record(payload);
  if (typeof v.requestId !== "string" || typeof v.plugin !== "string" || typeof v.status !== "string") return null;
  const status: EraseStatus = (["erased", "nothing_found", "retained", "partial", "failed"] as const).find((s) => s === v.status) ?? "failed";
  const counts: Record<string, number> = {};
  for (const [kind, n] of Object.entries(record(v.counts))) if (typeof n === "number" && Number.isFinite(n)) counts[kind] = n;
  const retained = Array.isArray(v.retained) ? v.retained.map(record).filter((r) => typeof r.what === "string").map((r) => ({ what: String(r.what), why: String(r.why ?? "") })) : [];
  return { key: `erase:${v.requestId}:${v.plugin}`, requestId: v.requestId, plugin: v.plugin, status, counts, retained, completedAt: typeof v.completedAt === "string" ? v.completedAt : new Date().toISOString(), error: typeof v.error === "string" ? v.error : null };
}

// ---------------------------------------------------------------------------
// Receiving a request (every participant)
// ---------------------------------------------------------------------------

export interface EraseOutcome {
  counts: Record<string, number>;
  /** Kept by law, with the reason. */
  retained?: Array<{ what: string; why: string }>;
  /** Parts that could not be erased. */
  errors?: string[];
}

export interface EraseReceiverOptions {
  /** This plugin's key. */
  plugin: string;
  /** Erases the subject here. Must be idempotent (a second run finds nothing). Throw to report a failure. */
  erase(request: ContactEraseRequested, companyId: string): Promise<EraseOutcome>;
  /** Plugins whose requests this one honours; default `ERASURE_SOURCES` minus this plugin. */
  senders?: string[];
}

const eraseState = (companyId: string, requestId: string, plugin: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "pib-privacy", stateKey: `erase:${requestId}:${plugin}` });

function statusOf(outcome: EraseOutcome): EraseStatus {
  const total = Object.values(outcome.counts).reduce((sum, n) => sum + n, 0);
  if (outcome.errors?.length) return total > 0 ? "partial" : "failed";
  if (total > 0) return "erased";
  return outcome.retained?.length ? "retained" : "nothing_found";
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300);
}

/**
 * Handles one erasure request for this plugin, at most once. Returns the answer
 * to send. A stored answer is returned again (never erased twice); a request
 * with no approving person is refused (`failed`, nothing erased, not stored); a
 * handler that throws or reports errors is not stored, so a re-announcement retries.
 */
export async function handleEraseRequest(ctx: PluginContext, options: EraseReceiverOptions, companyId: string, request: ContactEraseRequested, now: Date = new Date()): Promise<ContactEraseCompleted> {
  const base = { key: `erase:${request.requestId}:${options.plugin}`, requestId: request.requestId, plugin: options.plugin, completedAt: now.toISOString() };
  if (!request.approvedByUserId.trim()) {
    return { ...base, status: "failed", counts: {}, retained: [], error: "Not approved by a person: erasure is irreversible, so it never runs without one." };
  }
  const stateKey = eraseState(companyId, request.requestId, options.plugin);
  try {
    const stored = (await ctx.state.get(stateKey)) as ContactEraseCompleted | null;
    if (stored?.status && stored.status !== "failed" && stored.status !== "partial") return stored;
  } catch {
    // no memo: erase is idempotent, so running again is safe
  }
  try {
    const outcome = await options.erase(request, companyId);
    const result: ContactEraseCompleted = { ...base, status: statusOf(outcome), counts: outcome.counts, retained: outcome.retained ?? [], ...(outcome.errors?.length ? { error: outcome.errors.join("; ").slice(0, 400) } : {}) };
    if (result.status !== "failed" && result.status !== "partial") await ctx.state.set(stateKey, result).catch(() => undefined);
    return result;
  } catch (error) {
    return { ...base, status: "failed", counts: {}, retained: [], error: errorText(error) };
  }
}

/** Subscribes the plugin to erasure requests (call once in `setup`). Emits `contact.erase.completed` for each. */
export function registerEraseReceiver(ctx: PluginContext, options: EraseReceiverOptions): void {
  const senders = (options.senders ?? ERASURE_SOURCES).filter((sender) => sender !== options.plugin);
  for (const sender of senders) {
    ctx.events.on(`plugin.${sender}.${HANDOFF_EVENTS.contactEraseRequested}` as `plugin.${string}`, async (event: PluginEvent) => {
      const request = asEraseRequested(event.payload);
      const companyId = event.companyId;
      if (!request || !companyId) return;
      try {
        const result = await handleEraseRequest(ctx, options, companyId, request);
        await ctx.events.emit(HANDOFF_EVENTS.contactEraseCompleted, companyId, result as unknown as Record<string, unknown>);
      } catch (error) {
        ctx.logger.error("Erasure request failed", { requestId: request.requestId, error: errorText(error) });
      }
    });
  }
}

/** Subscribes the plugin to consent records (call once in `setup`); `onConsent` must upsert and ignore an older `recordedAt`. */
export function registerConsentReceiver(ctx: PluginContext, options: { plugin: string; senders?: string[]; onConsent: (companyId: string, consent: ConsentRecorded) => Promise<void> }): void {
  for (const sender of (options.senders ?? CONSENT_SOURCES).filter((s) => s !== options.plugin)) {
    ctx.events.on(`plugin.${sender}.${HANDOFF_EVENTS.consentRecorded}` as `plugin.${string}`, async (event: PluginEvent) => {
      const consent = asConsentRecorded(event.payload);
      if (!consent || !event.companyId) return;
      try {
        await options.onConsent(event.companyId, consent);
      } catch (error) {
        ctx.logger.error("Consent record failed", { key: consent.key, error: errorText(error) });
      }
    });
  }
}

// ---------------------------------------------------------------------------
// The sender's ledger (the CRM)
// ---------------------------------------------------------------------------

export interface EraseLedgerEntry {
  request: ContactEraseRequested;
  /** Participants that have not answered yet. */
  pending: string[];
  completed: Record<string, ContactEraseCompleted>;
  announcedAt: string;
  /** Set once every participant has answered: SHA-256 (hex) of `consentSubjectKey(subject)`. The identifiers are gone from `request.subject` by then. */
  subjectHash?: string;
  redactedAt?: string;
}

/** SHA-256 as hex, with the Web Crypto API (Node 20+ and browsers; no import, so this module stays browser-safe). */
async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The ledger entry without the subject's identifiers (what is kept once the erasure is complete). */
export async function redactLedgerEntry(entry: EraseLedgerEntry, now: Date = new Date()): Promise<EraseLedgerEntry> {
  if (entry.redactedAt) return entry;
  const key = consentSubjectKey(entry.request.subject);
  return { ...entry, request: { ...entry.request, subject: {} }, subjectHash: key ? await sha256Hex(key) : undefined, redactedAt: now.toISOString() };
}

const ledgerState = (companyId: string, requestId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "pib-privacy", stateKey: `ledger:${requestId}` });
const ledgerIndexState = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "pib-privacy", stateKey: "ledger-open" });

async function openRequestIds(ctx: PluginContext, companyId: string): Promise<string[]> {
  const value = (await ctx.state.get(ledgerIndexState(companyId)).catch(() => null)) as { ids?: unknown } | null;
  return Array.isArray(value?.ids) ? value.ids.filter((id): id is string => typeof id === "string") : [];
}

/**
 * Records an approved erasure and announces it to every participant. Needs the
 * approving person; throws without one (the request is never sent).
 */
export async function startErasure(ctx: PluginContext, companyId: string, request: ContactEraseRequested, participants: string[] = ERASURE_PARTICIPANTS): Promise<EraseLedgerEntry> {
  if (!request.approvedByUserId.trim()) throw new Error("An erasure needs a person's approval first (approvedByUserId).");
  if (!consentSubjectKey(request.subject)) throw new Error("An erasure needs the person's email, phone or contact id.");
  const entry: EraseLedgerEntry = { request, pending: participants.filter((p) => p !== request.source), completed: {}, announcedAt: new Date().toISOString() };
  await ctx.state.set(ledgerState(companyId, request.requestId), entry);
  await ctx.state.set(ledgerIndexState(companyId), { ids: [...new Set([...(await openRequestIds(ctx, companyId)), request.requestId])] });
  await ctx.events.emit(HANDOFF_EVENTS.contactEraseRequested, companyId, request as unknown as Record<string, unknown>);
  return entry;
}

/** Records one participant's answer. `done` is true when every participant has answered (failed ones keep it open). */
export async function recordEraseResult(ctx: PluginContext, companyId: string, result: ContactEraseCompleted): Promise<{ done: boolean; entry: EraseLedgerEntry | null }> {
  const entry = (await ctx.state.get(ledgerState(companyId, result.requestId)).catch(() => null)) as EraseLedgerEntry | null;
  if (!entry) return { done: false, entry: null };
  const answered = result.status !== "failed" && result.status !== "partial";
  const next: EraseLedgerEntry = { ...entry, completed: { ...entry.completed, [result.plugin]: result }, pending: answered ? entry.pending.filter((p) => p !== result.plugin) : entry.pending };
  const done = next.pending.length === 0;
  // Complete: keep the proof (a hash), not the personal data.
  const stored = done ? await redactLedgerEntry(next) : next;
  await ctx.state.set(ledgerState(companyId, result.requestId), stored);
  if (done) await ctx.state.set(ledgerIndexState(companyId), { ids: (await openRequestIds(ctx, companyId)).filter((id) => id !== result.requestId) });
  return { done, entry: stored };
}

export interface StaleErasure {
  requestId: string;
  pending: string[];
  ageDays: number;
  /** The statutory deadline (`dueBy`) has passed. */
  overdue: boolean;
}

/** Erasure requests still waiting on a participant after `maxAgeDays` (default 7), or past their deadline. Oldest first. */
export async function staleErasures(ctx: PluginContext, companyId: string, options: { now?: number; maxAgeDays?: number } = {}): Promise<StaleErasure[]> {
  const now = options.now ?? Date.now();
  const maxAge = options.maxAgeDays ?? 7;
  const out: StaleErasure[] = [];
  for (const requestId of await openRequestIds(ctx, companyId)) {
    const entry = (await ctx.state.get(ledgerState(companyId, requestId)).catch(() => null)) as EraseLedgerEntry | null;
    if (!entry || entry.pending.length === 0) continue;
    const since = Date.parse(entry.announcedAt);
    const ageDays = Number.isFinite(since) ? Math.max(0, (now - since) / 86_400_000) : 0;
    const due = Date.parse(entry.request.dueBy ?? "");
    const overdue = Number.isFinite(due) && due < now;
    if (ageDays >= maxAge || overdue) out.push({ requestId, pending: entry.pending, ageDays, overdue });
  }
  return out.sort((a, b) => b.ageDays - a.ageDays);
}

/**
 * Cockpit health check: an erasure a participant never answered. A plugin with
 * no receiver (or one that cannot reach its data) leaves the request open for
 * good, and the person's data with it. Names the request and the plugins, never
 * the subject. Null when nothing is stale.
 */
export async function staleErasuresCheck(ctx: PluginContext, companyId: string, options: { now?: number; maxAgeDays?: number } = {}): Promise<HealthCheck | null> {
  const stale = await staleErasures(ctx, companyId, options);
  if (stale.length === 0) return null;
  const overdue = stale.some((item) => item.overdue);
  const lines = stale.slice(0, 3).map((item) => `${item.requestId} has waited ${Math.floor(item.ageDays)} days for ${item.pending.map((p) => p.replace(/^partnersinbiz\./, "")).join(", ")}${item.overdue ? " and is past its deadline" : ""}`);
  return {
    key: "privacy:erasure-stale",
    title: "Erasure requests that are not finished",
    status: overdue ? "bad" : "warn",
    detail: `${stale.length} approved erasure request${stale.length === 1 ? " is" : "s are"} still open: ${lines.join("; ")}${stale.length > 3 ? "; ..." : ""}. The person's data is still held where a plugin has not answered.`,
    fix: "Open the request and check each plugin that has not answered: it needs registerEraseReceiver in its setup (a plugin with no personal data should answer 'nothing found'), or its handler is failing. Legal deadlines run from the request date.",
  };
}

/** Re-sends every request that still has participants pending (call hourly: events are at-most-once). Returns how many it re-sent. */
export async function reannounceErasures(ctx: PluginContext, companyId: string): Promise<number> {
  let sent = 0;
  for (const requestId of await openRequestIds(ctx, companyId)) {
    const entry = (await ctx.state.get(ledgerState(companyId, requestId)).catch(() => null)) as EraseLedgerEntry | null;
    if (!entry || entry.pending.length === 0) continue;
    await ctx.events.emit(HANDOFF_EVENTS.contactEraseRequested, companyId, entry.request as unknown as Record<string, unknown>);
    sent += 1;
  }
  return sent;
}

/** Subscribes the sender to the participants' answers (call once in `setup`); `onResult` gets the ledger after each. */
export function registerEraseResultWatch(ctx: PluginContext, onResult: (companyId: string, result: ContactEraseCompleted, ledger: { done: boolean; entry: EraseLedgerEntry | null }) => Promise<void>, participants: string[] = ERASURE_PARTICIPANTS): void {
  for (const plugin of participants) {
    ctx.events.on(`plugin.${plugin}.${HANDOFF_EVENTS.contactEraseCompleted}` as `plugin.${string}`, async (event: PluginEvent) => {
      const result = asEraseCompleted(event.payload);
      if (!result || !event.companyId) return;
      try {
        await onResult(event.companyId, result, await recordEraseResult(ctx, event.companyId, result));
      } catch (error) {
        ctx.logger.error("Erasure result failed", { requestId: result.requestId, error: errorText(error) });
      }
    });
  }
}

/** One paragraph for the approval issue or the data-protection log: who answered, what was erased and kept. */
export function eraseSummary(entry: EraseLedgerEntry): string {
  const lines = Object.values(entry.completed).map((r) => {
    const counted = Object.entries(r.counts).filter(([, n]) => n > 0).map(([kind, n]) => `${n} ${kind}`).join(", ");
    const kept = r.retained.length ? ` Kept by law: ${r.retained.map((k) => `${k.what} (${k.why})`).join("; ")}.` : "";
    return `- ${r.plugin}: ${r.status}${counted ? ` (${counted})` : ""}.${kept}${r.error ? ` Error: ${r.error}` : ""}`;
  });
  const waiting = entry.pending.length ? [`Still waiting for: ${entry.pending.join(", ")}.`] : ["Every plugin has answered."];
  return [`Erasure ${entry.request.requestId} (${entry.request.reason}), approved by user ${entry.request.approvedByUserId}.`, ...lines, ...waiting].join("\n");
}
