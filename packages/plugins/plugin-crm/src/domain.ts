import { randomUUID } from "node:crypto";

export const LIFECYCLES = ["lead", "prospect", "customer", "churned"] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];

export const STAGE_KINDS = ["open", "won", "lost"] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

export const NEXT_ACTIONS = ["call", "email", "meet"] as const;
export type NextActionKind = (typeof NEXT_ACTIONS)[number];

export const RECORD_TYPES = ["contact", "company", "deal"] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export const PRINCIPAL_TYPES = ["user", "agent", "company"] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

export const COMPLETION_MODES = ["manual", "sent"] as const;
export type CompletionMode = (typeof COMPLETION_MODES)[number];

export const LOCAL_BOARD_USER_ID = "local-board";

export class CrmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrmError";
  }
}

export interface Viewer {
  companyId: string;
  userId: string | null;
  agentId: string | null;
  role: string | null;
}

export interface Grant {
  principalType: PrincipalType;
  principalId: string;
}

export interface RecordAccess {
  companyId: string;
  ownerUserId: string | null;
  assigneeAgentId: string | null;
}

export interface FactDraft {
  fieldKey: string;
  value: unknown;
  source: string;
  refused: boolean;
}

export interface AccountDraft {
  id: string;
  companyId: string;
  name: string;
  domain: string | null;
  lifecycle: Lifecycle;
  currency: string;
  custom: Record<string, unknown>;
  humanOwned: string[];
  ownerUserId: string | null;
  assigneeAgentId: string | null;
  tags: string[];
}

export interface ContactDraft {
  id: string;
  companyId: string;
  name: string;
  emails: string[];
  phones: string[];
  lifecycle: Lifecycle;
  custom: Record<string, unknown>;
  humanOwned: string[];
  ownerUserId: string | null;
  assigneeAgentId: string | null;
  tags: string[];
  nextActionKind: NextActionKind | null;
  nextActionDueAt: string | null;
}

export interface LinkDraft {
  id: string;
  companyId: string;
  contactId: string;
  accountId: string;
  roleLabel: string;
}

export interface DealDraft {
  id: string;
  companyId: string;
  pipelineId: string;
  stageId: string;
  accountId: string | null;
  contactId: string | null;
  title: string;
  amountMinor: number;
  currency: string;
  ownerUserId: string | null;
  assigneeAgentId: string | null;
  tags: string[];
  nextActionKind: NextActionKind | null;
  nextActionDueAt: string | null;
  custom: Record<string, unknown>;
  humanOwned: string[];
}

export interface EnrollmentDraft {
  id: string;
  companyId: string;
  sequenceId: string;
  contactId: string;
  status: "running" | "stopped" | "done";
  stepPosition: number;
  nextDueAt: string | null;
  openIssueId: string | null;
}

export interface ProductDraft {
  id: string;
  companyId: string;
  name: string;
  description: string;
  unitAmountMinor: number;
  currency: string;
  isActive: boolean;
}

export interface ScoreBreakdown {
  total: number;
  parts: Array<{ label: string; points: number }>;
}

export interface ScoreInput {
  lifecycle: Lifecycle;
  hasEmail: boolean;
  hasPhone: boolean;
  hasNextAction: boolean;
  activityCount: number;
  lastActivityAt: string | null;
  tags: string[];
  now: string;
}

export interface SequenceStepDraft {
  position: number;
  delayMinutes: number;
  title: string;
  body: string;
}

export interface PatchResult {
  columns: Record<string, unknown>;
  custom: Record<string, unknown>;
  facts: FactDraft[];
  refused: string[];
}

const ACCOUNT_COLUMNS = ["name", "domain", "lifecycle", "currency", "tags"];
const CONTACT_COLUMNS = ["name", "emails", "phones", "lifecycle", "tags", "nextActionKind", "nextActionDueAt"];
const DEAL_COLUMNS = ["title", "amountMinor", "currency", "stageId", "tags", "nextActionKind", "nextActionDueAt"];

