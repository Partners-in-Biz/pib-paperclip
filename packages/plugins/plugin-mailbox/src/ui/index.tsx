import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DataTable,
  MetricCard,
  StatusBadge,
  useHostNavigation,
  usePluginAction,
  type PluginPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import { rememberOAuthStart, resolvePluginUiBase } from "@partnersinbiz/pib-plugin-kit/oauth-client";
import { ModuleOffBanner, useModuleEnabled } from "./module-switch.js";
import {
  BarChart,
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  Page,
  Section,
  Select,
  StatRow,
  Tabs,
  TextArea,
  Toolbar,
  breakAnywhere,
  errorText,
  tokens,
} from "@partnersinbiz/pib-plugin-ui";

const PLUGIN_KEY = "partnersinbiz.mailbox";

interface Settings {
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
}
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
}
interface Delegation { id: string; account_id: string; agent_id: string; can_send: boolean }
interface DraftRow { id: string; account_id: string; subject: string; status: string; direction: string; send_error: string | null; to_addrs: Array<{ email: string }> | null }
interface Snapshot {
  settings: Settings;
  accounts: Account[];
  delegations: Delegation[];
  messages: DraftRow[];
  unreadCount: number;
  sendCounts: Record<string, number>;
  categoryCounts: Record<string, number>;
  categories: string[];
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
}
interface ClientOption { ref: string; name: string; kind: string }
interface SendRequest {
  key: string;
  status: "sending" | "sent" | "failed" | "retrying";
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

type TabId = "inbox" | "sent" | "drafts" | "mailboxes" | "triage";
type CreateKind = "mailbox" | "delegation" | "draft" | null;

const CATEGORY_NAMES: Record<string, string> = {
  lead: "Lead",
  client: "Client",
  reply: "Reply",
  proof_of_payment: "Proof of payment",
  invoice_or_bill: "Invoice or bill",
  bank_statement: "Bank statement",
  support: "Support",
  newsletter: "Newsletter",
  notification: "Notification",
  spam: "Spam",
  personal: "Personal",
  other: "Other",
};
const URGENCY_NAMES = ["Can wait", "Normal", "Soon", "Urgent"];

function when(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function Banner({ tone, children }: { tone: "warn" | "info"; children: ReactNode }) {
  return (
    <div
      role="status"
      style={{
        fontSize: 13,
        lineHeight: 1.5,
        padding: "10px 14px",
        borderRadius: 10,
        border: `1px solid ${tone === "warn" ? "color-mix(in oklab, #d97706 45%, transparent)" : tokens.border}`,
        background: tone === "warn" ? "color-mix(in oklab, #d97706 10%, transparent)" : tokens.secondary,
        display: "grid",
        gap: 4,
      }}
    >
      {children}
    </div>
  );
}

function Chip({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "warn" | "danger" | "ok" | "info" }) {
  const color = { neutral: tokens.muted, warn: "#d97706", danger: "#dc2626", ok: "#16a34a", info: "#2563eb" }[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        fontSize: 11,
        fontWeight: 600,
        lineHeight: 1,
        padding: "4px 7px",
        borderRadius: 999,
        whiteSpace: "nowrap",
        color: tone === "neutral" ? tokens.fg : color,
        border: `1px solid color-mix(in oklab, ${color} 35%, transparent)`,
        background: `color-mix(in oklab, ${color} 10%, transparent)`,
      }}
    >
      {children}
    </span>
  );
}

function TriageChips({ row }: { row: InboxMessage }) {
  const urgency = row.urgency == null ? null : Math.max(0, Math.min(3, Math.round(row.urgency)));
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
      {row.category ? <Chip tone={row.category === "lead" || row.category === "proof_of_payment" ? "info" : "neutral"}>{CATEGORY_NAMES[row.category] ?? row.category}</Chip> : <Chip>Not triaged</Chip>}
      {urgency != null && urgency >= 2 ? <Chip tone={urgency === 3 ? "danger" : "warn"}>{URGENCY_NAMES[urgency]}</Chip> : null}
      {row.needs_reply != null && row.needs_reply >= 0.7 ? <Chip tone="warn">Needs reply</Chip> : null}
      {row.phishing != null && row.phishing >= 0.9 ? <Chip tone="danger">Suspicious</Chip> : null}
      {row.client_ref ? <Chip tone="ok">{row.client_name || (row.client_kind === "contact" ? "Client (person)" : "Client")}</Chip> : null}
      {row.reply_to ? <Chip>Reply to {row.reply_to.kind}</Chip> : null}
    </div>
  );
}

