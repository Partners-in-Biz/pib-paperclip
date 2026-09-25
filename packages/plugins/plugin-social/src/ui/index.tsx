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
  TextArea,
  Toolbar,
  errorText,
} from "@partnersinbiz/pib-plugin-ui";

interface Account {
  id: string;
  displayName: string;
  platform: string;
  scope: string;
  hasCredential: boolean;
  handle?: string | null;
  avatarUrl?: string | null;
  status?: string;
  hasToken?: boolean;
  tokenExpiresAt?: string | null;
  externalId?: string | null;
}
interface Post { id: string; body: string; status: string; scope: string; scheduledAt: string }
interface Template { id: string; name: string; body: string; platform: string | null }
interface Snapshot { accounts: Account[]; posts: Post[]; templates: Template[]; oauthCallbackUrl?: string | null }
type TabId = "overview" | "posts" | "accounts" | "templates" | "calendar";
type CreateKind = "post" | "attach" | "schedule" | "template" | null;

export function SocialPage({ context }: PluginPageProps) {
  const load = usePluginAction("social.load");
  const createPost = usePluginAction("social.create-post");
  const attach = usePluginAction("social.attach");
  const review = usePluginAction("social.review");
  const approve = usePluginAction("social.approve");
  const schedule = usePluginAction("social.schedule");
  const createTemplate = usePluginAction("social.create-template");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<TabId>("overview");
  const [search, setSearch] = useState("");
  const [create, setCreate] = useState<CreateKind>(null);
  const [selectedPostId, setSelectedPostId] = useState("");
  const [body, setBody] = useState("");
  const [accountId, setAccountId] = useState("");
  const [when, setWhen] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [templateBody, setTemplateBody] = useState("");
  const [templatePlatform, setTemplatePlatform] = useState("");

  async function refresh() {
    setSnapshot((await load({})) as Snapshot);
  }

  useEffect(() => {
    if (!context.companyId) return;
    refresh().catch((error: unknown) => setMessage(errorText(error)));
  }, [context.companyId]);

  // Handle the OAuth redirect back to /social/oauth/callback?code&state (or X's oauth_token/verifier).
  useEffect(() => {
    if (!context.companyId) return;
    const params = new URLSearchParams(window.location.search);
    const state = params.get("state") ?? params.get("pstate") ?? "";
    if (!state) return;
    void (async () => {
      try {
        const res = await fetch("/api/plugins/partnersinbiz.social/api/oauth/complete", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            state,
            code: params.get("code") ?? undefined,
            oauthToken: params.get("oauth_token") ?? undefined,
            oauthVerifier: params.get("oauth_verifier") ?? undefined,
            companyId: context.companyId,
          }),
        });
        const data = await res.json() as { error?: string; displayName?: string };
        window.history.replaceState({}, "", window.location.pathname);
        if (!res.ok) throw new Error(data.error ?? "Connect failed");
        setMessage(`Connected ${data.displayName ?? "account"} \u2713`);
        await refresh();
      } catch (error) {
        window.history.replaceState({}, "", window.location.pathname);
        setMessage(errorText(error));
      }
    })();
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
  const posts = useMemo(() => (snapshot?.posts ?? []).filter((post) => !q || post.body.toLowerCase().includes(q) || post.status.includes(q)), [snapshot, q]);
  const accounts = useMemo(() => (snapshot?.accounts ?? []).filter((account) => !q || account.displayName.toLowerCase().includes(q)), [snapshot, q]);
  const templates = useMemo(() => (snapshot?.templates ?? []).filter((template) => !q || template.name.toLowerCase().includes(q) || template.body.toLowerCase().includes(q)), [snapshot, q]);
  const byStatus = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const post of snapshot?.posts ?? []) counts[post.status] = (counts[post.status] ?? 0) + 1;
    return counts;
  }, [snapshot]);

  return (
    <Page
      title="Social"
      description="Org campaigns stay off personal accounts. A person approves before a post is scheduled."
      message={message}
      actions={(
        <>
          <Button type="button" onClick={() => setCreate("post")}>+ Draft</Button>
        </>
      )}
    >
      <Tabs
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "posts", label: `Posts (${snapshot?.posts.length ?? 0})` },
          { id: "accounts", label: `Accounts (${snapshot?.accounts.length ?? 0})` },
          { id: "templates", label: `Templates (${snapshot?.templates.length ?? 0})` },
          { id: "calendar", label: "Calendar" },
        ]}
        active={tab}
        onChange={(id) => { setTab(id as TabId); setSearch(""); }}
      />

      {tab === "overview" ? (
        <div style={{ display: "grid", gap: 16 }}>
          <StatRow>
            <MetricCard label="Accounts" value={snapshot?.accounts.length ?? 0} />
            <MetricCard label="Drafts" value={byStatus.draft ?? 0} />
            <MetricCard label="In review" value={byStatus.review ?? 0} />
            <MetricCard label="Scheduled" value={byStatus.scheduled ?? 0} />
          </StatRow>
          <BarChart title="Posts by status" items={Object.entries(byStatus).map(([label, value]) => ({ label, value }))} />
        </div>
      ) : null}

      {tab === "posts" ? (
        <div style={{ display: "grid", gap: 12 }}>
          <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search posts…">
            <Button type="button" onClick={() => setCreate("post")}>+ Draft</Button>
          </Toolbar>
          {posts.length === 0 ? (
            <EmptyState title="No posts yet" description="Write a draft, attach an account, then send it to review." action={<Button type="button" onClick={() => setCreate("post")}>+ Draft</Button>} />
          ) : (
            <DataTable
              columns={[
                { key: "body", header: "Post" },
                { key: "status", header: "Status", render: (value) => <StatusBadge label={String(value)} status={value === "approved" || value === "scheduled" ? "ok" : value === "review" ? "warning" : "pending"} /> },
                { key: "scope", header: "Scope" },
                {
                  key: "id",
                  header: "Actions",
                  width: "280px",
                  render: (_value, row) => (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <Button type="button" variant="secondary" style={{ height: 28, fontSize: 12 }} onClick={() => { setSelectedPostId(String(row.id)); setCreate("attach"); }}>Attach</Button>
                      <Button type="button" variant="secondary" style={{ height: 28, fontSize: 12 }} onClick={() => void run(() => review({ postId: String(row.id) }), "Sent to review")}>Review</Button>
                      <Button type="button" variant="secondary" style={{ height: 28, fontSize: 12 }} onClick={() => void run(() => approve({ postId: String(row.id) }), "Approved")}>Approve</Button>
                      <Button type="button" style={{ height: 28, fontSize: 12 }} onClick={() => { setSelectedPostId(String(row.id)); setCreate("schedule"); }}>Schedule</Button>
                    </div>
                  ),
                },
              ]}
              rows={posts.map((post) => ({ ...post, body: post.body.slice(0, 80) }))}
              emptyMessage="No posts match."
            />
          )}
        </div>
      ) : null}

      {tab === "accounts" ? (
        <div style={{ display: "grid", gap: 12 }}>
          <ConnectAccounts companyId={context.companyId} onChanged={() => void refresh()} onMessage={setMessage} callbackOrigin={snapshot?.oauthCallbackUrl ?? null} />
          <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search accounts…" />
          {accounts.length === 0 ? (
            <EmptyState title="No connected accounts" description="Use the Connect accounts section above to connect a real platform via OAuth." />
          ) : (
            <DataTable
              columns={[
                { key: "displayName", header: "Account" },
                { key: "platform", header: "Platform", render: (value) => <StatusBadge label={String(value)} status="info" /> },
                { key: "handle", header: "Handle" },
                { key: "status", header: "Status", render: (value) => <StatusBadge label={String(value ?? "—")} status={String(value) === "connected" ? "ok" : "warning"} /> },
                { key: "tokenExpiresAt", header: "Token expires", render: (value) => value ? new Date(String(value)).toLocaleDateString() : "—" },
              ]}
              rows={accounts.map((account) => ({ ...account, handle: account.handle ?? account.externalId ?? "—" }))}
              emptyMessage="No accounts match."
            />
          )}
        </div>
      ) : null}

      {tab === "templates" ? (
        <div style={{ display: "grid", gap: 12 }}>
          <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search templates…">
            <Button type="button" onClick={() => setCreate("template")}>+ New template</Button>
          </Toolbar>
          {templates.length === 0 ? (
            <EmptyState title="No templates yet" description="Save reusable post copy so drafts stay consistent." action={<Button type="button" onClick={() => setCreate("template")}>+ New template</Button>} />
          ) : (
            <DataTable
              columns={[
                { key: "name", header: "Name" },
                { key: "platform", header: "Platform", render: (value) => value ? <StatusBadge label={String(value)} status="info" /> : "—" },
                { key: "body", header: "Body" },
              ]}
              rows={templates.map((template) => ({ ...template, body: template.body.slice(0, 100) }))}
              emptyMessage="No templates match."
            />
          )}
        </div>
      ) : null}

      {tab === "calendar" ? (
        <CalendarView posts={snapshot?.posts ?? []} />
      ) : null}

      <Modal open={create === "post"} title="New draft" onClose={() => setCreate(null)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
          <Button type="button" onClick={() => void run(async () => {
            await createPost({ body, scope: "org" });
            setBody("");
          }, "Draft saved")}>Save draft</Button>
        </>
      )}>
        <Field label="Post"><TextArea value={body} onChange={(event) => setBody(event.target.value)} required /></Field>
      </Modal>

      <Modal open={create === "attach"} title="Attach destination" onClose={() => setCreate(null)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
          <Button type="button" onClick={() => void run(() => attach({ postId: selectedPostId, accountId }), "Destination attached")}>Attach</Button>
        </>
      )}>
        <Field label="Account">
          <Select value={accountId} onChange={(event) => setAccountId(event.target.value)} required>
            <option value="">Account</option>
            {(snapshot?.accounts ?? []).map((account) => <option key={account.id} value={account.id}>{account.displayName}</option>)}
          </Select>
        </Field>
      </Modal>

      <Modal open={create === "schedule"} title="Schedule post" onClose={() => setCreate(null)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
          <Button type="button" onClick={() => void run(() => schedule({ postId: selectedPostId, scheduledAt: new Date(when).toISOString() }), "Post scheduled")}>Schedule</Button>
        </>
      )}>
        <Field label="When"><Input type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} required /></Field>
      </Modal>

      <Modal open={create === "template"} title="New template" onClose={() => setCreate(null)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
          <Button type="button" onClick={() => void run(async () => {
            await createTemplate({ name: templateName, body: templateBody, platform: templatePlatform || undefined });
            setTemplateName("");
            setTemplateBody("");
          }, "Template saved")}>Save template</Button>
        </>
      )}>
        <Field label="Name"><Input value={templateName} onChange={(event) => setTemplateName(event.target.value)} required /></Field>
        <Field label="Platform"><Input value={templatePlatform} onChange={(event) => setTemplatePlatform(event.target.value)} placeholder="linkedin" /></Field>
        <Field label="Body"><TextArea value={templateBody} onChange={(event) => setTemplateBody(event.target.value)} required /></Field>
      </Modal>
    </Page>
  );
}