export function columnKeysFor(recordType: RecordType): string[] {
  if (recordType === "company") return ACCOUNT_COLUMNS;
  if (recordType === "contact") return CONTACT_COLUMNS;
  return DEAL_COLUMNS;
}

export function isEmptyValue(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

export function assertLifecycle(value: string): Lifecycle {
  if (!LIFECYCLES.includes(value as Lifecycle)) {
    throw new CrmError("Lifecycle must be lead, prospect, customer, or churned");
  }
  return value as Lifecycle;
}

export function assertCurrency(value: string): string {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new CrmError("Currency must be a 3-letter code");
  return code;
}

export function assertAmountMinor(value: unknown): number {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(amount) || amount < 0) {
    throw new CrmError("Amount must be a non-negative integer in minor units");
  }
  return amount;
}

export function assertNextAction(value: unknown): NextActionKind | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !NEXT_ACTIONS.includes(value as NextActionKind)) {
    throw new CrmError("Next action must be call, email, or meet");
  }
  return value as NextActionKind;
}

export function assertRecordType(value: string): RecordType {
  if (!RECORD_TYPES.includes(value as RecordType)) {
    throw new CrmError("Record type must be contact, company, or deal");
  }
  return value as RecordType;
}

export function assertPrincipalType(value: string): PrincipalType {
  if (!PRINCIPAL_TYPES.includes(value as PrincipalType)) {
    throw new CrmError("Principal type must be user, agent, or company");
  }
  return value as PrincipalType;
}

export function canSeeRecord(viewer: Viewer, record: RecordAccess, grants: Grant[]): boolean {
  const inWorkspace = record.companyId === viewer.companyId;
  if (inWorkspace && (viewer.role === "owner" || viewer.role === "admin")) return true;
  if (inWorkspace && viewer.userId && record.ownerUserId === viewer.userId) return true;
  if (viewer.agentId && record.assigneeAgentId === viewer.agentId) return true;
  if (viewer.userId && grants.some((grant) => grant.principalType === "user" && grant.principalId === viewer.userId)) {
    return true;
  }
  if (viewer.agentId && grants.some((grant) => grant.principalType === "agent" && grant.principalId === viewer.agentId)) {
    return true;
  }
  if (grants.some((grant) => grant.principalType === "company" && grant.principalId === viewer.companyId)) {
    return true;
  }
  return false;
}

/** Throws instead of returning a redacted record. */
export function requireVisible<T extends RecordAccess>(viewer: Viewer, record: T, grants: Grant[]): T {
  if (!canSeeRecord(viewer, record, grants)) throw new CrmError("Record is not visible");
  return record;
}

export function applyFieldPatch(input: {
  columns: Record<string, unknown>;
  custom: Record<string, unknown>;
  humanOwned: string[];
  columnKeys: string[];
  patch: Record<string, unknown>;
  source: "agent" | "human";
}): PatchResult {
  const columns = { ...input.columns };
  const custom = { ...input.custom };
  const facts: FactDraft[] = [];
  const refused: string[] = [];
  const owned = new Set(input.humanOwned);

  for (const [key, value] of Object.entries(input.patch)) {
    if (key === "humanOwned" || key === "id" || key === "companyId") {
      if (input.source === "agent") {
        refused.push(key);
        facts.push({ fieldKey: key, value, source: input.source, refused: true });
      }
      continue;
    }
    const current = input.columnKeys.includes(key) ? input.columns[key] : input.custom[key];
    if (input.source === "agent" && owned.has(key) && !isEmptyValue(current)) {
      refused.push(key);
      facts.push({ fieldKey: key, value, source: input.source, refused: true });
      continue;
    }
    if (input.columnKeys.includes(key)) columns[key] = value;
    else custom[key] = value;
    facts.push({ fieldKey: key, value, source: input.source, refused: false });
  }

  return { columns, custom, facts, refused };
}

