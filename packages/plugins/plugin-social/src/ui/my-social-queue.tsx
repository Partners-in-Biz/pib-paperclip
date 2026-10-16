import { useState, type ReactNode } from "react";
import { Button, EmptyState, Field, Input, Modal, tokens, tone } from "@partnersinbiz/pib-plugin-ui";
import { Card, fmtDate, ignore, Muted, platformLabel, Row, SmallButton, timeLabel, toLocalInput } from "./parts.js";
import type { Account, Post, RunAction, Snapshot } from "./types.js";
import { Section } from "./my-social.js";

export function QueueTab({ posts, snapshot, run, onRefresh }: { posts: Post[]; snapshot: Snapshot; run: RunAction; onRefresh: () => Promise<void> }) {
  const [composing, setComposing] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  const drafts = posts.filter((p) => p.status === "draft");
  const scheduled = posts.filter((p) => p.status === "scheduled");
  const published = posts.filter((p) => p.status === "published");
  const failed = posts.filter((p) => p.status === "failed");

  const personalAccounts = Array.isArray(snapshot.accounts)
    ? snapshot.accounts.filter((a) => a.client === null)
    : [];

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
    <Card style={{ gap: 10 } as any}>
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
        <Card style={{ gap: 8, background: tone("info").soft, border: `1px solid ${tone("info").border}` } as any}>
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

function ScheduledPostCard({ post, snapshot, run, onRefresh }: { post: Post; snapshot: Snapshot; run: RunAction; onRefresh: () => Promise<void> }) {
  const [cancelling, setCancelling] = useState(false);

  const handleCancel = async () => {
    if (!window.confirm("Unschedule this post?")) return;
    try {
      setCancelling(true);
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
    <Card style={{ gap: 10 } as any}>
      <Row style={{ justifyContent: "space-between" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>{post.body}</div>
        </div>
        <Muted style={{ whiteSpace: "nowrap" }}>{timeLabel(post)}</Muted>
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

function PublishedPostCard({ post, snapshot }: { post: Post; snapshot: Snapshot }) {
  const destinations = post.destinations.filter((d) => d.accountId);

  return (
    <Card style={{ gap: 10 } as any}>
      <Row style={{ justifyContent: "space-between" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>{post.body}</div>
        </div>
        {post.publishedAt ? <Muted style={{ whiteSpace: "nowrap" }}>{fmtDate(post.publishedAt, snapshot.config.timezone)}</Muted> : null}
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
    </Card>
  );
}

function FailedPostCard({ post, snapshot, run, onRefresh }: { post: Post; snapshot: Snapshot; run: RunAction; onRefresh: () => Promise<void> }) {
  const [retrying, setRetrying] = useState(false);

  const handleRetry = async () => {
    try {
      setRetrying(true);
      await run("my-social.retry-post", { postId: post.id }, "Retrying…");
      await onRefresh();
    } catch (e) {
      // Error already shown
    } finally {
      setRetrying(false);
    }
  };

  const destinations = post.destinations.filter((d) => d.accountId);

  return (
    <Card style={{ gap: 10 } as any}>
      <div style={{ fontSize: 13, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>{post.body}</div>
      {post.error ? <Muted style={{ color: tone("bad").fg }}>{post.error}</Muted> : null}
      {destinations.length > 0 ? (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {destinations.map((d) => (
            <div key={d.id} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 6, background: tokens.secondary }}>
              {platformLabel(d.platform)}
            </div>
          ))}
        </div>
      ) : null}
      <SmallButton onClick={handleRetry} disabled={retrying}>
        Retry
      </SmallButton>
    </Card>
  );
}

function Composer({ accounts, existingPost, snapshot, run, onClose, onSuccess }: { accounts: Account[]; existingPost: Post | null; snapshot: Snapshot; run: RunAction; onClose: () => void; onSuccess: () => void }) {
  const [bodies, setBodies] = useState<Record<string, string>>({ ...Object.fromEntries(accounts.map((a) => [a.id, existingPost?.body || ""])) });

  const handleSave = async () => {
    if (!Object.values(bodies).some((b) => b.trim())) return;
    try {
      const params = {
        postId: existingPost?.id,
        bodies,
      };
      await run(existingPost ? "my-social.update-draft" : "my-social.create-draft", params, existingPost ? "Draft updated" : "Draft created");
      onSuccess();
    } catch (e) {
      // Error already shown
    }
  };

  return (
    <Modal open={true} onClose={onClose} title={existingPost ? "Edit draft" : "New draft"}>
      <div style={{ display: "grid", gap: 12 }}>
        {accounts.length === 0 ? (
          <p>No personal accounts connected. Connect one to create a draft.</p>
        ) : (
          <>
            {accounts.map((account) => (
              <Field key={account.id} label={`Draft for ${account.displayName || account.handle}`}>
                <textarea
                  value={bodies[account.id] || ""}
                  onChange={(e) => setBodies({ ...bodies, [account.id]: e.target.value })}
                  placeholder={`What's on your mind? (${account.platform})`}
                  style={{ minHeight: 80, width: "100%" }}
                />
                <div style={{ fontSize: 11, marginTop: 4 }}>
                  {(bodies[account.id] || "").length} character(s)
                </div>
              </Field>
            ))}
            <Row>
              <Button type="button" onClick={handleSave}>
                {existingPost ? "Update" : "Create"}
              </Button>
              <Button type="button" variant="secondary" onClick={onClose}>
                Cancel
              </Button>
            </Row>
          </>
        )}
      </div>
    </Modal>
  );
}