function CalendarView({ posts }: { posts: Post[] }) {
  const scheduled = posts
    .filter((post) => post.status === "scheduled")
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  if (scheduled.length === 0) {
    return <EmptyState title="Nothing scheduled" description="Approve and schedule a post to see it on the calendar." />;
  }
  const byDate = new Map<string, Post[]>();
  for (const post of scheduled) {
    const day = new Date(post.scheduledAt).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    const list = byDate.get(day) ?? [];
    list.push(post);
    byDate.set(day, list);
  }
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {[...byDate.entries()].map(([day, dayPosts]) => (
        <div key={day} style={{ display: "grid", gap: 8, padding: 14, borderRadius: 12, border: "1px solid var(--border)", background: "var(--card)" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{day}</div>
          {dayPosts.map((post) => (
            <div key={post.id} style={{ fontSize: 13, lineHeight: 1.4, padding: "8px 10px", borderRadius: 8, background: "var(--secondary)" }}>
              {post.body.slice(0, 120)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function SocialSidebar(_props: PluginSidebarProps) {
  return (
    <SidebarNavLink to="/social" label="Social" icon={(
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
        <polyline points="16 6 12 2 8 6" />
        <line x1="12" y1="2" x2="12" y2="15" />
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


// ── OAuth Connect Accounts ──────────────────────────────────────────────────
const CONNECT_PLATFORMS: Array<{ id: string; label: string; needsInstance?: boolean; credentialConnect?: boolean }> = [
  { id: "facebook", label: "Facebook" },
  { id: "instagram", label: "Instagram" },
  { id: "threads", label: "Threads" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "x", label: "X / Twitter" },
  { id: "tiktok", label: "TikTok" },
  { id: "mastodon", label: "Mastodon", needsInstance: true },
  { id: "pinterest", label: "Pinterest" },
  { id: "reddit", label: "Reddit" },
  { id: "bluesky", label: "Bluesky", credentialConnect: true },
  { id: "dribbble", label: "Dribbble" },
  { id: "youtube", label: "YouTube" },
];

function ConnectAccounts({ companyId, onChanged, onMessage, callbackOrigin }: {
  companyId: string | null;
  onChanged: () => void;
  onMessage: (message: string) => void;
  callbackOrigin: string | null;
}) {
  const [busy, setBusy] = useState("");
  const [instance, setInstance] = useState("https://mastodon.social");
  const [bskyIdentifier, setBskyIdentifier] = useState("");
  const [bskyPassword, setBskyPassword] = useState("");
  const [showBsky, setShowBsky] = useState(false);
  const [showMasto, setShowMasto] = useState(false);

  async function startConnect(platform: string, extra?: Record<string, string>) {
    if (!companyId) return;
    setBusy(platform);
    try {
      const query = new URLSearchParams({ companyId, ...(extra ?? {}) });
      const res = await fetch(`/api/plugins/partnersinbiz.social/api/oauth/${platform}/start?${query.toString()}`, {
        credentials: "include",
      });
      const data = await res.json() as { error?: string; connectUrl?: string; mode?: string; state?: string };
      if (!res.ok) throw new Error(data.error ?? "Connect failed");
      if (data.mode === "credentials") {
        setShowBsky(true);
        return;
      }
      if (data.connectUrl) window.location.assign(data.connectUrl);
    } catch (error) {
      onMessage(errorText(error));
    } finally {
      setBusy("");
    }
  }

  async function completeBluesky() {
    if (!companyId || !bskyIdentifier || !bskyPassword) return;
    setBusy("bluesky");
    try {
      const startRes = await fetch(`/api/plugins/partnersinbiz.social/api/oauth/bluesky/start?companyId=${encodeURIComponent(companyId)}`, {
        credentials: "include",
      });
      const startData = await startRes.json() as { error?: string; state?: string };
      if (!startRes.ok) throw new Error(startData.error ?? "Connect failed");
      const res = await fetch("/api/plugins/partnersinbiz.social/api/oauth/complete", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: startData.state, platform: "bluesky", identifier: bskyIdentifier, password: bskyPassword, companyId }),
      });
      const data = await res.json() as { error?: string; displayName?: string };
      if (!res.ok) throw new Error(data.error ?? "Connect failed");
      setBskyIdentifier("");
      setBskyPassword("");
      setShowBsky(false);
      onMessage(`Connected Bluesky (${data.displayName ?? ""}) \u2713`);
      onChanged();
    } catch (error) {
      onMessage(errorText(error));
    } finally {
      setBusy("");
    }
  }

  return (
    <div style={{ display: "grid", gap: 12, padding: 14, borderRadius: 12, border: "1px solid var(--border)", background: "var(--card)" }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--foreground)" }}>Connect accounts (OAuth)</div>
      <div style={{ fontSize: 12, color: "var(--muted-foreground)", lineHeight: 1.5 }}>
        Register this callback URL in each OAuth app:{" "}
        <code style={{ fontFamily: "ui-monospace, monospace", fontSize: 11 }}>{callbackOrigin ?? window.location.origin}/social/oauth/callback</code>
        . Paste the app's client ID + secret in the plugin settings, then connect below.
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {CONNECT_PLATFORMS.map((p) => (
          <Button
            key={p.id}
            type="button"
            variant="secondary"
            disabled={busy !== ""}
            onClick={() => {
              if (p.credentialConnect) {
                void startConnect(p.id);
              } else if (p.needsInstance) {
                setShowMasto((v) => !v);
              } else {
                void startConnect(p.id);
              }
            }}
          >
            {busy === p.id ? "Connecting…" : `+ ${p.label}`}
          </Button>
        ))}
      </div>
      {showMasto ? (
        <div style={{ display: "grid", gap: 8, gridTemplateColumns: "1fr auto" }}>
          <Input value={instance} onChange={(event) => setInstance(event.target.value)} placeholder="https://mastodon.social" />
          <Button type="button" onClick={() => { void startConnect("mastodon", { instance }); setShowMasto(false); }}>Connect Mastodon</Button>
        </div>
      ) : null}
      {showBsky ? (
        <div style={{ display: "grid", gap: 8, maxWidth: 420 }}>
          <Field label="Bluesky handle"><Input value={bskyIdentifier} onChange={(event) => setBskyIdentifier(event.target.value)} placeholder="you.bsky.social" autoComplete="username" /></Field>
          <Field label="App password"><Input type="password" value={bskyPassword} onChange={(event) => setBskyPassword(event.target.value)} placeholder="xxxx-xxxx-xxxx-xxxx" autoComplete="current-password" /></Field>
          <div><Button type="button" onClick={() => void completeBluesky()} disabled={busy !== ""}>Connect Bluesky</Button></div>
        </div>
      ) : null}
    </div>
  );
}