export function createAccount(input: {
  companyId: string;
  name: string;
  domain?: string | null;
  lifecycle?: string;
  currency?: string;
  custom?: Record<string, unknown>;
  ownerUserId?: string | null;
  assigneeAgentId?: string | null;
  tags?: string[];
  id?: string;
}): AccountDraft {
  const name = input.name.trim();
  if (!name) throw new CrmError("Company name is required");
  return {
    id: input.id ?? randomUUID(),
    companyId: input.companyId,
    name,
    domain: input.domain?.trim() || null,
    lifecycle: assertLifecycle(input.lifecycle ?? "lead"),
    currency: assertCurrency(input.currency ?? "ZAR"),
    custom: input.custom ?? {},
    humanOwned: [],
    ownerUserId: input.ownerUserId ?? null,
    assigneeAgentId: input.assigneeAgentId ?? null,
    tags: input.tags ?? [],
  };
}

export function createContact(input: {
  companyId: string;
  name: string;
  emails?: string[];
  phones?: string[];
  lifecycle?: string;
  custom?: Record<string, unknown>;
  ownerUserId?: string | null;
  assigneeAgentId?: string | null;
  tags?: string[];
  nextActionKind?: unknown;
  nextActionDueAt?: string | null;
  id?: string;
}): ContactDraft {
  const name = input.name.trim();
  if (!name) throw new CrmError("Contact name is required");
  return {
    id: input.id ?? randomUUID(),
    companyId: input.companyId,
    name,
    emails: cleanStrings(input.emails),
    phones: cleanStrings(input.phones),
    lifecycle: assertLifecycle(input.lifecycle ?? "lead"),
    custom: input.custom ?? {},
    humanOwned: [],
    ownerUserId: input.ownerUserId ?? null,
    assigneeAgentId: input.assigneeAgentId ?? null,
    tags: input.tags ?? [],
    nextActionKind: assertNextAction(input.nextActionKind),
    nextActionDueAt: input.nextActionDueAt ?? null,
  };
}

export function linkContact(input: {
  companyId: string;
  contactId: string;
  accountId: string;
  roleLabel?: string;
  id?: string;
}): LinkDraft {
  if (!input.contactId || !input.accountId) throw new CrmError("A link needs a contact and a company");
  const roleLabel = (input.roleLabel ?? "staff").trim();
  if (!roleLabel) throw new CrmError("Link role is required");
  return {
    id: input.id ?? randomUUID(),
    companyId: input.companyId,
    contactId: input.contactId,
    accountId: input.accountId,
    roleLabel,
  };
}

export function assertCanEnroll(existing: Array<{ status: string }>): void {
  if (existing.some((row) => row.status === "running")) {
    throw new CrmError("Contact already has a running enrollment in this sequence");
  }
}

export function stageStopsEnrollments(kind: string): boolean {
  return kind === "won" || kind === "lost";
}

export function stopRunningEnrollments<T extends { status: string }>(rows: T[], stageKind: string): T[] {
  if (!stageStopsEnrollments(stageKind)) return rows;
  return rows.map((row) => (row.status === "running" ? { ...row, status: "stopped" } : row));
}

export function startEnrollment(input: {
  companyId: string;
  sequenceId: string;
  contactId: string;
  existing: Array<{ status: string }>;
  steps: SequenceStepDraft[];
  now: Date;
  id?: string;
}): EnrollmentDraft {
  assertCanEnroll(input.existing);
  const first = [...input.steps].sort((a, b) => a.position - b.position)[0];
  if (!first) throw new CrmError("Sequence has no steps");
  return {
    id: input.id ?? randomUUID(),
    companyId: input.companyId,
    sequenceId: input.sequenceId,
    contactId: input.contactId,
    status: "running",
    stepPosition: first.position,
    nextDueAt: new Date(input.now.getTime() + first.delayMinutes * 60_000).toISOString(),
    openIssueId: null,
  };
}

export function canCompleteStep(input: {
  completionMode: CompletionMode;
  issueStatus: string | null;
  sentConfirmed: boolean;
}): boolean {
  if (input.completionMode === "manual") return input.issueStatus === "done";
  return input.sentConfirmed;
}

