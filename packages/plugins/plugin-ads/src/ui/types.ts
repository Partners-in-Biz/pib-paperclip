/** The shapes the page reads from the worker (`ads.load` and friends). Money is minor units plus formatted text. */
import type { AlertKind, ProposalKind, ProposalStatus } from "../platforms.js";

export interface PlatformInfo {
  platform: "meta" | "google" | "mock";
  label: string;
  enabled: boolean;
  switchedOn: boolean;
  signIn: boolean;
  token: boolean;
  blocker: string | null;
  requestWrite: boolean;
}

export interface ConnectionInfo {
  id: string;
  platform: "meta" | "google" | "mock";
  label: string;
  mode: "oauth" | "token";
  status: "connected" | "expiring" | "needs_reconnect" | "disabled";
  statusDetail: string | null;
  canWrite: boolean;
  expiresAt: string | null;
  lastOkAt: string | null;
}

export interface AccountInfo {
  id: string;
  platform: string;
  platformLabel: string;
  externalId: string;
  name: string;
  currency: string;
  scopeKey: string;
  scopeLabel: string;
  status: string;
  connectionId: string | null;
  connectionStatus: string | null;
  lastSyncAt: string | null;
  lastSyncOkAt: string | null;
  lastSyncError: string | null;
}

export interface BudgetInfo {
  scopeKey: string;
  label: string;
  currency: string;
  month: string;
  capMinor: number | null;
  cap: string;
  spentMinor: number;
  spent: string;
  pctUsed: number | null;
  expectedPctByNow: number;
  daysLeft: number;
  projectedRunRate: string;
  state: "no_cap" | "ok" | "watch" | "alert" | "over";
  alertPct: number;
  targetCpaMinor: number | null;
  allowWrites: boolean;
  signoffs: "owner" | "owner_client";
  overrides: Array<{ month: string; cap_minor: number; note: string | null }>;
  openPauseRequests: Array<{ proposalId: string; status: string }>;
  note?: string;
}

export interface AlertInfo {
  alertId: string;
  kind: AlertKind;
  severity: "info" | "warn" | "bad";
  scopeKey: string;
  title: string;
  text: string;
  status: string;
  issueId: string | null;
  lastSeenAt: string | null;
}

export interface ProposalSummary {
  proposalId: string;
  kind: ProposalKind;
  kindLabel: string;
  status: ProposalStatus;
  statusLabel: string;
  scopeKey: string;
  title: string;
  summary: string;
  capState: "no_cap" | "within" | "exceeds";
  reviewState: string;
  requiresSignoffs: string[];
  issueId: string | null;
  createdAt: string | null;
  currency: string;
}

export interface ProposalDetail extends ProposalSummary {
  scopeLabel: string;
  numbers: string[];
  budget: string[];
  precheck: { findings?: Array<{ level: string; where: string; text: string }>; blockers?: number; warnings?: number };
  reviewNotes: string | null;
  reviewBy: string | null;
  error: string | null;
  execution: { results?: Array<{ what: string; ok: boolean; error?: string }> } | null;
  signoffs: { required: string[]; missing: string[]; given: Record<string, { by: string; at: string | null; note: string | null }>; refused: { by: string; note: string | null } | null };
  approvalId: string | null;
  clientMessage: string | null;
  next: string;
}

export interface SummaryGroup {
  key: string;
  label: string;
  platform?: string;
  currency: string;
  spendMinor: number;
  spend: string;
  impressions: number;
  clicks: number;
  conversions: number;
  cpc: string | null;
  cpa: string | null;
  roas: number | null;
  ctr: number | null;
}

export interface Summary {
  period: { since: string; until: string; label: string };
  groups: SummaryGroup[];
  totals: Array<Omit<SummaryGroup, "key" | "label"> & { currency: string }>;
  hasData: boolean;
}

export interface AuditEntry {
  at: string | null;
  actor: string;
  action: string;
  scope_key: string | null;
  subject: string | null;
  detail: Record<string, unknown>;
}

export interface Overview {
  today: string;
  platforms: PlatformInfo[];
  writesEnabled: boolean;
  settingsSaved: boolean;
  connections: ConnectionInfo[];
  accounts: AccountInfo[];
  budgets: BudgetInfo[];
  alerts: AlertInfo[];
  proposals: ProposalSummary[];
  month: Summary;
  daily: Summary;
  audit: AuditEntry[];
  agent: { agentId: string | null; name: string | null; status: string | null; active: boolean };
  clients: Record<string, string>;
  redirectUri: string | null;
  publicBaseUrlError: string | null;
  encryptionKey: boolean;
}
