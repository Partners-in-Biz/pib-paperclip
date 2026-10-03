import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useHostLocation,
  DataTable,
  useHostNavigation,
  usePluginAction,
  type PluginPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import { rememberOAuthStart, resolvePluginUiBase } from "@partnersinbiz/pib-plugin-kit/oauth-client";
import { ModuleOffBanner, useModuleEnabled } from "./module-switch.js";
import {
  BarChart,
  BarList,
  Bot,
  Button,
  ChartColumn,
  ChartPie,
  CircleAlert,
  CompactRows,
  DonutChart,
  EmptyState,
  Field,
  FileText,
  IconBadge,
  Inbox,
  Input,
  KpiCard,
  LayoutDashboard,
  ListChecks,
  Mail,
  MailCheck,
  Modal,
  Page,
  Pill,
  RefreshCw,
  Select,
  SectionCard,
  Send,
  Settings as SettingsIcon,
  Sparkles,
  StatusDot,
  Tabs,
  TextArea,
  Toolbar,
  breakAnywhere,
  errorText,
  fluidColumns,
  formatDateTime,
  formatShortDate,
  seriesColor,
  tokens,
  tone,
  useIsNarrow,
  type Segment,
} from "@partnersinbiz/pib-plugin-ui";
import { GetStarted, useGroupedNav, usePluginSetupStatus, useUrlTab } from "@partnersinbiz/pib-plugin-ui";
import type { DailySeries } from "../daily.js";
import { CATEGORY_NAMES, SEND_SERIES, accountTone, categoryColor, categorySegments, categoryTone, draftTone, isSyncing, receivedColumns, sendColumns, sendTone } from "./series.js";
import { MAP_TYPE_NAMES, canSendFrom, connectReadiness, domainFacts, domainStatusLabel, domainTone, draftRecipients, missingTechnical, recentTime, sendBlock, sentBy, suggestMapping } from "./view.js";

const PLUGIN_KEY = "partnersinbiz.mailbox";

interface Settings {
  /** The Mailbox settings page (worker 0.3.0+). */
  href?: string;
  saved: boolean;
  publicBaseUrl: string | null;
  redirectUri: string | null;
  encryptionKey: boolean;
  googleClientId: boolean;
  googleClientSecret: boolean;
  jev: boolean;
  labelPrefix: string;
  sendRatePerMinute: number;
  triageIssues: boolean;
  /** Private R2 storage for get-attachment links. */
  r2?: boolean;
  /** Who gets mailbox access without asking (0.5.0). */
  autoDelegate?: string;
  domainChecks?: boolean;
  unsubscribeSecret?: boolean;
}
interface Suppression { email: string; scope: "marketing" | "all"; reason: string; source: string; at: string }
interface Account {
  id: string;
  address: string;
  provider: string;
  status: "manual" | "connected" | "needs_reconnect" | "disconnected";
  is_default: boolean;
  has_credential: boolean;
  last_sync_at: string | null;
  last_error: string | null;
  sync_stats: { stored?: number; triaged?: number; mode?: string } | null;
  /** The client this mailbox belongs to (0.5.0): it sends only that client's mail. */
  client_kind?: string | null;
  client_ref?: string | null;
  from_name?: string | null;
}
interface Delegation { id: string; account_id: string; agent_id: string; can_read?: boolean; can_draft?: boolean; can_send: boolean; source?: string }
interface DomainProblem { severity: string; message: string; fix: string }
interface DomainRow {
  domain: string;
  status: string;
  sendReady: boolean;
  checkedAt: string;
  statusSince: string;
  source: string;
  mx: string | null;
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
  problems: DomainProblem[];
}
interface ClientMapView { id: string; matchType: string; pattern: string; clientKind: string; clientRef: string; clientName: string | null; note: string | null }
interface ClientMapOverview {
  maps: ClientMapView[];
  unmapped: Array<{ domain: string; messages: number; lastReceivedAt: string | null; sampleMessageId: string | null }>;
}
interface DomainCheckResult {
  domain: string;
  applicable?: boolean;
  note?: string;
  status: string;
  healthy?: boolean;
  sendReady?: boolean;
  problems?: DomainProblem[];
  manual?: string[];
  onboarding?: { steps: string[]; dig: string[]; alreadyDone: string[] };
}
interface Draft {
  id: string;
  account_id: string;
  subject: string;
  body?: string;
  status: string;
  direction: string;
  send_error: string | null;
  to_addrs: Array<{ email: string; name?: string | null }> | null;
  cc_addrs?: Array<{ email: string }> | null;
  bcc_addrs?: Array<{ email: string }> | null;
  created_at?: string | null;
  drafted_by?: { kind: "agent" | "user"; id: string } | null;
  is_reply?: boolean;
  has_html?: boolean;
}
interface Snapshot {
  settings: Settings;
  accounts: Account[];
  delegations: Delegation[];
  messages: Draft[];
  unreadCount: number;
  sendCounts: Record<string, number>;
  categoryCounts: Record<string, number>;
  categories: string[];
  /** Per-day counts for the charts (worker 0.2.3+). */
  daily?: DailySeries;
  /** The do-not-email list, newest first (worker 0.3.0+). */
  suppressions?: Suppression[];
  /** Last SPF, DKIM, DMARC and MX check of each sending domain (worker 0.5.0+). */
  domains?: DomainRow[];
  /** Client mail mappings and the sender domains of mail waiting for one (worker 0.5.0+). */
  clientMaps?: ClientMapOverview | null;
}
interface InboxMessage {
  id: string;
  account_id: string;
  subject: string;
  snippet: string | null;
  from: { email: string; name?: string | null } | null;
  received_at: string | null;
  created_at: string;
  is_read: boolean;
  category: string | null;
  urgency: number | null;
  needs_reply: number | null;
  phishing: number | null;
  client_kind: string | null;
  client_ref: string | null;
  client_name: string | null;
  attachments: Array<{ filename: string }>;
  reply_to: { plugin: string; kind: string } | null;
  /** `needs_mapping`: it looks like a client's mail but no mapping says so (worker 0.5.0+). */
  map_state?: string | null;
  visitor?: { email: string; name?: string | null } | null;
}
interface ClientOption { ref: string; name: string; kind: string }
interface SendRequest {
  key: string;
  status: "sending" | "sent" | "failed" | "retrying";
  /** Campaign or sequence mail: suppressed addresses are left out and it carries List-Unsubscribe. */
  marketing?: boolean;
  /** Recipients left out because they are on the do-not-email list. */
  skipped?: Array<{ email: string; scope: string; reason: string }>;
  permanent: boolean;
  attempts: number;
  error: string | null;
  sourcePlugin: string;
  context: { plugin: string; kind: string; id: string } | null;
  from: string | null;
  to: string[];
  subject: string;
  sentAt: string | null;
  createdAt: string;
}
interface TriageStats {
  days: number;
  questions: Array<{ question: string; total: number; corrected: number; accuracy: number | null; avgConfidence: number }>;
  categories: Record<string, number>;
}
interface NamedAgent { id: string; name: string; status: string }

const TAB_IDS = ["overview", "inbox", "sent", "drafts", "mailboxes", "triage"] as const;
type TabId = (typeof TAB_IDS)[number];
type CreateKind = "mailbox" | "delegation" | "draft" | "domain" | "client-map" | "account-client" | null;
type Preview = { kind: "draft"; id: string } | { kind: "mail"; id: string } | { kind: "send"; key: string } | null;

const URGENCY_NAMES = ["Can wait", "Normal", "Soon", "Urgent"];
const REASON_NAMES: Record<string, string> = { unsubscribed: "Unsubscribed", bounced: "Hard bounce", complained: "Complained", manual: "Added by a person" };
const SOURCE_NAMES: Record<string, string> = { "partnersinbiz.mailbox": "Mailbox", "partnersinbiz.crm": "CRM", "partnersinbiz.campaigns": "Campaigns" };
const QUESTION_NAMES: Record<string, string> = { category: "Category", urgency: "Urgency", needs_reply: "Needs a reply", phishing: "Suspicious mail", client: "Which client" };
const DRAFT_STATUS: Record<string, string> = { draft: "Draft", queued: "Queued" };
const TECH_ANCHOR = "technical-setup";

/** Where a delegation came from, for the table: the defaults and answered asks are not a person's click. */
function sourceNote(row: { source?: string }): string {
  return row.source === "default" ? " · given automatically" : row.source === "ask" ? " · you approved" : "";
}

/** "5 min ago" for the last day, then "28 Sep" (the year only when it is not this year). */
function whenText(value: string | null | undefined, now: Date = new Date()): string {
  return recentTime(value, now) ?? formatShortDate(value ?? null, now);
}

function Chip({ children, tone: t = "neutral" }: { children: ReactNode; tone?: "neutral" | "warn" | "danger" | "bad" | "ok" | "info" | "accent" }) {
  return <Pill size="sm" tone={t === "danger" ? "bad" : t}>{children}</Pill>;
}

/** Colour for a category in charts (stable per category). */
function categoryFill(category: string): Pick<Segment, "color" | "tone"> {
  const c = categoryColor(category);
  return c === "neutral" ? { tone: "neutral" } : { color: seriesColor(c) };
}

function SortingChips({ row }: { row: InboxMessage }) {
  const urgency = row.urgency == null ? null : Math.max(0, Math.min(3, Math.round(row.urgency)));
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
      {row.category ? <Chip tone={categoryTone(row.category)}>{CATEGORY_NAMES[row.category] ?? row.category}</Chip> : <Chip>Not sorted yet</Chip>}
      {urgency != null && urgency >= 2 ? <Chip tone={urgency === 3 ? "danger" : "warn"}>{URGENCY_NAMES[urgency]}</Chip> : null}
      {row.needs_reply != null && row.needs_reply >= 0.7 ? <Chip tone="warn">Needs reply</Chip> : null}
      {row.phishing != null && row.phishing >= 0.9 ? <Chip tone="danger">Suspicious</Chip> : null}
      {row.client_ref ? <Chip tone="info">{row.client_name || (row.client_kind === "contact" ? "Client (person)" : "Client")}</Chip> : null}
      {row.reply_to ? <Chip>Reply to {row.reply_to.kind}</Chip> : null}
    </div>
  );
}

/** The one flag a phone row shows for a message. */
function mailFlag(row: InboxMessage): ReactNode {
  if (row.phishing != null && row.phishing >= 0.9) return <Chip tone="danger">Suspicious</Chip>;
  const urgency = row.urgency == null ? 0 : Math.round(row.urgency);
  if (urgency >= 3) return <Chip tone="danger">Urgent</Chip>;
  if (row.needs_reply != null && row.needs_reply >= 0.7) return <Chip tone="warn">Needs reply</Chip>;
  return null;
}