export function advanceEnrollment(
  enrollment: EnrollmentDraft,
  steps: SequenceStepDraft[],
  now: Date,
): EnrollmentDraft {
  const later = steps
    .filter((step) => step.position > enrollment.stepPosition)
    .sort((a, b) => a.position - b.position);
  const next = later[0];
  if (!next) {
    return { ...enrollment, status: "done", openIssueId: null, nextDueAt: null };
  }
  return {
    ...enrollment,
    status: "running",
    stepPosition: next.position,
    openIssueId: null,
    nextDueAt: new Date(now.getTime() + next.delayMinutes * 60_000).toISOString(),
  };
}

export function sequenceIssueCopy(contactName: string, step: SequenceStepDraft): { title: string; description: string } {
  return {
    title: `${step.title}: ${contactName}`,
    description: step.body,
  };
}

export const DEFAULT_STAGES: Array<{ name: string; kind: StageKind; position: number }> = [
  { name: "Discovery", kind: "open", position: 0 },
  { name: "Proposal", kind: "open", position: 1 },
  { name: "Negotiation", kind: "open", position: 2 },
  { name: "Won", kind: "won", position: 3 },
  { name: "Lost", kind: "lost", position: 4 },
];

export function assertSharePrincipal(principalType: PrincipalType): void {
  if (principalType === "company") {
    throw new CrmError("Company grants are created from an accepted partner link");
  }
}

export function createProduct(input: {
  companyId: string;
  name: string;
  description?: string;
  unitAmountMinor?: number;
  currency?: string;
  isActive?: boolean;
  id?: string;
}): ProductDraft {
  const name = input.name.trim();
  if (!name) throw new CrmError("Product name is required");
  return {
    id: input.id ?? randomUUID(),
    companyId: input.companyId,
    name,
    description: (input.description ?? "").trim(),
    unitAmountMinor: assertAmountMinor(input.unitAmountMinor ?? 0),
    currency: assertCurrency(input.currency ?? "ZAR"),
    isActive: input.isActive ?? true,
  };
}

const LIFECYCLE_SCORE: Record<Lifecycle, number> = {
  lead: 10,
  prospect: 30,
  customer: 50,
  churned: 5,
};

const HOT_TAGS = new Set(["hot", "priority", "vip", "urgent"]);

/**
 * A transparent 0-100 lead score. Higher is warmer. The breakdown lets the
 * UI and agents explain why a contact is scored the way they are.
 */
export function scoreContact(input: ScoreInput): ScoreBreakdown {
  const parts: Array<{ label: string; points: number }> = [];
  const push = (label: string, points: number) => {
    if (points > 0) parts.push({ label, points });
  };

  push("Lifecycle", LIFECYCLE_SCORE[input.lifecycle] ?? 0);

  if (input.hasEmail) push("Email on file", 5);
  if (input.hasPhone) push("Phone on file", 5);
  if (input.hasNextAction) push("Next action scheduled", 10);

  if (input.activityCount >= 3) push("Active engagement", 15);
  else if (input.activityCount >= 1) push("Some engagement", 8);

  if (input.lastActivityAt) {
    const days = Math.max(0, (Date.parse(input.now) - Date.parse(input.lastActivityAt)) / 86_400_000);
    if (days <= 7) push("Engaged this week", 20);
    else if (days <= 30) push("Engaged this month", 10);
  }

  if (input.tags.some((tag) => HOT_TAGS.has(tag.toLowerCase()))) push("Priority tag", 10);

  const total = Math.min(100, parts.reduce((sum, part) => sum + part.points, 0));
  return { total, parts };
}

export function scoreBand(total: number): "cold" | "warm" | "hot" {
  if (total >= 60) return "hot";
  if (total >= 30) return "warm";
  return "cold";
}

