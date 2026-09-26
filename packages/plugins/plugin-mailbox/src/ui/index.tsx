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
import {
  BarChart,
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  Page,
  Select,
  StatRow,
  Tabs,
  Toolbar,
  errorText,
} from "@partnersinbiz/pib-plugin-ui";

interface Account { id: string; address: string; provider: string }
interface Delegation { id: string; account_id: string; agent_id: string; can_send: boolean }
interface Message { id: string; subject: string; status: string }
interface Snapshot { accounts: Account[]; delegations: Delegation[]; messages: Message[] }
type TabId = "overview" | "mailboxes" | "messages";
type CreateKind = "mailbox" | "delegation" | "draft" | null;

export function MailboxPage({ context }: PluginPageProps) {
  const load = usePluginAction("mailbox.load");
  const createAccount = usePluginAction("mailbox.create-account");
  const createDelegation = usePluginAction("mailbox.create-delegation");
  const createDraft = usePluginAction("mailbox.create-draft");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<TabId>("overview");
  const [search, setSearch] = useState("");
  const [create, setCreate] = useState<CreateKind>(null);
  const [address, setAddress] = useState("");
  const [provider, setProvider] = useState("gmail");
  const [accountId, setAccountId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [canSend, setCanSend] = useState(false);
  const [subject, setSubject] = useState("");

  async function refresh() {
    setSnapshot((await load({})) as Snapshot);
  }

  useEffect(() => {
    if (!context.companyId) return;
    refresh().catch((error: unknown) => setMessage(errorText(error)));
  }, [context.companyId]);

  async function run(work: () => Promise<unknown>, success: string) {
    setMessage("");
    try {
      await work();
      await refresh();
      setMessage(success);
      setCreate(null);
    } catch (error) {
      setMessage(errorText(error));
    }
  }

  const q = search.trim().toLowerCase();
  const accounts = useMemo(() => (snapshot?.accounts ?? []).filter((row) => !q || row.address.toLowerCase().includes(q)), [snapshot, q]);
  const messages = useMemo(() => (snapshot?.messages ?? []).filter((row) => !q || row.subject.toLowerCase().includes(q)), [snapshot, q]);
  const canSendCount = snapshot?.delegations.filter((row) => row.can_send).length ?? 0;
  const draftOnly = (snapshot?.delegations.length ?? 0) - canSendCount;

  return (
    <Page
      title="Mailbox"
      description="Delegations draft by default. Sending stays off until you allow it for that agent."
      message={message}
      actions={<Button type="button" onClick={() => setCreate("mailbox")}>+ Mailbox</Button>}
    >
      <Tabs
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "mailboxes", label: `Mailboxes (${snapshot?.accounts.length ?? 0})` },
          { id: "messages", label: `Drafts (${snapshot?.messages.length ?? 0})` },
        ]}
        active={tab}
        onChange={(id) => { setTab(id as TabId); setSearch(""); }}
      />

      {tab === "overview" ? (
        <div style={{ display: "grid", gap: 16 }}>
          <StatRow>
            <MetricCard label="Mailboxes" value={snapshot?.accounts.length ?? 0} />
            <MetricCard label="Draft-only" value={Math.max(draftOnly, 0)} />
            <MetricCard label="Can send" value={canSendCount} />
            <MetricCard label="Messages" value={snapshot?.messages.length ?? 0} />
          </StatRow>
          <BarChart
            title="Delegations"
            items={[
              { label: "draft only", value: Math.max(draftOnly, 0) },
              { label: "can send", value: canSendCount },
            ]}
          />
        </div>
      ) : null}

      {tab === "mailboxes" ? (
        <div style={{ display: "grid", gap: 12 }}>
          <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search mailboxes…">
            <Button type="button" variant="secondary" onClick={() => setCreate("delegation")}>Delegate</Button>
            <Button type="button" onClick={() => setCreate("mailbox")}>+ Mailbox</Button>
          </Toolbar>
          {accounts.length === 0 ? (
            <EmptyState title="No mailboxes yet" description="Add a mailbox, then delegate an agent." action={<Button type="button" onClick={() => setCreate("mailbox")}>+ Mailbox</Button>} />
          ) : (
            <>
              <DataTable
                columns={[
                  { key: "address", header: "Address" },
                  { key: "provider", header: "Provider" },
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

      {tab === "messages" ? (
        <div style={{ display: "grid", gap: 12 }}>
          <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search drafts…">
            <Button type="button" onClick={() => setCreate("draft")}>+ Draft</Button>
          </Toolbar>
          {messages.length === 0 ? (
            <EmptyState title="No drafts yet" description="Save a draft on a delegated mailbox." action={<Button type="button" onClick={() => setCreate("draft")}>+ Draft</Button>} />
          ) : (
            <DataTable
              columns={[
                { key: "subject", header: "Subject" },
                { key: "status", header: "Status", render: (value) => <StatusBadge label={String(value)} status="pending" /> },
              ]}
              rows={messages as unknown as Record<string, unknown>[]}
              emptyMessage="No drafts match."
            />
          )}
        </div>
      ) : null}

      <Modal open={create === "mailbox"} title="Add mailbox" onClose={() => setCreate(null)} footer={(
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
            await createDraft({ accountId, subject });
            setSubject("");
          }, "Draft saved")}>Save draft</Button>
        </>
      )}>
        <Field label="Mailbox">
          <Select value={accountId} onChange={(event) => setAccountId(event.target.value)} required>
            <option value="">Mailbox</option>
            {(snapshot?.accounts ?? []).map((account) => <option key={account.id} value={account.id}>{account.address}</option>)}
          </Select>
        </Field>
        <Field label="Subject"><Input value={subject} onChange={(event) => setSubject(event.target.value)} required /></Field>
      </Modal>
    </Page>
  );
}

export function MailboxSidebar(_props: PluginSidebarProps) {
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