function accountBadge(account: Account) {
  const label = account.status === "connected" ? "connected" : account.status === "needs_reconnect" ? "needs reconnect" : account.status === "disconnected" ? "disconnected" : "not connected";
  return <Pill tone={accountTone(account.status)} dot>{label}</Pill>;
}

function sendBadge(status: SendRequest["status"], permanent: boolean) {
  const label = status === "sent" ? "sent" : status === "failed" ? (permanent ? "failed" : "failed, can retry") : status === "retrying" ? "waiting to retry" : "sending";
  return <Pill tone={sendTone(status)} dot>{label}</Pill>;
}

/** Agent names for the company (host `GET /api/companies/:id/agents`), and people names (`/user-directory`). */
function useNames(companyId: string | null | undefined): { agents: NamedAgent[]; people: Map<string, string> } {
  const [agents, setAgents] = useState<NamedAgent[]>([]);
  const [people, setPeople] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!companyId) return;
    let live = true;
    const enc = encodeURIComponent(companyId);
    const list = (body: unknown, key?: string): Array<Record<string, unknown>> => {
      const value = Array.isArray(body) ? body : key && body && typeof body === "object" ? (body as Record<string, unknown>)[key] : (body as { data?: unknown } | null)?.data;
      return Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object") : [];
    };
    fetch(`/api/companies/${enc}/agents`, { credentials: "include" })
      .then(async (res) => (res.ok ? res.json() : []))
      .then((body: unknown) => {
        if (!live) return;
        setAgents(list(body).filter((row) => typeof row.id === "string").map((row) => ({ id: String(row.id), name: typeof row.name === "string" && row.name ? row.name : "An agent", status: typeof row.status === "string" ? row.status : "" })));
      })
      .catch(() => undefined);
    fetch(`/api/companies/${enc}/user-directory`, { credentials: "include" })
      .then(async (res) => (res.ok ? res.json() : {}))
      .then((body: unknown) => {
        if (!live) return;
        const map = new Map<string, string>();
        for (const row of list(body, "users")) {
          const user = (row.user && typeof row.user === "object" ? row.user : row) as Record<string, unknown>;
          const id = typeof user.id === "string" ? user.id : typeof row.principalId === "string" ? row.principalId : null;
          const name = typeof user.name === "string" && user.name ? user.name : typeof user.email === "string" ? user.email : null;
          if (id && name) map.set(id, name);
        }
        setPeople(map);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [companyId]);
  return { agents, people };
}

/** `search` without `key`. Returns "" or "?…". */
function withoutParam(search: string, key: string): string {
  const params = new URLSearchParams(search);
  params.delete(key);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** A small ⋯ menu for secondary and destructive actions. */
function MoreMenu({ label, items }: { label: string; items: Array<{ label: string; onSelect: () => void; danger?: boolean; disabled?: boolean }> }) {
  const shown = items.filter(Boolean);
  if (shown.length === 0) return null;
  return (
    <details style={{ position: "relative" }}>
      <summary
        aria-label={label}
        title={label}
        style={{ listStyle: "none", cursor: "pointer", height: 36, minWidth: 40, padding: "0 10px", borderRadius: 9, border: `1px solid ${tokens.border}`, background: tokens.secondary, color: tokens.secondaryFg, display: "inline-grid", placeItems: "center", fontSize: 16, fontWeight: 700, userSelect: "none" }}
      >
        ⋯
      </summary>
      <div role="menu" style={{ position: "absolute", right: 0, top: 42, zIndex: 30, minWidth: 190, display: "grid", padding: 4, borderRadius: 10, border: `1px solid ${tokens.border}`, background: tokens.card, boxShadow: "0 12px 30px color-mix(in oklab, black 25%, transparent)" }}>
        {shown.map((item) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={(event) => {
              const details = (event.currentTarget as HTMLElement).closest("details");
              if (details) details.open = false;
              item.onSelect();
            }}
            style={{ appearance: "none", border: "none", background: "transparent", textAlign: "left", padding: "9px 10px", minHeight: 40, borderRadius: 7, fontSize: 13, fontFamily: "inherit", cursor: item.disabled ? "not-allowed" : "pointer", color: item.danger ? tone("bad").fg : tokens.fg, opacity: item.disabled ? 0.55 : 1 }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </details>
  );
}

/** "Connect Gmail", disabled with the reason until the one-time technical setup is done. */
function ConnectGmail({ ready, reason, onConnect, onDetails, busy, label = "Connect Gmail", center = false }: {
  ready: boolean;
  reason: string | null;
  onConnect: () => void;
  onDetails: () => void;
  busy?: boolean;
  label?: string;
  center?: boolean;
}) {
  if (ready) return <Button type="button" disabled={busy} onClick={onConnect}>{label}</Button>;
  return (
    <div style={{ display: "grid", gap: 6, justifyItems: center ? "center" : "start", minWidth: 0 }}>
      <Button type="button" disabled title={reason ?? undefined}>{label}</Button>
      <span style={{ fontSize: 12.5, color: tokens.muted, lineHeight: 1.45, textAlign: center ? "center" : "left" }}>
        {reason}{" "}
        <button type="button" onClick={onDetails} style={{ appearance: "none", border: "none", background: "transparent", padding: 0, font: "inherit", color: tokens.primary, fontWeight: 600, cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 2 }}>What is needed</button>
      </span>
    </div>
  );
}

function Facts({ rows }: { rows: Array<[string, ReactNode] | null | false> }) {
  return (
    <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "minmax(84px, auto) minmax(0, 1fr)", gap: "8px 14px", fontSize: 13, lineHeight: 1.45 }}>
      {rows.filter((row): row is [string, ReactNode] => Boolean(row)).map(([term, value]) => (
        <div key={term} style={{ display: "contents" }}>
          <dt style={{ color: tokens.muted }}>{term}</dt>
          <dd style={{ margin: 0, minWidth: 0, overflowWrap: "anywhere" }}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted, lineHeight: 1.45 }}>{children}</p>;
}

/** A subject cell that opens the row's preview. */
function OpenButton({ children, onClick, strong = true }: { children: ReactNode; onClick: () => void; strong?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ appearance: "none", border: "none", background: "transparent", padding: 0, textAlign: "left", font: "inherit", fontWeight: strong ? 600 : 400, color: tokens.fg, cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 3, textDecorationColor: tokens.border, overflowWrap: "anywhere" }}
    >
      {children}
    </button>
  );
}

/** Refresh; just the icon on a phone so the filters beside it keep their room. */
function RefreshButton({ narrow, onClick }: { narrow: boolean; onClick: () => void }) {
  return narrow
    ? <Button type="button" variant="secondary" aria-label="Refresh" title="Refresh" onClick={onClick} style={{ width: 40, padding: 0, display: "inline-grid", placeItems: "center", flexShrink: 0 }}><RefreshCw size={15} aria-hidden="true" /></Button>
    : <Button type="button" variant="secondary" onClick={onClick}>Refresh</Button>;
}

/** Keeps a dropdown, a checkbox and Refresh on one row, even on a phone. */
function OneRow({ children }: { children: ReactNode }) {
  return <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "nowrap", minWidth: 0 }}>{children}</div>;
}