export function assertProductName(value: string): string {
  const name = value.trim();
  if (!name) throw new CrmError("Product name is required");
  return name;
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isDuplicatePair(a: { emails: string[] }, b: { emails: string[] }): boolean {
  const aEmails = new Set(a.emails.map(normalizeEmail).filter(Boolean));
  const bEmails = new Set(b.emails.map(normalizeEmail).filter(Boolean));
  for (const email of aEmails) {
    if (bEmails.has(email)) return true;
  }
  return false;
}

export function assertMergeTargets(primaryId: string, duplicateId: string): void {
  if (primaryId === duplicateId) throw new CrmError("Primary and duplicate must be different contacts");
}

/** Default win probability by stage kind. Open stages weight by position. */
export function stageWinProbability(kind: StageKind, position: number, totalOpenStages: number): number {
  if (kind === "won") return 1;
  if (kind === "lost") return 0;
  if (totalOpenStages <= 1) return 0.5;
  return 0.2 + (position / Math.max(totalOpenStages - 1, 1)) * 0.6;
}

export interface ForecastStage {
  stageId: string;
  name: string;
  kind: StageKind;
  count: number;
  amountMinor: number;
  currency: string;
  probability: number;
  weightedMinor: number;
}

export function forecastPipeline(input: {
  stages: Array<{ id: string; name: string; kind: StageKind; position: number }>;
  deals: Array<{ stageId: string; amountMinor: number; currency: string }>;
}): { stages: ForecastStage[]; totalOpenMinor: number; weightedMinor: number; currency: string } {
  const openStages = input.stages.filter((stage) => stage.kind === "open");
  const byStage = new Map<string, { count: number; amountMinor: number; currency: string }>();
  for (const stage of input.stages) byStage.set(stage.id, { count: 0, amountMinor: 0, currency: "ZAR" });
  for (const deal of input.deals) {
    const bucket = byStage.get(deal.stageId) ?? { count: 0, amountMinor: 0, currency: deal.currency };
    bucket.count += 1;
    bucket.amountMinor += deal.amountMinor;
    bucket.currency = deal.currency;
    byStage.set(deal.stageId, bucket);
  }
  const stages: ForecastStage[] = input.stages.map((stage) => {
    const bucket = byStage.get(stage.id) ?? { count: 0, amountMinor: 0, currency: "ZAR" };
    const probability = stageWinProbability(stage.kind, stage.position, openStages.length);
    return {
      stageId: stage.id,
      name: stage.name,
      kind: stage.kind,
      count: bucket.count,
      amountMinor: bucket.amountMinor,
      currency: bucket.currency,
      probability,
      weightedMinor: Math.round(bucket.amountMinor * probability),
    };
  });
  const open = stages.filter((stage) => stage.kind === "open");
  const totalOpenMinor = open.reduce((sum, stage) => sum + stage.amountMinor, 0);
  const weightedMinor = open.reduce((sum, stage) => sum + stage.weightedMinor, 0);
  const currency = open[0]?.currency ?? "ZAR";
  return { stages, totalOpenMinor, weightedMinor, currency };
}

export interface SavedViewDraft {
  id: string;
  companyId: string;
  name: string;
  recordType: RecordType;
  filters: Record<string, unknown>;
  createdByUserId: string | null;
}

export function createSavedView(input: {
  companyId: string;
  name: string;
  recordType: string;
  filters?: Record<string, unknown>;
  createdByUserId?: string | null;
  id?: string;
}): SavedViewDraft {
  const name = input.name.trim();
  if (!name) throw new CrmError("View name is required");
  return {
    id: input.id ?? randomUUID(),
    companyId: input.companyId,
    name,
    recordType: assertRecordType(input.recordType),
    filters: input.filters ?? {},
    createdByUserId: input.createdByUserId ?? null,
  };
}

export function assertViewName(value: string): string {
  const name = value.trim();
  if (!name) throw new CrmError("View name is required");
  return name;
}

/** Escape a value for a CSV cell. */
export function csvCell(value: unknown): string {
  if (value == null) return "";
  const text = String(value);
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** Build a CSV string from a header row and data rows. */
export function toCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => csvCell(row[header])).join(","));
  }
  return lines.join("\n");
}

/** Parse a CSV string into rows of string values, handling quoted cells. */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

function cleanStrings(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}