function accountBadge(account: Account) {
  if (account.status === "connected") return <StatusBadge label="connected" status="ok" />;
  if (account.status === "needs_reconnect") return <StatusBadge label="needs reconnect" status="error" />;
  if (account.status === "disconnected") return <StatusBadge label="disconnected" status="pending" />;
  return <StatusBadge label="not connected" status="pending" />;
}

function sendBadge(status: SendRequest["status"], permanent: boolean) {
  if (status === "sent") return <StatusBadge label="sent" status="ok" />;
  if (status === "failed") return <StatusBadge label={permanent ? "failed" : "failed, can retry"} status="error" />;
  if (status === "retrying") return <StatusBadge label="waiting to retry" status="warning" />;
  return <StatusBadge label="sending" status="info" />;
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

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [inbox, setInbox] = useState<{ messages: InboxMessage[]; clients: ClientOption[] } | null>(null);
  const [sent, setSent] = useState<SendRequest[] | null>(null);
  const [stats, setStats] = useState<TriageStats | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<TabId>("inbox");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [needsReplyOnly, setNeedsReplyOnly] = useState(false);
  const [sentStatus, setSentStatus] = useState("");
  const [create, setCreate] = useState<CreateKind>(null);
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
      setMessage("Gmail connected. The first sync runs within two minutes, or click Sync now.");
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
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function connect(loginHint?: string) {
    setMessage("");
    try {
      const params = new URLSearchParams(window.location.search);
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

  const settings = snapshot?.settings;
  const gmailAccounts = (snapshot?.accounts ?? []).filter((a) => a.status !== "manual" || a.has_credential);
  const missing = settings
    ? [!settings.publicBaseUrl && "Public base URL", !settings.encryptionKey && "token encryption key", !settings.googleClientSecret && "Google client secret"].filter(Boolean)
    : [];
  const q = search.trim().toLowerCase();
  const inboxRows = useMemo(
    () =>
      (inbox?.messages ?? []).filter(
        (row) => !q || row.subject.toLowerCase().includes(q) || (row.from?.email ?? "").includes(q) || (row.from?.name ?? "").toLowerCase().includes(q),
      ),
    [inbox, q],
  );
  const drafts = useMemo(() => (snapshot?.messages ?? []).filter((row) => row.direction === "outbound" && (!q || row.subject.toLowerCase().includes(q))), [snapshot, q]);
  const accounts = useMemo(() => (snapshot?.accounts ?? []).filter((row) => !q || row.address.toLowerCase().includes(q)), [snapshot, q]);
  const failedSends = (snapshot?.sendCounts.failed ?? 0) + (snapshot?.sendCounts.retrying ?? 0);

  function openCorrection(row: InboxMessage) {
    setCorrecting(row);
    setFix({ category: row.category ?? "", urgency: "", needsReply: "", client: "" });
  }

  return (
    <Page
      title="Mailbox"
      description="The company's Gmail. Plugins send invoices, reminders and payslips through it. New mail is triaged and labelled in Gmail."
      message={message}
      actions={settings && missing.length === 0 ? <Button type="button" onClick={() => void connect()}>Connect Gmail</Button> : undefined}
    >
      <ModuleOffBanner companyId={context.companyId} pluginKey={PLUGIN_KEY} />
      {settings && !settings.saved ? (
        <Banner tone="warn">
          <strong>Mailbox settings are not saved for this company.</strong>
          <span>Open Settings → Plugins → Mailbox and click Save once. Until then Gmail does not sync and plugins cannot send for this company.</span>
        </Banner>
      ) : null}
      {settings && settings.saved && missing.length > 0 ? (
        <Banner tone="info">
          <strong>Gmail connection is not configured yet.</strong>
          <span>Needed in the Mailbox settings: {missing.join(", ")}.</span>
        </Banner>
      ) : null}

      <Section
        title="Gmail"
        actions={gmailAccounts.some((a) => a.status === "connected") ? (
          <Button type="button" variant="secondary" disabled={busy} onClick={() => void run(() => syncNow({}), "Sync finished")}>Sync now</Button>
        ) : undefined}
      >
        {gmailAccounts.length === 0 ? (
          <EmptyState
            title="No Gmail account connected"
            description="Connect the Gmail account that sends invoices and receives client mail. Sign in with that Google account."
            action={settings && missing.length === 0 ? <Button type="button" onClick={() => void connect()}>Connect Gmail</Button> : undefined}
          />
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {gmailAccounts.map((account) => (
              <div
                key={account.id}
                style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", padding: "10px 12px", border: `1px solid ${tokens.border}`, borderRadius: 10 }}
              >
                <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <strong style={{ fontSize: 14 }}>{account.address}</strong>
                    {accountBadge(account)}
                    {account.is_default ? <Chip tone="info">Default sender</Chip> : null}
                  </div>
                  <span style={{ fontSize: 12, color: tokens.muted }}>
                    Last sync {when(account.last_sync_at)}
                    {account.sync_stats?.stored ? ` · ${account.sync_stats.stored} new` : ""}
                  </span>
                  {account.last_error ? <span style={{ fontSize: 12, color: "#dc2626", overflowWrap: "anywhere" }}>{account.last_error}</span> : null}
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {account.status !== "connected" ? <Button type="button" onClick={() => void connect(account.address)}>Reconnect</Button> : null}
                  {account.status === "connected" && !account.is_default ? (
                    <Button type="button" variant="secondary" disabled={busy} onClick={() => void run(() => setDefault({ accountId: account.id }), `${account.address} is now the default sender`)}>Make default</Button>
                  ) : null}
                  {account.status === "connected" ? (
                    <Button type="button" variant="secondary" disabled={busy} onClick={() => void run(() => syncNow({ accountId: account.id }), "Sync finished")}>Sync</Button>
                  ) : null}
                  {account.status !== "disconnected" && account.has_credential ? (
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`Disconnect ${account.address}? Plugins will not be able to send from it until it is connected again.`)) {
                          void run(() => disconnect({ accountId: account.id }), `${account.address} disconnected`);
                        }
                      }}
                    >
                      Disconnect
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
        {settings?.redirectUri ? (
          <p style={{ margin: 0, fontSize: 12, color: tokens.muted, overflowWrap: "anywhere" }}>
            Redirect URI to add to the Google Web client (Credentials → Authorized redirect URIs): <code style={breakAnywhere}>{settings.redirectUri}</code>
          </p>
        ) : settings?.publicBaseUrl ? (
          <p style={{ margin: 0, fontSize: 12, color: tokens.muted }}>Reload this page to see the Google redirect URI.</p>
        ) : null}
        {settings && !settings.jev ? (
          <p style={{ margin: 0, fontSize: 12, color: tokens.muted }}>Triage uses built-in rules. Add a TypeSafe (Jev) key in the settings for better categories, urgency and client matching.</p>
        ) : null}
      </Section>

      <StatRow>
        <MetricCard label="Unread" value={snapshot?.unreadCount ?? 0} />
        <MetricCard label="Sent (30 days)" value={snapshot?.sendCounts.sent ?? 0} />
        <MetricCard label="Failed or waiting" value={failedSends} />
        <MetricCard label="Leads (30 days)" value={snapshot?.categoryCounts.lead ?? 0} />
      </StatRow>

      <Tabs
        tabs={[
          { id: "inbox", label: "Inbox" },
          { id: "sent", label: failedSends > 0 ? `Sent (${failedSends} need attention)` : "Sent" },
          { id: "drafts", label: `Drafts (${drafts.length})` },
          { id: "mailboxes", label: `Mailboxes (${snapshot?.accounts.length ?? 0})` },
          { id: "triage", label: "Triage" },
        ]}
        active={tab}
        onChange={(id) => { setTab(id as TabId); setSearch(""); }}
      />

      {tab === "inbox" ? (
        <div style={{ display: "grid", gap: 12 }}>
          <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search subject or sender…">
            <Select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Category">
              <option value="">All categories</option>
              {(snapshot?.categories ?? Object.keys(CATEGORY_NAMES)).map((c) => <option key={c} value={c}>{CATEGORY_NAMES[c] ?? c}</option>)}
            </Select>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13 }}>
              <input type="checkbox" checked={needsReplyOnly} onChange={(event) => setNeedsReplyOnly(event.target.checked)} />
              Needs reply
            </label>
            <Button type="button" variant="secondary" onClick={() => void refreshInbox().catch((error: unknown) => setMessage(errorText(error)))}>Refresh</Button>
          </Toolbar>
          {inboxRows.length === 0 ? (
            <EmptyState title="No mail here" description={gmailAccounts.length === 0 ? "Connect Gmail to see new mail here." : "New mail shows up after the next sync."} />
          ) : (
            <DataTable
              columns={[
                { key: "received", header: "Received", width: "90px" },
                { key: "sender", header: "From", width: "22%" },
                {
                  key: "subject",
                  header: "Subject",
                  render: (_value, row) => {
                    const m = row as unknown as InboxMessage;
                    return (
                      <div style={{ display: "grid", gap: 2 }}>
                        <span style={{ fontWeight: m.is_read ? 400 : 600 }}>{m.subject}{m.attachments.length ? ` · ${m.attachments.length} file${m.attachments.length === 1 ? "" : "s"}` : ""}</span>
                        <span style={{ fontSize: 12, color: tokens.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "min(420px, 100%)" }}>{m.snippet}</span>
                      </div>
                    );
                  },
                },
                { key: "triage", header: "Triage", render: (_value, row) => <TriageChips row={row as unknown as InboxMessage} /> },
                {
                  key: "fix",
                  header: "",
                  width: "80px",
                  render: (_value, row) => <Button type="button" variant="secondary" onClick={() => openCorrection(row as unknown as InboxMessage)}>Correct</Button>,
                },
              ]}
              rows={inboxRows.map((row) => ({
                ...row,
                received: when(row.received_at ?? row.created_at),
                sender: row.from ? row.from.name || row.from.email : "—",
              })) as unknown as Record<string, unknown>[]}
              emptyMessage="No mail matches."
            />
          )}
        </div>
      ) : null}

      {tab === "sent" ? (
        <div style={{ display: "grid", gap: 12 }}>
          <Toolbar>
            <Select value={sentStatus} onChange={(event) => setSentStatus(event.target.value)} aria-label="Status">
              <option value="">All</option>
              <option value="sent">Sent</option>
              <option value="failed">Failed</option>
              <option value="retrying">Waiting to retry</option>
              <option value="sending">Sending</option>
            </Select>
            <Button type="button" variant="secondary" onClick={() => void refreshSent().catch((error: unknown) => setMessage(errorText(error)))}>Refresh</Button>
          </Toolbar>
          {(sent ?? []).length === 0 ? (
            <EmptyState title="Nothing sent yet" description="Mail the plugins send (invoices, reminders, payslips, campaigns) is listed here." />
          ) : (
            <DataTable
              columns={[
                { key: "when", header: "When", width: "90px" },
                { key: "toText", header: "To", width: "20%" },
                { key: "subject", header: "Subject" },
                { key: "source", header: "From plugin", width: "150px" },
                {
                  key: "status",
                  header: "Status",
                  render: (_value, row) => {
                    const r = row as unknown as SendRequest;
                    return (
                      <div style={{ display: "grid", gap: 3 }}>
                        {sendBadge(r.status, r.permanent)}
                        {r.error && r.status !== "sent" ? <span style={{ fontSize: 11, color: tokens.muted, overflowWrap: "anywhere" }}>{r.error}</span> : null}
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
                      <Button type="button" variant="secondary" disabled={busy} onClick={() => void run(() => retrySend({ key: r.key }), "Sent again")}>Retry</Button>
                    ) : null;
                  },
                },
              ]}
              rows={(sent ?? []).map((row) => ({
                ...row,
                id: row.key,
                when: when(row.sentAt ?? row.createdAt),
                toText: row.to.join(", "),
                source: `${(row.context?.plugin ?? row.sourcePlugin).replace(/^partnersinbiz\./, "")} · ${row.context?.kind ?? "mail"}`,
              })) as unknown as Record<string, unknown>[]}
              emptyMessage="Nothing matches."
            />
          )}
        </div>
      ) : null}

      {tab === "drafts" ? (
        <div style={{ display: "grid", gap: 12 }}>
          <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search drafts…">
            <Button type="button" onClick={() => setCreate("draft")}>+ Draft</Button>
          </Toolbar>
          {drafts.length === 0 ? (
            <EmptyState title="No drafts yet" description="Agents save drafts on delegated mailboxes. You can also write one here." action={<Button type="button" onClick={() => setCreate("draft")}>+ Draft</Button>} />
          ) : (
            <DataTable
              columns={[
                { key: "subject", header: "Subject" },
                { key: "toText", header: "To" },
                { key: "status", header: "Status", render: (value, row) => (
                  <div style={{ display: "grid", gap: 3 }}>
                    <StatusBadge label={String(value)} status={value === "sent" ? "ok" : "pending"} />
                    {(row as unknown as DraftRow).send_error ? <span style={{ fontSize: 11, color: tokens.muted }}>{(row as unknown as DraftRow).send_error}</span> : null}
                  </div>
                ) },
                {
                  key: "send",
                  header: "",
                  width: "80px",
                  render: (_value, row) => {
                    const d = row as unknown as DraftRow;
                    return d.status === "draft" ? (
                      <Button type="button" disabled={busy} onClick={() => void run(() => sendDraft({ messageId: d.id }), "Draft sent")}>Send</Button>
                    ) : null;
                  },
                },
              ]}
              rows={drafts.map((row) => ({ ...row, toText: (row.to_addrs ?? []).map((a) => a.email).join(", ") || "—" })) as unknown as Record<string, unknown>[]}
              emptyMessage="No drafts match."
            />
          )}
        </div>
      ) : null}

      {tab === "mailboxes" ? (
        <div style={{ display: "grid", gap: 12 }}>
          <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search mailboxes…">
            <Button type="button" variant="secondary" onClick={() => setCreate("delegation")}>Delegate</Button>
            <Button type="button" variant="secondary" onClick={() => setCreate("mailbox")}>+ Mailbox</Button>
          </Toolbar>
          {accounts.length === 0 ? (
            <EmptyState title="No mailboxes yet" description="Connect Gmail, then delegate an agent." />
          ) : (
            <>
              <DataTable
                columns={[
                  { key: "address", header: "Address" },
                  { key: "provider", header: "Provider" },
                  { key: "status", header: "Gmail", render: (_value, row) => accountBadge(row as unknown as Account) },
                ]}
                rows={accounts as unknown as Record<string, unknown>[]}
                emptyMessage="No mailboxes match."
              />
              <DataTable
                columns={[
                  { key: "agent_id", header: "Agent" },
                  { key: "account", header: "Mailbox" },
                  { key: "send", header: "Send", render: (value) => <StatusBadge label={String(value)} status={value === "can send" ? "ok" : "pending"} /> },
                ]}
                rows={(snapshot?.delegations ?? []).map((delegation) => ({
                  ...delegation,
                  account: snapshot?.accounts.find((account) => account.id === delegation.account_id)?.address ?? delegation.account_id,
                  send: delegation.can_send ? "can send" : "draft only",
                }))}
                emptyMessage="No delegations yet."
              />
            </>
          )}
        </div>
      ) : null}

      {tab === "triage" ? (
        <div style={{ display: "grid", gap: 16 }}>
          <BarChart
            title="Mail by category (30 days)"
            items={Object.entries(stats?.categories ?? snapshot?.categoryCounts ?? {})
              .sort((a, b) => b[1] - a[1])
              .map(([key, value]) => ({ label: CATEGORY_NAMES[key] ?? key, value }))}
          />
          {(stats?.questions ?? []).length === 0 ? (
            <EmptyState title="No Jev decisions yet" description={settings?.jev ? "Stats appear after the first triaged mail." : "Triage uses built-in rules until a TypeSafe (Jev) key is added in the settings."} />
          ) : (
            <DataTable
              columns={[
                { key: "questionName", header: "Question" },
                { key: "total", header: "Decisions" },
                { key: "corrected", header: "Corrected" },
                { key: "accuracyText", header: "Accuracy" },
                { key: "confidenceText", header: "Avg confidence" },
              ]}
              rows={(stats?.questions ?? []).map((row) => ({
                ...row,
                id: row.question,
                questionName: { category: "Category", urgency: "Urgency", needs_reply: "Needs reply", phishing: "Phishing", client: "Client" }[row.question] ?? row.question,
                accuracyText: row.accuracy == null ? "—" : `${Math.round(row.accuracy * 100)}%`,
                confidenceText: `${Math.round(row.avgConfidence * 100)}%`,
              })) as unknown as Record<string, unknown>[]}
              emptyMessage="No decisions yet."
            />
          )}
        </div>
      ) : null}

      <Modal
        open={Boolean(correcting)}
        title="Correct triage"
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
                }, "Triage corrected");
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

      <Modal open={create === "mailbox"} title="Add mailbox" description="For a mailbox that is not connected to Gmail. Use Connect Gmail for a Gmail account." onClose={() => setCreate(null)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
          <Button type="button" onClick={() => void run(async () => {
            await createAccount({ provider, address });
            setAddress("");
          }, "Mailbox saved")}>Save</Button>
        </>
      )}>
        <Field label="Provider"><Input value={provider} onChange={(event) => setProvider(event.target.value)} /></Field>
        <Field label="Address"><Input value={address} onChange={(event) => setAddress(event.target.value)} required /></Field>
      </Modal>

      <Modal open={create === "delegation"} title="Delegate mailbox" onClose={() => setCreate(null)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
          <Button type="button" onClick={() => void run(() => createDelegation({ accountId, agentId, canSend }), "Delegation saved")}>Delegate</Button>
        </>
      )}>
        <Field label="Mailbox">
          <Select value={accountId} onChange={(event) => setAccountId(event.target.value)} required>
            <option value="">Mailbox</option>
            {(snapshot?.accounts ?? []).map((account) => <option key={account.id} value={account.id}>{account.address}</option>)}
          </Select>
        </Field>
        <Field label="Agent id"><Input value={agentId} onChange={(event) => setAgentId(event.target.value)} required /></Field>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={canSend} onChange={(event) => setCanSend(event.target.checked)} />
          Allow send
        </label>
      </Modal>

      <Modal open={create === "draft"} title="Save draft" onClose={() => setCreate(null)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
          <Button type="button" onClick={() => void run(async () => {
            await createDraft({ accountId, subject, to: draftTo, body: draftBody });
            setSubject("");
            setDraftTo("");
            setDraftBody("");
          }, "Draft saved")}>Save draft</Button>
        </>
      )}>
        <Field label="Mailbox">
          <Select value={accountId} onChange={(event) => setAccountId(event.target.value)} required>
            <option value="">Mailbox</option>
            {(snapshot?.accounts ?? []).map((account) => <option key={account.id} value={account.id}>{account.address}</option>)}
          </Select>
        </Field>
        <Field label="To"><Input value={draftTo} onChange={(event) => setDraftTo(event.target.value)} placeholder="name@example.com, other@example.com" /></Field>
        <Field label="Subject"><Input value={subject} onChange={(event) => setSubject(event.target.value)} required /></Field>
        <Field label="Message"><TextArea value={draftBody} onChange={(event) => setDraftBody(event.target.value)} rows={6} /></Field>
      </Modal>
    </Page>
  );
}

export function MailboxSidebar({ context }: PluginSidebarProps) {
  // Hidden when the company switched the Mailbox off in Setup; shown while loading.
  const enabled = useModuleEnabled(context.companyId, PLUGIN_KEY);
  if (enabled === false) return null;
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