export function MailboxPage({ context }: PluginPageProps) {
  const load = usePluginAction("mailbox.load");
  const connectStart = usePluginAction("mailbox.connect-start");
  const disconnect = usePluginAction("mailbox.disconnect");
  const setDefault = usePluginAction("mailbox.set-default");
  const syncNow = usePluginAction("mailbox.sync-now");
  const loadInbox = usePluginAction("mailbox.inbox");
  const loadSent = usePluginAction("mailbox.sent");
  const retrySend = usePluginAction("mailbox.retry-send");
  const correctTriage = usePluginAction("mailbox.correct-triage");
  const loadStats = usePluginAction("mailbox.triage-stats");
  const sendDraft = usePluginAction("mailbox.send-draft");
  const createAccount = usePluginAction("mailbox.create-account");
  const createDelegation = usePluginAction("mailbox.create-delegation");
  const createDraft = usePluginAction("mailbox.create-draft");
  const removeDelegation = usePluginAction("mailbox.remove-delegation");
  const checkDomain = usePluginAction("mailbox.check-domain");
  const setAccountClient = usePluginAction("mailbox.set-account-client");
  const addClientMap = usePluginAction("mailbox.add-client-map");
  const removeClientMap = usePluginAction("mailbox.remove-client-map");
  const loadCrmClients = usePluginAction("mailbox.crm-clients");

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [inbox, setInbox] = useState<{ messages: InboxMessage[]; clients: ClientOption[] } | null>(null);
  const [sent, setSent] = useState<SendRequest[] | null>(null);
  const [stats, setStats] = useState<TriageStats | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const hostLocation = useHostLocation();
  const hostNavigation = useHostNavigation();
  const narrow = useIsNarrow();
  // `?tab=` opens a tab and switching tabs updates the address, so links can point at a tab.
  const [tab, setTab] = useUrlTab<TabId>(TAB_IDS, "overview", { path: "/mailbox", search: hostLocation.search, navigate: hostNavigation.navigate });
  // "Finish setting up Mailbox" on the overview until its required setup is done.
  const setupStatus = usePluginSetupStatus(PLUGIN_KEY, context.companyId);
  const { agents, people } = useNames(context.companyId);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [needsReplyOnly, setNeedsReplyOnly] = useState(false);
  const [sentStatus, setSentStatus] = useState("");
  const [create, setCreate] = useState<CreateKind>(null);
  const [preview, setPreview] = useState<Preview>(null);
  const [address, setAddress] = useState("");
  const [provider, setProvider] = useState("gmail");
  const [accountId, setAccountId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [canSend, setCanSend] = useState(false);
  const [subject, setSubject] = useState("");
  const [draftTo, setDraftTo] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [correcting, setCorrecting] = useState<InboxMessage | null>(null);
  const [fix, setFix] = useState({ category: "", urgency: "", needsReply: "", client: "" });
  const [domainInput, setDomainInput] = useState("");
  const [domainResult, setDomainResult] = useState<DomainCheckResult | null>(null);
  const [crmClients, setCrmClients] = useState<ClientOption[]>([]);
  const [mapForm, setMapForm] = useState({ matchType: "sender_domain", pattern: "", client: "", note: "" });
  const [bindTarget, setBindTarget] = useState<Account | null>(null);
  const [bindClient, setBindClient] = useState("");

  async function refresh() {
    const uiBase = await resolvePluginUiBase(PLUGIN_KEY, import.meta.url);
    setSnapshot((await load({ uiBase })) as Snapshot);
  }
  async function refreshInbox() {
    setInbox((await loadInbox({ category: category || undefined, needsReply: needsReplyOnly, limit: 150 })) as { messages: InboxMessage[]; clients: ClientOption[] });
  }
  async function refreshSent() {
    setSent(((await loadSent({ status: sentStatus || undefined, limit: 150 })) as { requests: SendRequest[] }).requests);
  }
  async function refreshStats() {
    setStats((await loadStats({ days: 30 })) as TriageStats);
  }

  useEffect(() => {
    if (!context.companyId) return;
    if (new URLSearchParams(window.location.search).get("connected") === "gmail") {
      setMessage("Gmail connected. The first sync runs within two minutes, or click Sync.");
    }
    refresh().catch((error: unknown) => setMessage(errorText(error)));
  }, [context.companyId]);

  useEffect(() => {
    if (!context.companyId) return;
    const work = tab === "inbox" ? refreshInbox : tab === "sent" ? refreshSent : tab === "triage" ? refreshStats : null;
    work?.().catch((error: unknown) => setMessage(errorText(error)));
  }, [context.companyId, tab, category, needsReplyOnly, sentStatus]);

  async function run(work: () => Promise<unknown>, success: string) {
    setMessage("");
    setBusy(true);
    try {
      await work();
      await refresh();
      if (tab === "inbox") await refreshInbox();
      if (tab === "sent") await refreshSent();
      setMessage(success);
      setCreate(null);
      setPreview(null);
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  function removeAccess(row: Delegation) {
    const who = agentName(row.agent_id);
    if (!window.confirm(`Remove ${who}'s access to ${addressOf(row.account_id)}? It will not be given back automatically; only you can give it again.`)) return;
    void run(() => removeDelegation({ accountId: row.account_id, agentId: row.agent_id }), `${who}'s access was removed`);
  }
  async function ensureClients() {
    if (crmClients.length > 0) return;
    try {
      setCrmClients(((await loadCrmClients({})) as { clients: ClientOption[] }).clients);
    } catch (error) {
      setMessage(errorText(error));
    }
  }
  async function openBind(account: Account) {
    setBindTarget(account);
    setBindClient("");
    setCreate("account-client");
    await ensureClients();
  }
  async function openMapping(prefill?: { matchType: string; pattern: string }) {
    setMapForm({ matchType: prefill?.matchType ?? "sender_domain", pattern: prefill?.pattern ?? "", client: "", note: "" });
    setPreview(null);
    setCreate("client-map");
    await ensureClients();
  }
  async function runDomainCheck(domain: string) {
    setMessage("");
    setBusy(true);
    try {
      setDomainResult((await checkDomain({ domain })) as DomainCheckResult);
      await refresh();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  const settings = snapshot?.settings;
  const readiness = connectReadiness(settings);
  const missing = missingTechnical(settings);

  /** Shows the one-time technical setup (Mailboxes tab). */
  function showTechnical() {
    setTab("mailboxes");
    window.setTimeout(() => document.getElementById(TECH_ANCHOR)?.scrollIntoView({ behavior: "smooth", block: "start" }), 120);
  }

  async function connect(loginHint?: string) {
    if (!readiness.ready) {
      setMessage(`Gmail can't be connected yet. ${readiness.reason ?? ""}`.trim());
      showTechnical();
      return;
    }
    setMessage("");
    try {
      const params = new URLSearchParams(window.location.search);
      params.delete("connect");
      params.set("connected", "gmail");
      const returnTo = `${window.location.pathname}?${params.toString()}`;
      const result = (await connectStart({ returnTo, loginHint })) as { authorizeUrl: string; state: string };
      rememberOAuthStart(result.state, {
        companyId: context.companyId ?? "",
        completeUrl: `/api/plugins/${PLUGIN_KEY}/api/oauth/complete`,
        returnTo,
        label: "Gmail",
      });
      window.location.assign(result.authorizeUrl);
    } catch (error) {
      setMessage(errorText(error));
    }
  }

  // `?connect=gmail` (the setup step and other modules link here) starts the Google sign-in once the settings are known.
  const wantsConnect = new URLSearchParams(hostLocation.search).get("connect") === "gmail";
  useEffect(() => {
    if (!wantsConnect || !snapshot) return;
    // One navigation takes the ask off the address (so a reload or the way back from Google does not
    // start it again) and, when Gmail cannot be connected yet, opens the tab with the technical setup.
    const params = new URLSearchParams(withoutParam(hostLocation.search, "connect"));
    if (!readiness.ready) params.set("tab", "mailboxes");
    const text = params.toString();
    hostNavigation.navigate(`/mailbox${text ? `?${text}` : ""}`, { replace: true });
    if (readiness.ready) {
      void connect();
      return;
    }
    setMessage(`Gmail can't be connected yet. ${readiness.reason ?? ""}`.trim());
    window.setTimeout(() => document.getElementById(TECH_ANCHOR)?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsConnect, snapshot]);

  /** Setup links: "Connect Gmail" does the step here instead of reopening this page. */
  const linkFor = (href: string): Record<string, unknown> => {
    if (href.startsWith("/mailbox") && href.includes("connect=gmail")) {
      return {
        href: hostNavigation.resolveHref(href),
        onClick: (event: ReactMouseEvent<HTMLAnchorElement>) => {
          event.preventDefault();
          void connect();
        },
      };
    }
    return hostNavigation.linkProps(href) as unknown as Record<string, unknown>;
  };

  const accounts = snapshot?.accounts ?? [];
  const gmailAccounts = accounts.filter((a) => a.status !== "manual" || a.has_credential);
  const otherMailboxes = accounts.filter((a) => a.status === "manual" && !a.has_credential);
  const connectedCount = gmailAccounts.filter((a) => a.status === "connected").length;
  const gmailProblem = gmailAccounts.length === 0 || gmailAccounts.some((a) => a.status !== "connected" || Boolean(a.last_error));
  const q = search.trim().toLowerCase();
  const inboxRows = useMemo(
    () =>
      (inbox?.messages ?? []).filter(
        (row) => !q || row.subject.toLowerCase().includes(q) || (row.from?.email ?? "").includes(q) || (row.from?.name ?? "").toLowerCase().includes(q),
      ),
    [inbox, q],
  );
  const allDrafts = useMemo(() => (snapshot?.messages ?? []).filter((row) => row.direction === "outbound"), [snapshot]);
  const drafts = useMemo(() => allDrafts.filter((row) => !q || row.subject.toLowerCase().includes(q) || draftRecipients(row).join(" ").toLowerCase().includes(q)), [allDrafts, q]);
  const failedSends = (snapshot?.sendCounts.failed ?? 0) + (snapshot?.sendCounts.retrying ?? 0);
  const reconnects = accounts.filter((a) => a.status === "needs_reconnect").length;
  const hasData = Boolean(snapshot && (accounts.length || allDrafts.length || snapshot.unreadCount || Object.keys(snapshot.sendCounts).length || Object.keys(snapshot.categoryCounts).length));
  const agentName = (id: string) => agents.find((agent) => agent.id === id)?.name ?? "An agent that was removed";
  const drafterName = (by: Draft["drafted_by"]) => !by ? "Not recorded" : by.kind === "agent" ? agentName(by.id) : by.id === context.userId ? "You" : people.get(by.id) ?? "A person";
  const addressOf = (id: string) => accounts.find((account) => account.id === id)?.address ?? "A removed mailbox";

  const now = new Date();
  const received = receivedColumns(snapshot?.daily, now, 14);
  const sends = sendColumns(snapshot?.daily, now, 14);
  const categories = categorySegments(snapshot?.categoryCounts).map((c) => ({ ...c, ...(c.key === "rest" ? {} : categoryFill(c.key ?? "")) }));

  const connectButton = (center = false, label?: string) => (
    <ConnectGmail ready={readiness.ready} reason={readiness.reason} busy={busy} onConnect={() => void connect()} onDetails={showTechnical} center={center} label={label} />
  );

  const gmailSection = (
    <SectionCard
      title="Gmail"
      subtitle={gmailAccounts.length ? `${connectedCount} of ${gmailAccounts.length} connected · synced every 2 minutes` : "Not connected yet: mail can't sync or send."}
      icon={Mail}
      tone={gmailAccounts.some((a) => a.status === "needs_reconnect") ? "bad" : gmailAccounts.length === 0 ? "warn" : undefined}
      strip={gmailAccounts.length === 0 || gmailAccounts.some((a) => a.status === "needs_reconnect")}
    >
      {gmailAccounts.length === 0 ? (
        <EmptyState
          compact
          icon={Mail}
          title="No Gmail account connected"
          description="Connect the Gmail account that sends invoices and receives client mail. You sign in with that Google account."
          action={connectButton(true)}
        />
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {gmailAccounts.map((account) => {
            const bad = accountTone(account.status) === "bad";
            return (
              <div
                key={account.id}
                style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", padding: "10px 12px", border: `1px solid ${bad ? tone("bad").border : tokens.border}`, background: bad ? tone("bad").soft : "transparent", borderRadius: 10, minWidth: 0 }}
              >
                <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0, flex: "1 1 240px" }}>
                  <IconBadge icon={Mail} accent={tone(account.status === "connected" ? "accent" : accountTone(account.status))} size="sm" />
                  <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
                      <StatusDot tone={accountTone(account.status, account.last_error)} pulse={account.status === "connected" && isSyncing(account.last_sync_at, now)} halo label={account.status === "connected" ? (isSyncing(account.last_sync_at, now) ? "Syncing" : "Connected") : account.status.replace(/_/g, " ")} />
                      <strong style={{ fontSize: 14, minWidth: 0, ...breakAnywhere }}>{account.address}</strong>
                      {accountBadge(account)}
                      {account.is_default ? <Chip tone="info">Sends for all modules</Chip> : null}
                      {account.client_ref ? <Chip tone="accent">Client mailbox: {account.from_name || account.client_ref}</Chip> : null}
                    </div>
                    <span style={{ fontSize: 12, color: tokens.muted }}>
                      Last sync {whenText(account.last_sync_at, now)}
                      {account.sync_stats?.stored ? ` · ${account.sync_stats.stored} new` : ""}
                    </span>
                    {account.last_error ? <span style={{ fontSize: 12, color: tone("bad").fg, overflowWrap: "anywhere" }}>{account.last_error}</span> : null}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  {account.status !== "connected"
                    ? <Button type="button" disabled={busy || !readiness.ready} title={readiness.reason ?? undefined} onClick={() => void connect(account.address)}>Reconnect</Button>
                    : <Button type="button" variant="secondary" disabled={busy} onClick={() => void run(() => syncNow({ accountId: account.id }), "Sync finished")}>Sync</Button>}
                  <MoreMenu
                    label={`More for ${account.address}`}
                    items={[
                      ...(account.status === "connected" && !account.is_default && !account.client_ref
                        ? [{ label: "Send all module mail from here", onSelect: () => void run(() => setDefault({ accountId: account.id }), `${account.address} now sends for all modules`) }]
                        : []),
                      ...(account.client_ref
                        ? [{ label: "Make it the company's mailbox again", onSelect: () => void run(() => setAccountClient({ accountId: account.id }), `${account.address} is the company's again`) }]
                        : account.has_credential
                          ? [{ label: "Give it to a client…", onSelect: () => void openBind(account) }]
                          : []),
                      ...(account.status !== "disconnected" && account.has_credential
                        ? [{
                          label: "Disconnect",
                          danger: true,
                          onSelect: () => {
                            if (window.confirm(`Disconnect ${account.address}? Plugins will not be able to send from it until it is connected again.`)) {
                              void run(() => disconnect({ accountId: account.id }), `${account.address} disconnected`);
                            }
                          },
                        }]
                        : []),
                    ]}
                  />
                </div>
              </div>
            );
          })}
          {connectedCount > 0 ? (
            <div>
              <Button type="button" variant="secondary" disabled={busy || !readiness.ready} onClick={() => void connect()}>Connect another Gmail account</Button>
            </div>
          ) : null}
        </div>
      )}
    </SectionCard>
  );

  const technicalRows: Array<{ name: string; field?: string; done: boolean; optional?: boolean; text: ReactNode }> = [
    { name: "Settings saved for this company", done: Boolean(settings?.saved), text: "Saving once lets the Gmail sync run for this company." },
    { name: "Web address of Paperclip", field: "Public base URL", done: Boolean(settings?.publicBaseUrl), text: "The address people use to open Paperclip. Google sends people back there after they sign in." },
    { name: "Key that locks stored Gmail sign-ins", field: "Token encryption key", done: Boolean(settings?.encryptionKey), text: "A Paperclip secret of 16 or more random characters. Changing it later means connecting Gmail again." },
    { name: "Google app secret", field: "Google OAuth client → Client secret", done: Boolean(settings?.googleClientSecret), text: "The secret of the Google Cloud web app that asks for Gmail access." },
    { name: "Smart sorting", done: Boolean(settings?.jev), optional: true, text: "Sorts new mail more accurately and matches it to clients, using an API key from the smart sorting service. Without it, built-in rules sort the mail." },
    { name: "Private file storage", field: "Private attachment storage (Cloudflare R2)", done: Boolean(settings?.r2), optional: true, text: "Lets agents open PDF and image attachments, such as bank statements. Text files work without it." },
  ];
  const technicalSection = (
    <SectionCard
      id={TECH_ANCHOR}
      title="One-time technical setup (admin)"
      subtitle={missing.length || !settings?.saved
        ? "Needed once before Gmail can be connected. An admin does this in the Mailbox settings; nobody else needs to."
        : "Done. An admin only comes back here to change the Google app or the optional extras."}
      icon={SettingsIcon}
      tone={missing.length || !settings?.saved ? "warn" : undefined}
      actions={settings?.href ? <a {...hostNavigation.linkProps(settings.href)} style={{ fontSize: 13, fontWeight: 600, color: tokens.primary, whiteSpace: "nowrap" }}>Open settings →</a> : undefined}
    >
      <details open={Boolean(missing.length || (settings && !settings.saved))}>
        <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>{missing.length ? `Still needed: ${missing.length} of 3 required settings` : "What was set up"}</summary>
        <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0, display: "grid", gap: 10 }}>
          {technicalRows.map((row) => (
            <li key={row.name} style={{ display: "grid", gap: 3, paddingBottom: 10, borderBottom: `1px solid ${tokens.border}`, minWidth: 0 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
                <strong style={{ fontSize: 13, fontWeight: 600 }}>{row.name}{row.optional ? <span style={{ color: tokens.muted, fontWeight: 500 }}> (optional)</span> : null}</strong>
                <Pill size="sm" tone={row.done ? "ok" : row.optional ? "neutral" : "warn"} dot>{row.done ? "Set" : row.optional ? "Off" : "Missing"}</Pill>
              </div>
              <span style={{ fontSize: 12.5, color: tokens.muted, lineHeight: 1.45 }}>{row.text}</span>
              {row.field ? <span style={{ fontSize: 12, color: tokens.muted }}>In the settings: <code style={{ fontSize: "0.95em" }}>{row.field}</code></span> : null}
            </li>
          ))}
          <li style={{ display: "grid", gap: 4, minWidth: 0 }}>
            <strong style={{ fontSize: 13, fontWeight: 600 }}>Google redirect address</strong>
            {settings?.redirectUri ? (
              <>
                <span style={{ fontSize: 12.5, color: tokens.muted, lineHeight: 1.45 }}>In Google Cloud → APIs &amp; Services → Credentials → the web app, add this under Authorised redirect URIs:</span>
                <code style={{ fontSize: 12, padding: "6px 8px", borderRadius: 6, background: tokens.secondary, ...breakAnywhere }}>{settings.redirectUri}</code>
              </>
            ) : <span style={{ fontSize: 12.5, color: tokens.muted }}>Shown here once the web address of Paperclip is set.</span>}
          </li>
        </ul>
      </details>
    </SectionCard>
  );

  function openCorrection(row: InboxMessage) {
    setPreview(null);
    setCorrecting(row);
    setFix({ category: row.category ?? "", urgency: "", needsReply: "", client: "" });
  }

  const previewDraft = preview?.kind === "draft" ? allDrafts.find((row) => row.id === preview.id) ?? null : null;
  const previewMail = preview?.kind === "mail" ? (inbox?.messages ?? []).find((row) => row.id === preview.id) ?? null : null;
  const previewSend = preview?.kind === "send" ? (sent ?? []).find((row) => row.key === preview.key) ?? null : null;
  const draftBlock = previewDraft ? sendBlock(previewDraft, accounts) : null;
  const newDraftButton = <Button type="button" onClick={() => setCreate("draft")}>+ New draft</Button>;
  // Header actions follow the open tab; most tabs keep their one action in their own content.
  const headerAction = tab === "drafts" && allDrafts.length > 0 ? newDraftButton : undefined;

  function sendCell(draft: Draft): ReactNode {
    if (draft.status !== "draft") return null;
    const block = sendBlock(draft, accounts);
    return (
      <div style={{ display: "grid", gap: 3, justifyItems: "start" }}>
        <Button type="button" disabled={busy || Boolean(block)} title={block ?? undefined} style={{ height: 30, fontSize: 12.5 }} onClick={() => void run(() => sendDraft({ messageId: draft.id }), "Draft sent")}>Send</Button>
        {block ? <span style={{ fontSize: 11.5, color: tokens.muted, lineHeight: 1.35 }}>{block}</span> : null}
      </div>
    );
  }

  return (
    <Page
      accent="mailbox"
      title="Mailbox"
      description="The company's Gmail. Invoices, reminders and payslips go out through it, and new mail is sorted and labelled."
      message={message}
      actions={headerAction}
    >
      <ModuleOffBanner companyId={context.companyId} pluginKey={PLUGIN_KEY} />

      <Tabs
        tabs={[
          { id: "overview", label: "Overview", icon: LayoutDashboard },
          { id: "inbox", label: "Inbox", icon: Inbox, count: snapshot?.unreadCount || null, countTone: snapshot?.unreadCount ? "warn" : undefined },
          { id: "sent", label: "Sent", icon: Send, count: failedSends || null, countTone: failedSends ? "bad" : undefined },
          { id: "drafts", label: "Drafts", icon: FileText, count: allDrafts.filter((row) => row.status === "draft").length || null, countTone: "warn" },
          { id: "mailboxes", label: "Mailboxes", icon: Mail, count: reconnects || null, countTone: reconnects ? "bad" : undefined },
          { id: "triage", label: "Sorting", icon: Sparkles },
        ]}
        active={tab}
        onChange={(id) => { setTab(id as TabId); setSearch(""); }}
      />

      {tab === "overview" ? <GetStarted status={setupStatus} hasData={hasData} moduleName="Mailbox" linkFor={linkFor} /> : null}
      {tab === "overview" ? (
        <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
          {snapshot && gmailProblem ? gmailSection : null}
          <div style={{ display: "grid", gap: 10, gridTemplateColumns: fluidColumns(150), minWidth: 0 }}>
            <KpiCard label="Unread" value={snapshot?.unreadCount ?? 0} icon={Inbox} tone={(snapshot?.unreadCount ?? 0) > 0 ? "warn" : undefined} hint={(snapshot?.unreadCount ?? 0) > 0 ? "Open the inbox" : "All read"} link={(snapshot?.unreadCount ?? 0) > 0 ? (hostNavigation.linkProps("/mailbox?tab=inbox") as never) : null} />
            <KpiCard label="Received (14 days)" value={received.total} icon={Mail} sparkline={received.total ? received.totals : undefined} hint={received.total ? undefined : "No mail yet"} />
            <KpiCard label="Sent (30 days)" value={snapshot?.sendCounts.sent ?? 0} icon={MailCheck} sparkline={sends.sent ? sends.sentPerDay : undefined} hint="Invoices, reminders, payslips…" />
            <KpiCard label="Failed or waiting" value={failedSends} icon={CircleAlert} tone={failedSends ? "bad" : undefined} hint={failedSends ? "Retry them on the Sent tab" : "Nothing stuck"} link={failedSends ? (hostNavigation.linkProps("/mailbox?tab=sent") as never) : null} />
            <KpiCard label="Leads (30 days)" value={snapshot?.categoryCounts.lead ?? 0} icon={Sparkles} hint="Sorted as a lead" />
          </div>
          <div style={{ display: "grid", gap: 16, gridTemplateColumns: fluidColumns(360), minWidth: 0 }}>
            <SectionCard style={{ alignContent: "start" }} title="Mail received per day" subtitle="New mail by category, last 14 days" icon={ChartColumn}>
              {received.total ? (
                <BarChart
                  data={received.data}
                  series={received.series.map((sr) => ({ key: sr.key, label: sr.label, ...(sr.colorIndex === "neutral" ? { tone: "neutral" as const } : { color: seriesColor(sr.colorIndex) }) }))}
                  unit="emails"
                  title="Mail received per day"
                  height={120}
                />
              ) : <EmptyState compact icon={Inbox} title="No mail in 14 days" description={gmailAccounts.length ? "New mail shows up after the next sync." : "Mail shows up here once Gmail is connected."} />}
            </SectionCard>
            <SectionCard style={{ alignContent: "start" }} title="Categories" subtitle="How new mail was sorted, last 30 days" icon={ChartPie}>
              {categories.length ? (
                <DonutChart title="Mail by category, 30 days" segments={categories} centerValue={categories.reduce((n, c) => n + c.value, 0)} centerLabel="emails" />
              ) : <EmptyState compact icon={Sparkles} title="Nothing sorted yet" description="Each new email gets a category, urgency and client." />}
            </SectionCard>
          </div>
          <SectionCard title="Sent vs failed per day" subtitle={`Mail the modules sent, last 14 days${sends.failed ? ` · ${sends.failed} failed or waiting` : ""}`} icon={Send} tone={sends.failed ? "bad" : undefined}>
            {sends.totals.some((n) => n > 0) ? (
              <BarChart data={sends.data} series={SEND_SERIES} unit="emails" title="Send requests per day" height={96} />
            ) : <EmptyState compact icon={Send} title="Nothing sent in 14 days" description="Invoices, reminders, payslips and campaigns go out through this mailbox." />}
          </SectionCard>
          {snapshot && !gmailProblem ? gmailSection : null}
        </div>
      ) : null}

      {tab === "inbox" ? (
        <div style={{ display: "grid", gap: 12 }}>
          <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search subject or sender…">
            <OneRow>
              <Select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Category" style={{ maxWidth: narrow ? 160 : undefined }}>
                <option value="">All categories</option>
                {(snapshot?.categories ?? Object.keys(CATEGORY_NAMES)).map((c) => <option key={c} value={c}>{CATEGORY_NAMES[c] ?? c}</option>)}
              </Select>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, whiteSpace: "nowrap" }}>
                <input type="checkbox" checked={needsReplyOnly} onChange={(event) => setNeedsReplyOnly(event.target.checked)} />
                Needs reply
              </label>
              <RefreshButton narrow={narrow} onClick={() => void refreshInbox().catch((error: unknown) => setMessage(errorText(error)))} />
            </OneRow>
          </Toolbar>
          {inboxRows.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title="No mail here"
              description={gmailAccounts.length === 0 ? "Connect Gmail to see new mail here." : q || category || needsReplyOnly ? "Nothing matches these filters." : "New mail shows up after the next sync."}
              action={gmailAccounts.length === 0 ? connectButton(true) : undefined}
            />
          ) : narrow ? (
            <CompactRows
              label="Inbox"
              rows={inboxRows}
              title={(row) => `${row.is_read ? "" : "● "}${row.subject || "(no subject)"}`}
              meta={(row) => [row.from ? row.from.name || row.from.email : null, row.category ? CATEGORY_NAMES[row.category] ?? row.category : "Not sorted yet", whenText(row.received_at ?? row.created_at, now)].filter(Boolean).join(" · ")}
              trailing={mailFlag}
              onOpen={(row) => setPreview({ kind: "mail", id: row.id })}
              empty="No mail matches."
            />
          ) : (
            <DataTable
              columns={[
                { key: "received", header: "Received", width: "96px" },
                { key: "sender", header: "From", width: "20%" },
                {
                  key: "subject",
                  header: "Subject",
                  render: (_value, row) => {
                    const m = row as unknown as InboxMessage;
                    return (
                      <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
                        <OpenButton strong={!m.is_read} onClick={() => setPreview({ kind: "mail", id: m.id })}>{m.subject || "(no subject)"}{m.attachments.length ? ` · ${m.attachments.length} file${m.attachments.length === 1 ? "" : "s"}` : ""}</OpenButton>
                        <span style={{ fontSize: 12, color: tokens.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "min(420px, 100%)" }}>{m.snippet}</span>
                      </div>
                    );
                  },
                },
                { key: "sorting", header: "Sorted as", render: (_value, row) => <SortingChips row={row as unknown as InboxMessage} /> },
                {
                  key: "fix",
                  header: "",
                  width: "104px",
                  render: (_value, row) => <Button type="button" variant="secondary" style={{ height: 30, fontSize: 12.5 }} onClick={() => openCorrection(row as unknown as InboxMessage)}>Fix sorting</Button>,
                },
              ]}
              rows={inboxRows.map((row) => ({
                ...row,
                received: whenText(row.received_at ?? row.created_at, now),
                sender: row.from ? row.from.name || row.from.email : "–",
              })) as unknown as Record<string, unknown>[]}
              emptyMessage="No mail matches."
            />
          )}
        </div>
      ) : null}

      {tab === "sent" ? (
        <div style={{ display: "grid", gap: 12 }}>
          <Toolbar>
            <OneRow>
              <Select value={sentStatus} onChange={(event) => setSentStatus(event.target.value)} aria-label="Status">
                <option value="">All</option>
                <option value="sent">Sent</option>
                <option value="failed">Failed</option>
                <option value="retrying">Waiting to retry</option>
                <option value="sending">Sending</option>
              </Select>
              <RefreshButton narrow={narrow} onClick={() => void refreshSent().catch((error: unknown) => setMessage(errorText(error)))} />
            </OneRow>
          </Toolbar>
          {(sent ?? []).length === 0 ? (
            <EmptyState
              icon={Send}
              title={sentStatus ? "Nothing with this status" : "Nothing sent yet"}
              description={gmailAccounts.length === 0 ? "Mail the modules send (invoices, reminders, payslips, campaigns) shows up here once Gmail is connected." : "Mail the modules send (invoices, reminders, payslips, campaigns) is listed here."}
              action={gmailAccounts.length === 0 && !sentStatus ? connectButton(true) : undefined}
            />
          ) : narrow ? (
            <CompactRows
              label="Sent mail"
              rows={sent ?? []}
              rowKey={(row) => row.key}
              title={(row) => row.subject || "(no subject)"}
              meta={(row) => [row.to.join(", ") || "No recipient", sentBy(row), whenText(row.sentAt ?? row.createdAt, now)].join(" · ")}
              trailing={(row) => sendBadge(row.status, row.permanent)}
              onOpen={(row) => setPreview({ kind: "send", key: row.key })}
              empty="Nothing matches."
            />
          ) : (
            <DataTable
              columns={[
                { key: "when", header: "When", width: "96px" },
                { key: "toText", header: "To", width: "20%", render: (value) => <span style={{ overflowWrap: "anywhere" }}>{String(value)}</span> },
                { key: "subject", header: "Subject", render: (value, row) => <OpenButton strong={false} onClick={() => setPreview({ kind: "send", key: String(row.id) })}>{String(value) || "(no subject)"}</OpenButton> },
                { key: "source", header: "Sent by", width: "160px" },
                {
                  key: "status",
                  header: "Status",
                  render: (_value, row) => {
                    const r = row as unknown as SendRequest;
                    return (
                      <div style={{ display: "grid", gap: 3 }}>
                        <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
                          {sendBadge(r.status, r.permanent)}
                          {r.marketing ? <Chip tone="info">Marketing</Chip> : null}
                        </span>
                        {r.error && r.status !== "sent" ? <span style={{ fontSize: 11, color: tokens.muted, overflowWrap: "anywhere" }}>{r.error}</span> : null}
                        {r.status === "sent" && r.skipped?.length ? (
                          <span style={{ fontSize: 11, color: tokens.muted, overflowWrap: "anywhere" }}>Left out (do not email): {r.skipped.map((entry) => entry.email).join(", ")}</span>
                        ) : null}
                      </div>
                    );
                  },
                },
                {
                  key: "retry",
                  header: "",
                  width: "80px",
                  render: (_value, row) => {
                    const r = row as unknown as SendRequest;
                    return r.status === "failed" || r.status === "retrying" ? (
                      <Button type="button" variant="secondary" disabled={busy} style={{ height: 30, fontSize: 12.5 }} onClick={() => void run(() => retrySend({ key: r.key }), "Sent again")}>Retry</Button>
                    ) : null;
                  },
                },
              ]}
              rows={(sent ?? []).map((row) => ({
                ...row,
                id: row.key,
                when: whenText(row.sentAt ?? row.createdAt, now),
                toText: row.to.join(", ") || "–",
                source: sentBy(row),
              })) as unknown as Record<string, unknown>[]}
              emptyMessage="Nothing matches."
            />
          )}
          <SectionCard
            title="Do not email"
            subtitle={(snapshot?.suppressions ?? []).length
              ? "Unsubscribes skip campaigns and sequences; hard bounces skip every email. Shared with the CRM and Campaigns."
              : "Nobody yet. A reply of STOP or unsubscribe, or a hard bounce, adds the address here."}
            icon={CircleAlert}
          >
            {(snapshot?.suppressions ?? []).length === 0 ? null : narrow ? (
              <CompactRows
                label="Do not email"
                rows={snapshot?.suppressions ?? []}
                rowKey={(row) => row.email}
                title={(row) => row.email}
                meta={(row) => `${REASON_NAMES[row.reason] ?? row.reason} · stops ${row.scope === "all" ? "all email" : "marketing email"} · ${whenText(row.at, now)}`}
              />
            ) : (
              <DataTable
                columns={[
                  { key: "email", header: "Address", render: (value) => <span style={{ overflowWrap: "anywhere" }}>{String(value)}</span> },
                  { key: "reasonText", header: "Why", render: (value, row) => <Chip tone={(row as unknown as Suppression).scope === "all" ? "bad" : "warn"}>{String(value)}</Chip> },
                  { key: "scopeText", header: "Stops" },
                  { key: "sourceText", header: "Found by", width: "110px" },
                  { key: "when", header: "When", width: "96px" },
                ]}
                rows={(snapshot?.suppressions ?? []).map((row) => ({
                  ...row,
                  id: row.email,
                  reasonText: REASON_NAMES[row.reason] ?? row.reason,
                  scopeText: row.scope === "all" ? "All email" : "Marketing email",
                  sourceText: SOURCE_NAMES[row.source] ?? row.source.replace(/^partnersinbiz\./, ""),
                  when: whenText(row.at, now),
                })) as unknown as Record<string, unknown>[]}
                emptyMessage="Nobody on the list."
              />
            )}
          </SectionCard>
        </div>
      ) : null}

      {tab === "drafts" ? (
        <div style={{ display: "grid", gap: 12 }}>
          {allDrafts.length > 3 ? <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search drafts…" /> : null}
          {allDrafts.length === 0 ? (
            <EmptyState icon={FileText} title="No drafts yet" description="Agents save drafts on the mailboxes they may use; a person reviews and sends them here. You can also write one." action={newDraftButton} />
          ) : narrow ? (
            <CompactRows
              label="Drafts"
              rows={drafts}
              title={(row) => row.subject || "(no subject)"}
              meta={(row) => [draftRecipients(row).length ? `To ${draftRecipients(row).join(", ")}` : null, row.drafted_by ? `By ${drafterName(row.drafted_by)}` : null, row.created_at ? `Saved ${whenText(row.created_at, now)}` : null].filter(Boolean).join(" · ")}
              trailing={(row) => draftRecipients(row).length === 0 ? <Chip tone="warn">No recipient</Chip> : <Pill size="sm" tone={draftTone(row.status)} dot>{DRAFT_STATUS[row.status] ?? row.status}</Pill>}
              onOpen={(row) => setPreview({ kind: "draft", id: row.id })}
              empty="No drafts match."
            />
          ) : (
            <DataTable
              columns={[
                { key: "subject", header: "Subject", render: (value, row) => {
                  const d = row as unknown as Draft;
                  return (
                    <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
                      <OpenButton onClick={() => setPreview({ kind: "draft", id: d.id })}>{String(value) || "(no subject)"}</OpenButton>
                      {d.is_reply ? <span style={{ fontSize: 12, color: tokens.muted }}>Reply in a thread</span> : null}
                    </div>
                  );
                } },
                { key: "toText", header: "To", render: (value) => value ? <span style={{ overflowWrap: "anywhere" }}>{String(value)}</span> : <Chip tone="warn">No recipient</Chip> },
                { key: "by", header: "Drafted by", width: "150px" },
                { key: "saved", header: "Saved", width: "90px" },
                { key: "status", header: "Status", width: "140px", render: (value, row) => (
                  <div style={{ display: "grid", gap: 3 }}>
                    <Pill tone={draftTone(String(value))} dot>{DRAFT_STATUS[String(value)] ?? String(value)}</Pill>
                    {(row as unknown as Draft).send_error ? <span style={{ fontSize: 11, color: tokens.muted, overflowWrap: "anywhere" }}>{(row as unknown as Draft).send_error}</span> : null}
                  </div>
                ) },
                { key: "send", header: "", width: "170px", render: (_value, row) => sendCell(row as unknown as Draft) },
              ]}
              rows={drafts.map((row) => ({
                ...row,
                toText: draftRecipients(row).join(", "),
                by: drafterName(row.drafted_by),
                saved: row.created_at ? whenText(row.created_at, now) : "–",
              })) as unknown as Record<string, unknown>[]}
              emptyMessage="No drafts match."
            />
          )}
        </div>
      ) : null}

      {tab === "mailboxes" ? (
        <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
          {gmailSection}
          <SectionCard
            title="Agents with access"
            subtitle="Agents read and draft mail on the mailboxes you give them. Sending stays with a person unless you allow it."
            icon={Bot}
            actions={accounts.length ? <Button type="button" variant={connectedCount && !(snapshot?.delegations ?? []).length ? "primary" : "secondary"} onClick={() => setCreate("delegation")}>Give an agent access</Button> : undefined}
          >
            {(snapshot?.delegations ?? []).length === 0 ? (
              <Muted>{accounts.length ? "No agent has access yet. The Operator gets read and draft access on the company's own mailboxes by itself; an agent that asks and is answered yes gets it too." : "Connect Gmail first, then give agents access."}</Muted>
            ) : narrow ? (
              <CompactRows
                label="Agents with access"
                rows={snapshot?.delegations ?? []}
                title={(row) => agentName(row.agent_id)}
                meta={(row) => `${addressOf(row.account_id)}${sourceNote(row)}`}
                trailing={(row) => (
                  <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                    <Pill size="sm" tone={row.can_send ? "ok" : "neutral"} dot>{row.can_send ? "Can send" : row.can_draft === false ? "Read only" : "Read and draft"}</Pill>
                    <Button type="button" variant="secondary" disabled={busy} style={{ height: 28, fontSize: 12 }} onClick={() => void removeAccess(row)}>Remove</Button>
                  </span>
                )}
              />
            ) : (
              <DataTable
                columns={[
                  { key: "agent", header: "Agent" },
                  { key: "account", header: "Mailbox", render: (value) => <span style={{ overflowWrap: "anywhere" }}>{String(value)}</span> },
                  { key: "send", header: "May", render: (value, row) => <Pill tone={(row as unknown as Delegation).can_send ? "ok" : "neutral"} dot>{String(value)}</Pill> },
                  { key: "id", header: "", render: (_value, row) => <Button type="button" variant="secondary" disabled={busy} style={{ height: 28, fontSize: 12 }} onClick={() => void removeAccess(row as unknown as Delegation)}>Remove</Button> },
                ]}
                rows={(snapshot?.delegations ?? []).map((delegation) => ({
                  ...delegation,
                  agent: agentName(delegation.agent_id),
                  account: addressOf(delegation.account_id),
                  send: `${delegation.can_send ? "Read, draft and send" : delegation.can_draft === false ? "Read only" : "Read and draft"}${sourceNote(delegation)}`,
                }))}
                emptyMessage="No agent has access yet."
              />
            )}
          </SectionCard>
          <SectionCard
            id="sender-domains"
            title="Sender domains"
            subtitle="SPF, DKIM and DMARC of each domain mail is sent from, checked every day. Nothing is blocked; a domain should be healthy before a campaign goes out from it."
            icon={MailCheck}
            tone={(snapshot?.domains ?? []).some((row) => row.status === "bad") ? "bad" : (snapshot?.domains ?? []).some((row) => row.status === "warn") ? "warn" : undefined}
            actions={<Button type="button" variant="secondary" onClick={() => { setDomainResult(null); setDomainInput(""); setCreate("domain"); }}>Check a domain</Button>}
          >
            {(snapshot?.domains ?? []).length === 0 ? (
              <Muted>Nothing checked yet. A domain is added when a mailbox on it is connected, or when you check one. For a new client's domain, check it here to see exactly which DNS records to add.</Muted>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {(snapshot?.domains ?? []).map((row) => (
                  <div key={row.domain} style={{ display: "grid", gap: 6, padding: "10px 12px", border: `1px solid ${row.status === "bad" ? tone("bad").border : tokens.border}`, borderRadius: 10, minWidth: 0 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
                        <strong style={{ fontSize: 14, ...breakAnywhere }}>{row.domain}</strong>
                        <Pill size="sm" tone={domainTone(row.status)} dot>{domainStatusLabel(row.status)}</Pill>
                        {row.sendReady ? <Chip tone="ok">Ready for campaigns</Chip> : null}
                      </div>
                      <Button type="button" variant="secondary" disabled={busy} onClick={() => void runDomainCheck(row.domain)}>Check now</Button>
                    </div>
                    <span style={{ fontSize: 12, color: tokens.muted }}>{domainFacts(row)} · checked {whenText(row.checkedAt, now)}</span>
                    {row.problems.filter((problem) => problem.severity !== "info").slice(0, 3).map((problem) => (
                      <div key={problem.message} style={{ fontSize: 12.5, lineHeight: 1.45, overflowWrap: "anywhere" }}>
                        <span style={{ color: problem.severity === "bad" ? tone("bad").fg : tokens.fg }}>{problem.message}</span>
                        <span style={{ color: tokens.muted }}> {problem.fix}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
          <SectionCard
            title="Client mail"
            subtitle="Mail from a client's website form, or BCC'd or forwarded to a company mailbox, is filed as that client's, not the company's own lead."
            icon={ListChecks}
            tone={(snapshot?.clientMaps?.unmapped ?? []).length ? "warn" : undefined}
            actions={<Button type="button" variant="secondary" onClick={() => void openMapping()}>Add a mapping</Button>}
          >
            {(snapshot?.clientMaps?.unmapped ?? []).length ? (
              <div style={{ display: "grid", gap: 6, marginBottom: 10 }}>
                <strong style={{ fontSize: 13 }}>Looks like client mail, not mapped yet</strong>
                {(snapshot?.clientMaps?.unmapped ?? []).map((row) => (
                  <div key={row.domain} style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", fontSize: 13 }}>
                    <span style={breakAnywhere}>{row.domain} · {row.messages} message{row.messages === 1 ? "" : "s"}{row.lastReceivedAt ? ` · last ${whenText(row.lastReceivedAt, now)}` : ""}</span>
                    <Button type="button" variant="secondary" style={{ height: 28, fontSize: 12 }} onClick={() => void openMapping({ matchType: "sender_domain", pattern: row.domain })}>Map it</Button>
                  </div>
                ))}
              </div>
            ) : null}
            {(snapshot?.clientMaps?.maps ?? []).length === 0 ? (
              <Muted>No mappings yet. Without one, mail like this stays the company's own and is flagged here so it can be mapped once.</Muted>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {(snapshot?.clientMaps?.maps ?? []).map((map) => (
                  <div key={map.id} style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", fontSize: 13, minWidth: 0 }}>
                    <span style={breakAnywhere}>{MAP_TYPE_NAMES[map.matchType] ?? map.matchType} <strong>{map.pattern}</strong> → {map.clientName ?? map.clientRef}</span>
                    <Button type="button" variant="secondary" disabled={busy} style={{ height: 28, fontSize: 12 }} onClick={() => void run(() => removeClientMap({ mapId: map.id }), "Mapping removed")}>Remove</Button>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
          {otherMailboxes.length ? (
            <SectionCard title="Mailboxes without Gmail" subtitle="Drafts saved here can't be sent from Paperclip; a person sends them from their own mail." icon={Mail}>
              {otherMailboxes.map((account) => (
                <div key={account.id} style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", fontSize: 13, minWidth: 0 }}>
                  <strong style={{ fontWeight: 600, ...breakAnywhere }}>{account.address}</strong>
                  <Pill size="sm" dot>Not connected to Gmail</Pill>
                </div>
              ))}
            </SectionCard>
          ) : null}
          {technicalSection}
          <Muted>
            Using a mailbox that isn't Gmail?{" "}
            <button type="button" onClick={() => setCreate("mailbox")} style={{ appearance: "none", border: "none", background: "transparent", padding: 0, font: "inherit", color: tokens.primary, fontWeight: 600, cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 2 }}>Add it here</button>
          </Muted>
        </div>
      ) : null}

      {tab === "triage" ? (
        <div style={{ display: "grid", gap: 16 }}>
          <SectionCard title="Mail by category" subtitle="How new mail was sorted, last 30 days" icon={ChartColumn}>
            {Object.keys(stats?.categories ?? snapshot?.categoryCounts ?? {}).length ? (
              <BarList
                bare
                title="Mail by category (30 days)"
                items={Object.entries(stats?.categories ?? snapshot?.categoryCounts ?? {})
                  .sort((a, b) => b[1] - a[1])
                  .map(([key, value]) => ({ label: CATEGORY_NAMES[key] ?? key, value, ...categoryFill(key) }))}
              />
            ) : <Muted>{gmailAccounts.length ? "Nothing sorted yet. New mail gets a category after the next sync." : "Mail is sorted once Gmail is connected."}</Muted>}
          </SectionCard>
          {!settings?.jev ? (
            <SectionCard
              title="Smart sorting (optional)"
              subtitle="Off. New mail is sorted with built-in rules."
              icon={Sparkles}
              actions={settings?.href ? <a {...hostNavigation.linkProps(settings.href)} style={{ fontSize: 13, fontWeight: 600, color: tokens.primary, whiteSpace: "nowrap" }}>Open settings →</a> : undefined}
            >
              <Muted>Smart sorting picks categories, urgency and the client more accurately, and learns from the fixes you make in the Inbox. An admin turns it on once in the Mailbox settings.</Muted>
            </SectionCard>
          ) : (stats?.questions ?? []).length === 0 ? (
            <SectionCard title="Smart sorting" subtitle="On" icon={Sparkles}>
              <Muted>Its results show up here after the first sorted mail.</Muted>
            </SectionCard>
          ) : (
            <SectionCard title="How well smart sorting does" subtitle="Its decisions and your fixes, last 30 days" icon={ListChecks}>
              {narrow ? (
                <CompactRows
                  label="Smart sorting results"
                  rows={stats?.questions ?? []}
                  rowKey={(row) => row.question}
                  title={(row) => QUESTION_NAMES[row.question] ?? row.question}
                  meta={(row) => `${row.total} sorted · ${row.corrected} fixed by you`}
                  trailing={(row) => (row.accuracy == null ? "–" : `${Math.round(row.accuracy * 100)}% right`)}
                />
              ) : (
                <DataTable
                  columns={[
                    { key: "questionName", header: "What it decides" },
                    { key: "total", header: "Sorted" },
                    { key: "corrected", header: "Fixed by you", render: (value) => (Number(value) > 0 ? <Pill size="sm" tone="warn">{String(value)}</Pill> : "0") },
                    {
                      key: "accuracyText",
                      header: "Right",
                      render: (value, row) => {
                        const a = (row as { accuracy: number | null }).accuracy;
                        return a == null ? "–" : <Pill size="sm" tone={a >= 0.9 ? "ok" : a >= 0.75 ? "warn" : "bad"}>{String(value)}</Pill>;
                      },
                    },
                    { key: "confidenceText", header: "How sure, on average" },
                  ]}
                  rows={(stats?.questions ?? []).map((row) => ({
                    ...row,
                    id: row.question,
                    questionName: QUESTION_NAMES[row.question] ?? row.question,
                    accuracyText: row.accuracy == null ? "–" : `${Math.round(row.accuracy * 100)}%`,
                    confidenceText: `${Math.round(row.avgConfidence * 100)}%`,
                  })) as unknown as Record<string, unknown>[]}
                  emptyMessage="No decisions yet."
                />
              )}
            </SectionCard>
          )}
        </div>
      ) : null}

      <Modal
        open={Boolean(previewDraft)}
        title={previewDraft ? previewDraft.subject || "(no subject)" : "Draft"}
        description="A draft. Nothing is sent until someone clicks Send."
        onClose={() => setPreview(null)}
        footer={previewDraft ? (
          <>
            <Button type="button" variant="secondary" onClick={() => setPreview(null)}>Close</Button>
            {previewDraft.status === "draft" ? <Button type="button" disabled={busy || Boolean(draftBlock)} title={draftBlock ?? undefined} onClick={() => void run(() => sendDraft({ messageId: previewDraft.id }), "Draft sent")}>Send</Button> : null}
          </>
        ) : undefined}
      >
        {previewDraft ? (
          <>
            {draftBlock ? (
              <p role="status" style={{ margin: 0, fontSize: 13, lineHeight: 1.45, padding: "8px 12px", borderRadius: 10, border: `1px solid ${tone("warn").border}`, background: tone("warn").soft }}>
                Can't send yet: {draftBlock}{draftRecipients(previewDraft).length === 0 ? " Ask its agent to draft it again with a recipient." : ""}
              </p>
            ) : null}
            <Facts
              rows={[
                ["From", addressOf(previewDraft.account_id)],
                ["To", draftRecipients({ ...previewDraft, cc_addrs: [], bcc_addrs: [] }).join(", ") || <Chip tone="warn">No recipient</Chip>],
                (previewDraft.cc_addrs ?? []).length ? ["Cc", (previewDraft.cc_addrs ?? []).map((row) => row.email).join(", ")] : null,
                (previewDraft.bcc_addrs ?? []).length ? ["Bcc", (previewDraft.bcc_addrs ?? []).map((row) => row.email).join(", ")] : null,
                ["Drafted by", drafterName(previewDraft.drafted_by)],
                ["Saved", previewDraft.created_at ? formatDateTime(previewDraft.created_at) : "–"],
                ["Status", <Pill key="s" size="sm" tone={draftTone(previewDraft.status)} dot>{DRAFT_STATUS[previewDraft.status] ?? previewDraft.status}</Pill>],
                previewDraft.send_error ? ["Last try", previewDraft.send_error] : null,
              ]}
            />
            <div style={{ borderTop: `1px solid ${tokens.border}`, paddingTop: 12, fontSize: 13.5, lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 320, overflowY: "auto" }}>
              {previewDraft.body?.trim() ? previewDraft.body : <span style={{ color: tokens.muted }}>No text in this draft.</span>}
            </div>
            {previewDraft.has_html ? <Muted>It also has a designed (HTML) version; the text above is the plain version.</Muted> : null}
          </>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(previewMail)}
        title={previewMail ? previewMail.subject || "(no subject)" : "Mail"}
        onClose={() => setPreview(null)}
        footer={previewMail ? (
          <>
            <Button type="button" variant="secondary" onClick={() => setPreview(null)}>Close</Button>
            <Button type="button" variant="secondary" onClick={() => openCorrection(previewMail)}>Fix sorting</Button>
          </>
        ) : undefined}
      >
        {previewMail ? (
          <>
            <Facts
              rows={[
                ["From", previewMail.from ? `${previewMail.from.name ? `${previewMail.from.name} · ` : ""}${previewMail.from.email}` : "–"],
                ["Received", formatDateTime(previewMail.received_at ?? previewMail.created_at)],
                ["Sorted as", <SortingChips key="c" row={previewMail} />],
                previewMail.attachments.length ? ["Files", previewMail.attachments.map((a) => a.filename).join(", ")] : null,
              ]}
            />
            {previewMail.map_state === "needs_mapping" ? (
              <div style={{ display: "grid", gap: 6, justifyItems: "start" }}>
                <Muted>This looks like a client's mail (for example a website form), but nothing says whose. It is filed as the company's own until it is mapped.</Muted>
                {suggestMapping(previewMail) ? <Button type="button" variant="secondary" onClick={() => void openMapping(suggestMapping(previewMail)!)}>Map {suggestMapping(previewMail)!.pattern} to a client</Button> : null}
              </div>
            ) : null}
            {previewMail.visitor ? <Muted>Reply-To (the visitor, for a relayed form): {previewMail.visitor.name ? `${previewMail.visitor.name} · ` : ""}{previewMail.visitor.email}</Muted> : null}
            {previewMail.snippet ? <p style={{ margin: 0, fontSize: 13, color: tokens.muted, lineHeight: 1.5, overflowWrap: "anywhere" }}>{previewMail.snippet}…</p> : null}
            <Muted>Open Gmail to read and answer the whole message.</Muted>
          </>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(previewSend)}
        title={previewSend ? previewSend.subject || "(no subject)" : "Sent mail"}
        onClose={() => setPreview(null)}
        footer={previewSend ? (
          <>
            <Button type="button" variant="secondary" onClick={() => setPreview(null)}>Close</Button>
            {previewSend.status === "failed" || previewSend.status === "retrying" ? <Button type="button" disabled={busy} onClick={() => void run(() => retrySend({ key: previewSend.key }), "Sent again")}>Retry</Button> : null}
          </>
        ) : undefined}
      >
        {previewSend ? (
          <Facts
            rows={[
              ["Status", <span key="s" style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>{sendBadge(previewSend.status, previewSend.permanent)}{previewSend.marketing ? <Chip tone="info">Marketing</Chip> : null}</span>],
              ["To", previewSend.to.join(", ") || "–"],
              ["From", previewSend.from ?? "–"],
              ["Sent by", sentBy(previewSend)],
              ["When", formatDateTime(previewSend.sentAt ?? previewSend.createdAt)],
              previewSend.error && previewSend.status !== "sent" ? ["Problem", previewSend.error] : null,
              previewSend.skipped?.length ? ["Left out", `${previewSend.skipped.map((entry) => entry.email).join(", ")} (do not email)`] : null,
            ]}
          />
        ) : null}
      </Modal>

      <Modal
        open={Boolean(correcting)}
        title="Fix sorting"
        description={correcting ? correcting.subject : undefined}
        onClose={() => setCorrecting(null)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setCorrecting(null)}>Cancel</Button>
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                const target = correcting;
                if (!target) return;
                void run(async () => {
                  await correctTriage({
                    messageId: target.id,
                    category: fix.category && fix.category !== target.category ? fix.category : undefined,
                    urgency: fix.urgency === "" ? undefined : Number(fix.urgency),
                    needsReply: fix.needsReply === "" ? undefined : fix.needsReply === "yes",
                    client: fix.client || undefined,
                  });
                  setCorrecting(null);
                }, "Sorting fixed. The Gmail label follows.");
              }}
            >
              Save
            </Button>
          </>
        )}
      >
        <Field label="Category">
          <Select value={fix.category} onChange={(event) => setFix({ ...fix, category: event.target.value })}>
            {(snapshot?.categories ?? Object.keys(CATEGORY_NAMES)).map((c) => <option key={c} value={c}>{CATEGORY_NAMES[c] ?? c}</option>)}
          </Select>
        </Field>
        <Field label="Urgency">
          <Select value={fix.urgency} onChange={(event) => setFix({ ...fix, urgency: event.target.value })}>
            <option value="">Keep</option>
            {URGENCY_NAMES.map((name, level) => <option key={name} value={String(level)}>{name}</option>)}
          </Select>
        </Field>
        <Field label="Needs reply">
          <Select value={fix.needsReply} onChange={(event) => setFix({ ...fix, needsReply: event.target.value })}>
            <option value="">Keep</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </Select>
        </Field>
        <Field label="Client">
          <Select value={fix.client} onChange={(event) => setFix({ ...fix, client: event.target.value })}>
            <option value="">Keep</option>
            <option value="none">Not a client</option>
            {(inbox?.clients ?? []).map((c) => <option key={c.ref} value={c.ref}>{c.name}{c.kind === "contact" ? " (person)" : ""}</option>)}
          </Select>
        </Field>
      </Modal>

      <Modal open={create === "mailbox"} title="Add a mailbox without Gmail" description="For an address that is not a Gmail account. Paperclip can't sync or send from it; drafts saved there are sent by a person." onClose={() => setCreate(null)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
          <Button type="button" disabled={busy} onClick={() => void run(async () => {
            await createAccount({ provider, address });
            setAddress("");
          }, "Mailbox added")}>Add mailbox</Button>
        </>
      )}>
        <Field label="Email address"><Input value={address} onChange={(event) => setAddress(event.target.value)} required placeholder="accounts@example.com" /></Field>
        <Field label="Mail service"><Input value={provider} onChange={(event) => setProvider(event.target.value)} placeholder="e.g. outlook" /></Field>
      </Modal>

      <Modal open={create === "delegation"} title="Give an agent access" description="The agent can read and draft on this mailbox. Sending stays with a person unless you allow it below." onClose={() => setCreate(null)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
          <Button type="button" disabled={busy || !accountId || !agentId} onClick={() => void run(() => createDelegation({ accountId, agentId, canSend }), "Access given")}>Give access</Button>
        </>
      )}>
        <Field label="Mailbox">
          <Select value={accountId} onChange={(event) => setAccountId(event.target.value)} required>
            <option value="">Choose a mailbox…</option>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.address}</option>)}
          </Select>
        </Field>
        <Field label="Agent">
          <Select value={agentId} onChange={(event) => setAgentId(event.target.value)} required>
            <option value="">Choose an agent…</option>
            {agents.filter((agent) => agent.status !== "terminated").map((agent) => <option key={agent.id} value={agent.id}>{agent.name}{agent.status === "paused" ? " (paused)" : ""}</option>)}
          </Select>
        </Field>
        <label style={{ display: "inline-flex", alignItems: "flex-start", gap: 8, fontSize: 13, lineHeight: 1.45 }}>
          <input type="checkbox" checked={canSend} onChange={(event) => setCanSend(event.target.checked)} style={{ marginTop: 3 }} />
          <span>Also let it send without a person checking first <span style={{ color: tokens.muted }}>(leave off unless you are sure)</span></span>
        </label>
      </Modal>

      <Modal open={create === "draft"} title="New draft" description="Saved as a draft. Nothing is sent until someone clicks Send." onClose={() => setCreate(null)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
          <Button type="button" disabled={busy || !accountId || !subject.trim()} onClick={() => void run(async () => {
            await createDraft({ accountId, subject, to: draftTo, body: draftBody });
            setSubject("");
            setDraftTo("");
            setDraftBody("");
          }, "Draft saved")}>Save draft</Button>
        </>
      )}>
        <Field label="From">
          <Select value={accountId} onChange={(event) => setAccountId(event.target.value)} required>
            <option value="">Choose a mailbox…</option>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.address}{canSendFrom(account) ? "" : " (not connected to Gmail)"}</option>)}
          </Select>
        </Field>
        <Field label="To"><Input value={draftTo} onChange={(event) => setDraftTo(event.target.value)} placeholder="name@example.com, other@example.com" /></Field>
        {!draftTo.trim() ? <Muted>Without a recipient the draft can't be sent.</Muted> : null}
        <Field label="Subject"><Input value={subject} onChange={(event) => setSubject(event.target.value)} required /></Field>
        <Field label="Message"><TextArea value={draftBody} onChange={(event) => setDraftBody(event.target.value)} rows={6} /></Field>
      </Modal>
      <Modal open={create === "domain"} title="Check a sender domain" description="Reads the public DNS of a domain: nothing is changed. Use it for a new client's domain to see exactly which records to add. The domain is then checked every day." onClose={() => setCreate(null)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Close</Button>
          <Button type="button" disabled={busy || !domainInput.trim()} onClick={() => void runDomainCheck(domainInput.trim())}>Check</Button>
        </>
      )}>
        <Field label="Domain"><Input value={domainInput} onChange={(event) => setDomainInput(event.target.value)} placeholder="client.co.za" /></Field>
        {domainResult ? (
          <div style={{ display: "grid", gap: 8 }}>
            {domainResult.applicable === false ? <Muted>{domainResult.note}</Muted> : (
              <>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <strong>{domainResult.domain}</strong>
                  <Pill size="sm" tone={domainTone(domainResult.status)} dot>{domainStatusLabel(domainResult.status)}</Pill>
                  {domainResult.sendReady ? <Chip tone="ok">Ready for campaigns</Chip> : null}
                </div>
                {(domainResult.problems ?? []).filter((problem) => problem.severity !== "info").map((problem) => (
                  <div key={problem.message} style={{ fontSize: 12.5, lineHeight: 1.45, overflowWrap: "anywhere" }}>{problem.message} <span style={{ color: tokens.muted }}>{problem.fix}</span></div>
                ))}
                {domainResult.onboarding?.steps.length ? (
                  <ol style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6, fontSize: 13, lineHeight: 1.45 }}>
                    {domainResult.onboarding.steps.map((step) => <li key={step} style={{ overflowWrap: "anywhere" }}>{step}</li>)}
                  </ol>
                ) : null}
                {domainResult.onboarding?.alreadyDone.length ? <Muted>Already in place: {domainResult.onboarding.alreadyDone.join("; ")}.</Muted> : null}
                {(domainResult.manual ?? []).length ? <Muted>Part of the DNS could not be read. By hand: {(domainResult.manual ?? []).join("  ·  ")}</Muted> : null}
              </>
            )}
          </div>
        ) : null}
      </Modal>

      <Modal open={create === "client-map"} title="Map client mail" description="Mail matching this rule is filed under the client, and its leads go to the CRM as that client's." onClose={() => setCreate(null)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
          <Button type="button" disabled={busy || !mapForm.pattern.trim() || !mapForm.client} onClick={() => {
            const [clientKind, clientRef] = mapForm.client.split(":");
            void run(() => addClientMap({ matchType: mapForm.matchType, pattern: mapForm.pattern, clientKind, clientRef, note: mapForm.note || undefined }), "Mapping added. Flagged mail was filed under the client.");
          }}>Add mapping</Button>
        </>
      )}>
        <Field label="Mail">
          <Select value={mapForm.matchType} onChange={(event) => setMapForm({ ...mapForm, matchType: event.target.value })}>
            {Object.entries(MAP_TYPE_NAMES).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </Select>
        </Field>
        <Field label={mapForm.matchType.endsWith("domain") ? "Domain" : "Address"}><Input value={mapForm.pattern} onChange={(event) => setMapForm({ ...mapForm, pattern: event.target.value })} placeholder={mapForm.matchType.endsWith("domain") ? "ahslaw.co.za" : "forms@ahslaw.co.za"} /></Field>
        <Field label="Client">
          <Select value={mapForm.client} onChange={(event) => setMapForm({ ...mapForm, client: event.target.value })}>
            <option value="">Choose a client…</option>
            {crmClients.map((c) => <option key={c.ref} value={c.ref}>{c.name}{c.kind === "contact" ? " (person)" : ""}</option>)}
          </Select>
        </Field>
        <Field label="Note (optional)"><Input value={mapForm.note} onChange={(event) => setMapForm({ ...mapForm, note: event.target.value })} placeholder="The AHS Law website form" /></Field>
      </Modal>

      <Modal open={create === "account-client"} title={bindTarget ? `Give ${bindTarget.address} to a client` : "Give a mailbox to a client"} description="The mailbox then sends only that client's mail, as the client, with the client's own do-not-email list. It stops being a company mailbox: it is never the default sender and no agent gets access to it automatically." onClose={() => setCreate(null)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
          <Button type="button" disabled={busy || !bindTarget || !bindClient} onClick={() => {
            const [clientKind, clientRef] = bindClient.split(":");
            void run(() => setAccountClient({ accountId: bindTarget!.id, clientKind, clientRef }), "The mailbox belongs to the client now");
          }}>Give it to the client</Button>
        </>
      )}>
        <Field label="Client">
          <Select value={bindClient} onChange={(event) => setBindClient(event.target.value)}>
            <option value="">Choose a client…</option>
            {crmClients.map((c) => <option key={c.ref} value={c.ref}>{c.name}{c.kind === "contact" ? " (person)" : ""}</option>)}
          </Select>
        </Field>
      </Modal>
    </Page>
  );
}

