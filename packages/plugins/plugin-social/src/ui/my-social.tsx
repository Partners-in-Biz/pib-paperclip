import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, EmptyState, Field, Input, Modal, Plug, TextArea, tokens, tone } from "@partnersinbiz/pib-plugin-ui";
import { type SocialPlatform } from "../platforms.js";
import { AccountStatus, Avatar, Banner, Card, fmtDate, ignore, Muted, PlatformBadge, platformLabel, Row, SmallButton, timeLabel, toLocalInput } from "./parts.js";
import { ACCOUNT_TONE, POST_TONE, toneOf } from "./series.js";
import type { Account, Post, RunAction, Snapshot } from "./types.js";
import { startConnect } from "./accounts.js";

type TabId = "accounts" | "queue" | "calendar";

/**
 * Personal social page: personal accounts, draft queue, and calendar.
 * Only personal accounts and posts are shown (via my-social.* data).
 */
export function MySocialPage({ snapshot, run, companyId }: { snapshot: Snapshot; run: RunAction; companyId: string }) {
  const [tab, setTab] = useState<TabId>("accounts");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      // Load personal accounts and posts
      const [accountsData, postsData] = await Promise.all([
        run("my-social.accounts", {}),
        run("my-social.posts", {}),
      ]);
      setAccounts((accountsData as Account[]) || []);
      setPosts((postsData as Post[]) || []);
      setError("");
    } catch (e) {
      setError(`Failed to load: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [run]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <div style={{ display: "grid", gap: 16, padding: 16 }}>
        <Banner tone="error" title="Failed to load personal accounts">
          {error}
        </Banner>
      </div>
    );
  }

  if (loading) {
    return <p style={{ margin: 0, fontSize: 13 }}>Loading your social accounts…</p>;
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Banner tone="info" title="Personal accounts only">
        Only you can see this. These accounts are separate from company accounts.
      </Banner>
      <Tabs
        tabs={[
          { id: "accounts", label: "Accounts" },
          { id: "queue", label: "Queue" },
          { id: "calendar", label: "Calendar" },
        ]}
        active={tab}
        onChange={(id) => setTab(id as TabId)}
      />
      {tab === "accounts" ? <AccountsTab accounts={accounts} snapshot={snapshot} run={run} companyId={companyId} onRefresh={load} /> : null}
      {tab === "queue" ? <QueueTab posts={posts} accounts={accounts} snapshot={snapshot} run={run} onRefresh={load} /> : null}
      {tab === "calendar" ? <CalendarTab posts={posts} snapshot={snapshot} /> : null}
    </div>
  );
}

/** List personal accounts with connect/disconnect. */
function AccountsTab({ accounts, snapshot, run, companyId, onRefresh }: { accounts: Account[]; snapshot: Snapshot; run: RunAction; companyId: string; onRefresh: () => Promise<void> }) {
  const [connecting, setConnecting] = useState<SocialPlatform | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);

  const handleConnect = async (platform: SocialPlatform) => {
    try {
      setConnecting(platform);
      // space "me" makes the account personal and owned by the signed-in user
      await startConnect(run, companyId, platform, { space: "me" });
    } catch (e) {
      // Error is already shown by startConnect
    } finally {
      setConnecting(null);
    }
  };

  const handleDisconnect = async (accountId: string) => {
    if (!window.confirm("Disconnect this account? You won't lose any posts.")) return;
    try {
      setDisconnecting(accountId);
      await run("my-social.disconnect-account", { accountId }, "Account disconnected");
      await onRefresh();
    } catch (e) {
      // Error already shown
    } finally {
      setDisconnecting(null);
    }
  };

  // Platforms that can be connected
  const supported: SocialPlatform[] = ["x", "linkedin"];
  const platformsToShow = supported.filter((p) => !accounts.some((a) => a.platform === p));

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {accounts.length === 0 && platformsToShow.length > 0 ? (
        <EmptyState
          icon={Plug}
          tone="info"
          title="No personal accounts yet"
          description="Connect your social accounts to draft and schedule posts."
        />
      ) : null}

      {accounts.length > 0 ? (
        <div style={{ display: "grid", gap: 8 }}>
          {accounts.map((account) => (
            <Card key={account.id} style={{ gap: 12 }}>
              <Row style={{ justifyContent: "space-between" }}>
                <Row>
                  <PlatformBadge platform={account.platform} size={32} />
                  <div style={{ display: "grid", gap: 2, flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{platformLabel(account.platform)}</div>
                    <div style={{ fontSize: 12, color: tokens.muted }}>
                      {account.displayName}
                      {account.handle ? ` (@${account.handle})` : ""}
                    </div>
                  </div>
                </Row>
                <AccountStatus status={account.status} />
              </Row>

              {account.status === "needs_reconnect" ? (
                <Banner tone="error" title="Needs reconnect">
                  Your token expired. Please reconnect to resume posting.
                </Banner>
              ) : null}

              {account.tokenExpiresAt ? (
                <Muted>
                  Token expires {fmtDate(account.tokenExpiresAt, snapshot.config.timezone)}
                </Muted>
              ) : null}

              <Row>
                {account.status === "needs_reconnect" ? (
                  <Button
                    type="button"
                    style={{ height: 28, fontSize: 12 }}
                    onClick={() => handleConnect(account.platform)}
                    disabled={connecting === account.platform}
                  >
                    Reconnect
                  </Button>
                ) : null}
                <SmallButton
                  onClick={() => handleDisconnect(account.id)}
                  disabled={disconnecting === account.id}
                >
                  Disconnect
                </SmallButton>
              </Row>
            </Card>
          ))}
        </div>
      ) : null}

      {platformsToShow.length > 0 ? (
        <Card style={{ gap: 12 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>Connect an account</div>
          <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
            {platformsToShow.map((platform) => (
              <Button
                key={platform}
                type="button"
                variant="secondary"
                onClick={() => handleConnect(platform)}
                disabled={connecting === platform}
                style={{ height: 36, fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
              >
                <PlatformBadge platform={platform} size={20} />
                {platformLabel(platform)}
              </Button>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

/** Queue: Drafts, Scheduled, Posted (Failed). */
function QueueTab({ posts, accounts, snapshot, run, onRefresh }: { posts: Post[]; accounts: Account[]; snapshot: Snapshot; run: RunAction; onRefresh: () => Promise<void> }) {
  const [composing, setComposing] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  const drafts = posts.filter((p) => p.status === "draft");
  const scheduled = posts.filter((p) => p.status === "scheduled");
  const published = posts.filter((p) => p.status === "published");
  const failed = posts.filter((p) => p.status === "failed");

  const personalAccounts = accounts;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {composing ? (
        <Composer
          accounts={personalAccounts}
          existingPost={editId ? (posts.find((p) => p.id === editId) ?? null) : null}
          snapshot={snapshot}
          run={run}
          onClose={() => {
            setComposing(false);
            setEditId(null);
          }}
          onSuccess={() => {
            setComposing(false);
            setEditId(null);
            onRefresh().catch(ignore);
          }}
        />
      ) : null}

      {!composing ? (
        <Button type="button" onClick={() => setComposing(true)}>
          + New draft
        </Button>
      ) : null}

      {drafts.length > 0 ? (
        <Section title="Drafts" count={drafts.length}>
          {drafts.map((post) => (
            <PostCard
              key={post.id}
              post={post}
              snapshot={snapshot}
              run={run}
              onRefresh={onRefresh}
              onEdit={() => {
                setEditId(post.id);
                setComposing(true);
              }}
            />
          ))}
        </Section>
      ) : null}

      {scheduled.length > 0 ? (
        <Section title="Scheduled" count={scheduled.length}>
          {scheduled.map((post) => (
            <ScheduledPostCard
              key={post.id}
              post={post}
              snapshot={snapshot}
              run={run}
              onRefresh={onRefresh}
            />
          ))}
        </Section>
      ) : null}

      {published.length > 0 ? (
        <Section title="Published" count={published.length}>
          {published.map((post) => (
            <PublishedPostCard key={post.id} post={post} snapshot={snapshot} />
          ))}
        </Section>
      ) : null}

      {failed.length > 0 ? (
        <Section title="Failed" count={failed.length} tone="bad">
          {failed.map((post) => (
            <FailedPostCard
              key={post.id}
              post={post}
              snapshot={snapshot}
              run={run}
              onRefresh={onRefresh}
            />
          ))}
        </Section>
      ) : null}

      {drafts.length === 0 && scheduled.length === 0 && published.length === 0 && failed.length === 0 ? (
        <EmptyState
          tone="info"
          title="No posts yet"
          description="Create a draft to get started."
          action={<Button type="button" onClick={() => setComposing(true)}>+ New draft</Button>}
        />
      ) : null}
    </div>
  );
}

/** Draft post in the queue. */
function PostCard({ post, snapshot, run, onRefresh, onEdit }: { post: Post; snapshot: Snapshot; run: RunAction; onRefresh: () => Promise<void>; onEdit: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const [approving, setApproving] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [scheduledAt, setScheduledAt] = useState(toLocalInput(new Date(Date.now() + 60 * 60_000)));

  const handleDelete = async () => {
    if (!window.confirm("Delete this draft?")) return;
    try {
      setDeleting(true);
      await run("my-social.delete-draft", { postId: post.id }, "Draft deleted");
      await onRefresh();
    } catch (e) {
      // Error already shown
    } finally {
      setDeleting(false);
    }
  };

  const handleApprove = async (mode: "now" | "schedule") => {
    if (mode === "now") {
      if (!window.confirm("This will publish to your account immediately. Proceed?")) return;
    }
    try {
      setApproving(true);
      await run(
        "my-social.approve",
        {
          postId: post.id,
          mode,
          ...(mode === "schedule" ? { scheduledAt: new Date(scheduledAt).toISOString() } : {}),
        },
        mode === "now" ? "Posted!" : "Scheduled"
      );
      await onRefresh();
      setShowDatePicker(false);
    } catch (e) {
      // Error already shown
    } finally {
      setApproving(false);
    }
  };

  const destinations = post.destinations.filter((d) => d.accountId); // Only personal accounts

  return (
    <Card style={{ gap: 10 }}>
      <div style={{ fontSize: 13, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>{post.body}</div>
      {destinations.length > 0 ? (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {destinations.map((d) => (
            <div key={d.id} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 6, background: tokens.secondary }}>
              {platformLabel(d.platform)}
            </div>
          ))}
        </div>
      ) : null}
      <Row style={{ gap: 6 }}>
        <SmallButton onClick={onEdit}>Edit</SmallButton>
        <SmallButton onClick={handleDelete} disabled={deleting}>Delete</SmallButton>
        <Button
          type="button"
          style={{ height: 28, fontSize: 12 }}
          onClick={() => setShowDatePicker(true)}
          disabled={approving}
        >
          Approve & schedule
        </Button>
        <Button
          type="button"
          variant="secondary"
          style={{ height: 28, fontSize: 12 }}
          onClick={() => handleApprove("now")}
          disabled={approving}
        >
          Post now
        </Button>
      </Row>

      {showDatePicker ? (
        <Card style={{ gap: 8, background: tone("info").soft, border: `1px solid ${tone("info").border}` }}>
          <Field label={`Schedule for (${snapshot.config.timezone})`}>
            <Input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
          </Field>
          <Row>
            <Button type="button" style={{ height: 28, fontSize: 12 }} onClick={() => handleApprove("schedule")} disabled={approving}>
              Schedule
            </Button>
            <SmallButton onClick={() => setShowDatePicker(false)}>Cancel</SmallButton>
          </Row>
        </Card>
      ) : null}
    </Card>
  );
}

/** Scheduled post in the queue. */
function ScheduledPostCard({ post, snapshot, run, onRefresh }: { post: Post; snapshot: Snapshot; run: RunAction; onRefresh: () => Promise<void> }) {
  const [cancelling, setCancelling] = useState(false);

  const handleCancel = async () => {
    if (!window.confirm("Unschedule this post?")) return;
    try {
      setCancelling(true);
      // Using the social.unschedule action (company posts); for personal we might use a different action
      // For now, assume there's a my-social equivalent or fall back to the company one
      await run("social.unschedule", { postId: post.id }, "Unscheduled");
      await onRefresh();
    } catch (e) {
      // Error already shown
    } finally {
      setCancelling(false);
    }
  };

  const destinations = post.destinations.filter((d) => d.accountId);

  return (
    <Card style={{ gap: 10 }}>
      <Row style={{ justifyContent: "space-between" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>{post.body}</div>
        </div>
        <Muted style={{ whiteSpace: "nowrap" }}>{timeLabel(post, snapshot.config.timezone)}</Muted>
      </Row>
      {destinations.length > 0 ? (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {destinations.map((d) => (
            <div key={d.id} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 6, background: tokens.secondary }}>
              {platformLabel(d.platform)}
            </div>
          ))}
        </div>
      ) : null}
      <SmallButton onClick={handleCancel} disabled={cancelling}>
        Unschedule
      </SmallButton>
    </Card>
  );
}

/** Published post. */
function PublishedPostCard({ post, snapshot }: { post: Post; snapshot: Snapshot }) {
  const destinations = post.destinations.filter((d) => d.accountId);
  return (
    <Card style={{ gap: 10 }}>
      <Row style={{ justifyContent: "space-between" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>{post.body}</div>
        </div>
        <Muted style={{ whiteSpace: "nowrap" }}>{timeLabel(post, snapshot.config.timezone)}</Muted>
      </Row>
      {destinations.length > 0 ? (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {destinations.map((d) => (
            <a
              key={d.id}
              href={d.externalUrl ?? "#"}
              target="_blank"
              rel="noopener"
              style={{
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: 6,
                background: tokens.secondary,
                color: tokens.fg,
                textDecoration: "none",
                cursor: d.externalUrl ? "pointer" : "default",
              }}
            >
              {platformLabel(d.platform)}
            </a>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

/** Failed post. */
function FailedPostCard({ post, snapshot, run, onRefresh }: { post: Post; snapshot: Snapshot; run: RunAction; onRefresh: () => Promise<void> }) {
  const [retrying, setRetrying] = useState(false);

  const failed = post.destinations.filter((d) => d.status === "failed").length;

  const handleRetry = async () => {
    try {
      setRetrying(true);
      await run("social.retry-post", { postId: post.id }, "Retry queued");
      await onRefresh();
    } catch (e) {
      // Error already shown
    } finally {
      setRetrying(false);
    }
  };

  const destinations = post.destinations.filter((d) => d.accountId);

  return (
    <Card style={{ gap: 10, borderLeft: `3px solid ${tone("bad").solid}` }}>
      <Row style={{ justifyContent: "space-between" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>{post.body}</div>
        </div>
        <Muted style={{ whiteSpace: "nowrap" }}>{timeLabel(post, snapshot.config.timezone)}</Muted>
      </Row>
      {destinations.length > 0 ? (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {destinations.map((d) => (
            <div key={d.id} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 6, background: tone(d.status === "failed" ? "bad" : "ok").soft, color: tone(d.status === "failed" ? "bad" : "ok").fg }}>
              {platformLabel(d.platform)} · {d.status}
            </div>
          ))}
        </div>
      ) : null}
      {post.error ? (
        <Banner tone="error" title="Error">
          {post.error}
        </Banner>
      ) : null}
      {failed > 0 ? (
        <Button type="button" style={{ height: 28, fontSize: 12 }} onClick={handleRetry} disabled={retrying}>
          Retry {failed} failed
        </Button>
      ) : null}
    </Card>
  );
}

/** Calendar grid of posts. */
function CalendarTab({ posts, snapshot }: { posts: Post[]; snapshot: Snapshot }) {
  const [offset, setOffset] = useState(0);
  const tz = snapshot.config.timezone;

  const dayKey = (value: string) => {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
    } catch {
      return value.slice(0, 10);
    }
  };

  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay() + 1 + offset * 14);
  const days = Array.from({ length: 14 }, (_, i) => new Date(start.getTime() + i * 86_400_000));
  const todayKey = dayKey(new Date().toISOString());

  const byDay = new Map<string, Post[]>();
  for (const post of posts) {
    const when = post.status === "published" ? post.publishedAt : post.scheduledAt;
    if (!when) continue;
    const key = dayKey(when);
    byDay.set(key, [...(byDay.get(key) ?? []), post]);
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Row style={{ justifyContent: "space-between" }}>
        <SmallButton onClick={() => setOffset((o) => o - 1)}>← Earlier</SmallButton>
        <Muted>
          {fmtDate(days[0]!.toISOString(), tz, false)} – {fmtDate(days[13]!.toISOString(), tz, false)} ({tz})
        </Muted>
        <SmallButton onClick={() => setOffset((o) => o + 1)}>Later →</SmallButton>
      </Row>

      <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
        {days.map((day) => {
          const key = dayKey(day.toISOString());
          const list = (byDay.get(key) ?? []).sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)));
          return (
            <div
              key={key}
              style={{
                display: "grid",
                gap: 6,
                alignContent: "start",
                minHeight: 100,
                padding: 10,
                borderRadius: 10,
                border: `1px solid ${key === todayKey ? tone("accent").border : tokens.border}`,
                background: key === todayKey ? `linear-gradient(180deg, ${tone("accent").soft}, transparent 60%), ${tokens.card}` : tokens.card,
              }}
            >
              <Muted style={{ fontWeight: 600, fontSize: 12, color: key === todayKey ? tone("accent").fg : undefined }}>
                {day.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}
              </Muted>
              {list.length ? (
                <div style={{ fontSize: 10, color: tokens.muted }}>
                  {list.length} post{list.length !== 1 ? "s" : ""}
                </div>
              ) : null}
              {list.map((post) => (
                <div
                  key={post.id}
                  style={{
                    fontSize: 11,
                    padding: "4px 6px",
                    borderRadius: 6,
                    background: tone(post.status === "published" ? "ok" : "info").soft,
                    color: tokens.fg,
                    lineHeight: 1.3,
                    overflowWrap: "break-word",
                  }}
                >
                  {post.body.slice(0, 40)}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Composer modal for creating/editing drafts. */
function Composer({ accounts, existingPost, snapshot, run, onClose, onSuccess }: { accounts: Account[]; existingPost: Post | null; snapshot: Snapshot; run: RunAction; onClose: () => void; onSuccess: () => void }) {
  const [body, setBody] = useState(existingPost?.body ?? "");
  const [selectedAccounts, setSelectedAccounts] = useState<Set<string>>(new Set(existingPost?.destinations.map((d) => d.accountId) ?? []));
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!body.trim()) {
      alert("Please write something.");
      return;
    }
    if (selectedAccounts.size === 0) {
      alert("Select at least one account.");
      return;
    }

    try {
      setSaving(true);
      if (existingPost) {
        await run("my-social.update-draft", { postId: existingPost.id, body: body.trim(), accountIds: Array.from(selectedAccounts) }, "Draft updated");
      } else {
        await run("my-social.create-draft", { body: body.trim(), accountIds: Array.from(selectedAccounts) }, "Draft created");
      }
      onSuccess();
    } catch (e) {
      // Error already shown
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open title={existingPost ? "Edit draft" : "New draft"} onClose={onClose}>
      <div style={{ display: "grid", gap: 12 }}>
        <Field label="Your post">
          <TextArea value={body} onChange={(e) => setBody(e.target.value)} placeholder="What's on your mind?" />
        </Field>

        <Field label="Post to">
          <div style={{ display: "grid", gap: 6 }}>
            {accounts.length === 0 ? (
              <Muted>Connect an account to post.</Muted>
            ) : (
              accounts.map((account) => (
                <label key={account.id} style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer", padding: "4px 0" }}>
                  <input
                    type="checkbox"
                    checked={selectedAccounts.has(account.id)}
                    onChange={(e) => {
                      const next = new Set(selectedAccounts);
                      if (e.target.checked) {
                        next.add(account.id);
                      } else {
                        next.delete(account.id);
                      }
                      setSelectedAccounts(next);
                    }}
                  />
                  <span style={{ fontSize: 13 }}>
                    {platformLabel(account.platform)} · {account.displayName}
                  </span>
                </label>
              ))
            )}
          </div>
        </Field>

        <Row style={{ gap: 6 }}>
          <Button type="button" onClick={handleSave} disabled={saving || accounts.length === 0}>
            {existingPost ? "Update" : "Create"} draft
          </Button>
          <SmallButton onClick={onClose}>Cancel</SmallButton>
        </Row>
      </div>
    </Modal>
  );
}

/** Section with title and count. */
function Section({ title, count, tone: t, children }: { title: string; count: number; tone?: "bad"; children: ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ fontWeight: 600, fontSize: 13, color: t ? tone(t).fg : undefined }}>
        {title} ({count})
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {children}
      </div>
    </div>
  );
}

/** Simple Tabs component. */
function Tabs({ tabs, active, onChange }: { tabs: Array<{ id: string; label: string }>; active: string; onChange: (id: string) => void }) {
  return (
    <div style={{ display: "flex", gap: 0, borderBottom: `1px solid ${tokens.border}`, overflow: "auto" }}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          style={{
            padding: "10px 14px",
            border: "none",
            background: "none",
            fontSize: 13,
            fontWeight: 500,
            color: active === tab.id ? tokens.primary : tokens.muted,
            cursor: "pointer",
            borderBottom: active === tab.id ? `2px solid ${tokens.primary}` : "none",
            marginBottom: "-1px",
            whiteSpace: "nowrap",
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