export function MailboxSidebar({ context }: PluginSidebarProps) {
  // Hidden when the company switched the Mailbox off in Setup; shown while loading.
  const enabled = useModuleEnabled(context.companyId, PLUGIN_KEY);
  // The Cockpit's Clients / Marketing / Finance group shows this page instead (pib-plugin-ui NAV_GROUPS).
  const grouped = useGroupedNav("partnersinbiz.mailbox");
  if (enabled === false || grouped !== false) return null;
  return (
    <SidebarNavLink to="/mailbox" label="Mailbox" icon={(
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect width="20" height="16" x="2" y="4" rx="2" />
        <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
      </svg>
    )} />
  );
}

function SidebarNavLink({ to, label, icon }: { to: string; label: string; icon: ReactNode }) {
  const hostNavigation = useHostNavigation();
  const href = hostNavigation.resolveHref(to);
  const isActive = typeof window !== "undefined" && window.location.pathname === href;
  return (
    <a
      {...hostNavigation.linkProps(to)}
      aria-current={isActive ? "page" : undefined}
      className={[
        "flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 text-(length:--text-compact) font-medium transition-colors",
        isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      ].join(" ")}
      style={{ textDecoration: "none" }}
    >
      <span aria-hidden="true" className="relative shrink-0">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
    </a>
  );
}
