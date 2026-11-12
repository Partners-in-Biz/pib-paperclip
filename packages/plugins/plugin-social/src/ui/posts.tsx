import { useEffect, useMemo, useState } from "react";
import { Button, ChartLegend, EmptyState, Field, FileText, Input, Pill, Sheet, Toolbar, fluidColumns, tokens, tone } from "@partnersinbiz/pib-plugin-ui";
import { editableViaDraft, PLATFORM_LABELS, isSocialPlatform, xReplyIntentUrl } from "../platforms.js";
import { ApprovalPolicyCard, PostApproval } from "./approvals.js";
import { Thumb } from "./composer.js";
import { MediaViewer } from "./media-viewer.js";
import { canPostByHand, HandPost } from "./hand-post.js";
import { Banner, Card, chipStyle, destinationLabel, DestinationStatus, ExternalLink, fmtDate, ignore, Muted, PlatformBadge, platformLabel, PostStatus, Row, SmallButton, timeLabel, toLocalInput } from "./parts.js";
import { DEST_TONE, POST_TONE, toneOf } from "./series.js";
import { AccountPicker, AskForChanges, Switch, useStoredChoice } from "./post-tools.js";
import { PostPreview, previewAccounts } from "./preview.js";
import { PostTarget } from "./target.js";
import type { Account, ApprovalOutcome, Post, RunAction, Snapshot } from "./types.js";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "draft", label: "Drafts" },
  { id: "review", label: "In review" },
  { id: "approved", label: "Approved" },
  { id: "scheduled", label: "Scheduled" },
  { id: "published", label: "Published" },
  { id: "by_hand", label: "Post by hand" },
  { id: "problems", label: "Failed" },
];

/** The publish time came and a person still has to post it on a manual account. */
const waitsForHand = (post: Post): boolean => post.destinations.some((d) => d.status === "awaiting_manual");

export function PostsTab({ posts, snapshot, run, onOpen, onNew }: { posts: Post[]; snapshot: Snapshot; run: RunAction; onOpen: (post: Post) => void; onNew: () => void }) {
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  // List: compact rows. Preview: each post as its platform shows it.
  const [view, setView] = useStoredChoice("pib.social.posts.view", ["list", "preview"] as const, "list");
  const q = search.trim().toLowerCase();
  const count = (id: string) => id === "all" ? posts.length : id === "by_hand" ? posts.filter(waitsForHand).length : id === "problems" ? posts.filter((p) => p.status === "failed" || p.status === "partially_published").length : posts.filter((p) => p.status === id).length;
  const rows = useMemo(() => posts.filter((post) => {
    if (filter === "problems" && post.status !== "failed" && post.status !== "partially_published") return false;
    if (filter === "published" && post.status !== "published") return false;
    if (filter === "by_hand" && !waitsForHand(post)) return false;
    if (!["all", "problems", "published", "by_hand"].includes(filter) && post.status !== filter) return false;
    return !q || post.body.toLowerCase().includes(q);
  }), [posts, filter, q]);
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {snapshot.space === "me" ? null : <ApprovalPolicyCard snapshot={snapshot} run={run} />}
      <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search posts…">
        {FILTERS.map((f) => (
          <SmallButton key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)} style={{ ...chipStyle(filter === f.id), ...(f.id === "problems" && count(f.id) && filter !== f.id ? { color: tone("bad").fg, borderColor: tone("bad").border } : {}), ...(f.id === "by_hand" && count(f.id) && filter !== f.id ? { color: tone("warn").fg, borderColor: tone("warn").border } : {}) }}>{f.label}{count(f.id) ? ` (${count(f.id)})` : ""}</SmallButton>
        ))}
        <Switch label="How posts are shown" value={view} onChange={setView} options={[{ id: "list", label: "List" }, { id: "preview", label: "Preview" }]} />
        {snapshot.canPost === false ? null : <Button type="button" onClick={onNew}>+ New post</Button>}
      </Toolbar>
      {rows.length === 0 ? (
        <EmptyState icon={FileText} title="No posts here" description="Write a post, pick destinations, and send it for review." action={snapshot.canPost === false ? undefined : <Button type="button" onClick={onNew}>+ New post</Button>} />
      ) : view === "preview" ? (
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: fluidColumns(300, "auto-fill"), alignItems: "start" }}>
          {rows.map((post) => (
            <div key={post.id} style={{ display: "grid", gap: 8, padding: 12, borderRadius: 12, border: `1px solid ${tokens.border}`, borderTop: `3px solid ${tone(toneOf(POST_TONE, post.status)).solid}`, background: tokens.card, minWidth: 0 }}>
              <Row style={{ justifyContent: "space-between" }}>
                <Row>
                  <PostStatus status={post.status} />
                  {waitsForHand(post) ? <Pill size="sm" tone="warn" dot>post by hand</Pill> : null}
                </Row>
                <SmallButton onClick={() => onOpen(post)}>Open</SmallButton>
              </Row>
              <Muted>{timeLabel(post, snapshot.config.timezone)}</Muted>
              <PostTarget post={post} compact />
              <PostPreview source={post} accounts={previewAccounts(snapshot.accounts, post.destinations)} empty="No account picked yet." />
            </div>
          ))}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {rows.map((post) => (
            <button
              key={post.id}
              type="button"
              onClick={() => onOpen(post)}
              style={{ appearance: "none", textAlign: "left", display: "grid", gap: 6, padding: 12, borderRadius: 12, border: `1px solid ${tokens.border}`, borderLeft: `3px solid ${tone(toneOf(POST_TONE, post.status)).solid}`, background: tokens.card, color: tokens.fg, cursor: "pointer", fontFamily: "inherit", minWidth: 0 }}
            >
              <Row style={{ justifyContent: "space-between" }}>
                <Row>
                  <PostStatus status={post.status} />
                  {waitsForHand(post) ? <Pill size="sm" tone="warn" dot>post by hand</Pill> : null}
                  {post.source !== "manual" ? <Muted>{post.source.replace("_", " ")}</Muted> : null}
                </Row>
                <Muted>{timeLabel(post, snapshot.config.timezone)}</Muted>
              </Row>
              <PostTarget post={post} compact />
              <div style={{ fontSize: 13, lineHeight: 1.45, whiteSpace: "pre-wrap", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" }}>{post.body}</div>
              <Row>
                {post.destinations.map((d) => (
                  <Pill key={d.id} size="sm" variant="outline" tone={toneOf(DEST_TONE, d.status)} dot>{platformLabel(d.platform)} · {destinationLabel(d.status)}</Pill>
                ))}
                {post.media.length ? <Muted>{post.media.length} media</Muted> : null}
              </Row>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function PostDetail({ post, snapshot, run, onClose, onEdit }: { post: Post; snapshot: Snapshot; run: RunAction; onClose: () => void; onEdit: (post: Post) => void }) {
  const [problems, setProblems] = useState<string[] | null>(null);
  const [when, setWhen] = useState(toLocalInput(new Date(Date.now() + 60 * 60_000)));
  const [approval, setApproval] = useState<ApprovalOutcome | null>(null);
  const [waiting, setWaiting] = useState<string | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [look, setLook] = useStoredChoice("pib.social.post.look", ["preview", "text"] as const, "preview");
  const [toggling, setToggling] = useState<string | null>(null);
  const tz = snapshot.config.timezone;
  const isUser = Boolean(snapshot.viewer.userId);
  const proposed = (post.status === "draft" || post.status === "review") && post.scheduledAt ? post.scheduledAt : null;
  const approve = () =>
    run("social.approve", { postId: post.id })
      .then((res) => {
        const result = res as { approval?: ApprovalOutcome; signoff?: { completed: boolean; message: string } } | null;
        // Other sign-offs are still needed (the client, the Reviewer): say so instead of "Approved".
        if (result?.signoff && !result.signoff.completed) setWaiting(result.signoff.message);
        else setApproval(result?.approval ?? { scheduled: false, scheduledAt: null, message: "Approved." });
      })
      .catch(ignore);
  // Where the client alone approves, a team member has no Approve button: the link and the recorded approval are below.
  const teamApproves = snapshot.approvalPolicy?.requireOwner !== false;

  useEffect(() => {
    if (post.status === "published") return;
    let cancelled = false;
    run("social.validate-post", { postId: post.id })
      .then((res) => {
        if (!cancelled) setProblems((res as { problems?: string[] })?.problems ?? []);
      })
      .catch(ignore);
    return () => {
      cancelled = true;
    };
  }, [post.id, post.updatedAt, post.destinations.length]);

  // Accounts can change while the post can still be edited; a destination that has gone out stays.
  const canPick = (post.status === "draft" || post.status === "review") && isUser && snapshot.canPost !== false;
  const pickable: Account[] = canPick ? snapshot.accounts.filter((a) => (a.connected && a.status !== "needs_reconnect") || post.destinations.some((d) => d.accountId === a.id)) : [];
  const onPost = new Set(post.destinations.map((d) => d.accountId));
  const fixed = new Set(post.destinations.filter((d) => d.status !== "pending" && d.status !== "failed").map((d) => d.accountId));
  const toggleAccount = (account: Account) => {
    setToggling(account.id);
    run(onPost.has(account.id) ? "social.detach" : "social.attach", { postId: post.id, accountId: account.id })
      .catch(ignore)
      .finally(() => setToggling(null));
  };

  const act = (key: string, success: string, extra: Record<string, unknown> = {}) => run(key, { postId: post.id, ...extra }, success).catch(ignore);
  const failed = post.destinations.filter((d) => d.status === "failed").length;
  // A reply to an X post cannot go through the API, so it can be posted from X's own reply box instead.
  const xReply = post.status === "published" ? null : xReplyIntentUrl(post.replyTo?.id, post.overrides.x?.text?.trim() || post.body);

  return (
    <>
    <Sheet open title="Post" onClose={onClose}>
      <Row style={{ justifyContent: "space-between" }}>
        <Row>
          <PostStatus status={post.status} />
          {waitsForHand(post) ? <Pill size="sm" tone="warn" dot>post by hand</Pill> : null}
        </Row>
        <Muted>{snapshot.space === "me" ? "My Social" : post.clientName ?? "Own work"}</Muted>
      </Row>
      {post.error ? <Banner tone="error" title="Publishing problem">{post.error}{post.failureIssueId ? " An issue was opened for this post." : ""}</Banner> : null}
      <PostTarget post={post} />
      <Row style={{ justifyContent: "space-between" }}>
        <Muted>{look === "preview" ? "As it will look when posted" : "The post's text and media"}</Muted>
        <Switch label="How the post is shown" value={look} onChange={setLook} options={[{ id: "preview", label: "Preview" }, { id: "text", label: "Text" }]} />
      </Row>
      {look === "preview" ? (
        <PostPreview source={post} accounts={previewAccounts(snapshot.accounts, post.destinations)} empty="No account picked yet: this is a general look. Pick accounts below." />
      ) : (
        <>
          <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{post.body}</div>
          {post.firstComment ? <Muted>First comment: {post.firstComment}</Muted> : null}
        </>
      )}
      {post.media.length ? (
        <Row>{post.media.map((m, i) => <Thumb key={`${m.url}-${i}`} asset={{ url: m.url, kind: m.kind, name: m.altText ?? undefined }} onClick={() => setViewing(i)} />)}</Row>
      ) : null}
      {approval ? <Banner tone={approval.scheduled ? "info" : "warn"} title={approval.scheduled ? "Approved and scheduled" : "Approved"}>{approval.message}</Banner> : null}
      {waiting ? <Banner tone="info" title="Your approval is recorded">{waiting}</Banner> : null}
      {snapshot.space === "me" ? null : <PostApproval post={post} snapshot={snapshot} run={run} />}
      {proposed ? (
        <Muted>Proposed time: <strong>{fmtDate(proposed, tz)}</strong>. {post.status === "review" ? "Approving schedules it for then." : "Once approved it is scheduled for then."}</Muted>
      ) : null}
      {post.experimentId ? (
        <Muted>Growth Lab: {post.experimentArm} arm of "{snapshot.experiments.find((e) => e.experimentId === post.experimentId)?.hypothesis ?? "a closed experiment"}"</Muted>
      ) : null}
      {Object.keys(post.overrides).length ? (
        <Card style={{ gap: 6 }}>
          <strong style={{ fontSize: 12 }}>Overrides</strong>
          {Object.entries(post.overrides).map(([platform, o]) => (
            <Muted key={platform}>
              {isSocialPlatform(platform) ? PLATFORM_LABELS[platform] : platform}: {Object.entries(o ?? {}).map(([k, v]) => `${k} = ${String(v).slice(0, 80)}`).join(" · ")}
            </Muted>
          ))}
        </Card>
      ) : null}

      <Card style={{ gap: 8 }}>
        <strong style={{ fontSize: 12 }}>{canPick ? "Post to" : "Destinations"}</strong>
        {canPick && pickable.length ? (
          <>
            <Muted>Press an account to add it or take it off.{post.status === "review" ? " A change here means the post needs approving in its new form." : ""}</Muted>
            <AccountPicker accounts={pickable} selected={onPost} locked={fixed} busyId={toggling} onToggle={toggleAccount} />
          </>
        ) : null}
        {canPick && pickable.length === 0 ? <Muted>No connected accounts yet. Connect one on the Accounts tab.</Muted> : null}
        {!canPick && post.destinations.length === 0 ? <Muted>No destinations yet. Edit the post and pick accounts.</Muted> : null}
        {post.destinations.map((d) => (
          <div key={d.id} style={{ display: "grid", gap: 4, paddingTop: 6, borderTop: `1px solid ${tokens.border}` }}>
            <Row style={{ justifyContent: "space-between" }}>
              <Row style={{ flexWrap: "nowrap", minWidth: 0, flex: "1 1 180px" }}>
                <PlatformBadge platform={d.platform} size={22} />
                <span style={{ fontSize: 12, fontWeight: 600, overflowWrap: "anywhere", minWidth: 0 }}>{platformLabel(d.platform)} · {d.accountName}</span>
              </Row>
              <DestinationStatus status={d.status} />
            </Row>
            <Muted>
              Attempts {d.attempts}
              {d.nextAttemptAt && d.status === "retrying" ? ` · next try ${fmtDate(d.nextAttemptAt, tz)}` : ""}
              {d.publishedAt ? ` · published ${fmtDate(d.publishedAt, tz)}` : ""}
              {d.manual && d.status === "pending" ? " · a person posts this by hand at the publish time" : ""}
            </Muted>
            {d.lastError ? <Muted style={{ color: tone("bad").fg }}>{d.lastError}</Muted> : null}
            {canPostByHand(post, d, isUser)
              ? <HandPost post={post} destination={d} run={run} />
              : d.externalUrl ? <ExternalLink href={d.externalUrl}>View on {platformLabel(d.platform)}</ExternalLink> : null}
          </div>
        ))}
      </Card>

      {problems && problems.length ? (
        <Banner tone="warn" title="Fix before scheduling">{problems.map((p) => <div key={p}>• {p}</div>)}</Banner>
      ) : null}

      {xReply ? <Muted>X does not let us post this reply for you. Open it on X, post it there, then mark it as posted here.</Muted> : null}
      <Row>
        {xReply ? <Button type="button" style={{ height: 28, fontSize: 12 }} onClick={() => window.open(xReply, "_blank", "noopener")}>Open reply on X</Button> : null}
        {xReply && post.status !== "draft" && post.status !== "review" ? (
          <SmallButton onClick={() => {
            const url = window.prompt("Link to your reply on X (optional, leave empty to skip):", "");
            if (url === null) return;
            act("social.mark-posted", "Marked as posted", { url: url.trim() });
          }}>Mark as posted</SmallButton>
        ) : null}
        {post.status === "draft" || post.status === "review" || (editableViaDraft(post.status) && snapshot.canPost !== false) ? <SmallButton onClick={() => onEdit(post)}>Edit</SmallButton> : null}
        {post.status === "draft" && snapshot.space !== "me" ? <SmallButton onClick={() => act("social.review", "Sent for review")}>Send for review</SmallButton> : null}
        {post.status === "draft" && snapshot.space === "me" ? <Button type="button" style={{ height: 28, fontSize: 12 }} disabled={post.destinations.length === 0} onClick={() => void approve()}>Approve</Button> : null}
        {post.status === "review" && isUser && teamApproves ? <Button type="button" style={{ height: 28, fontSize: 12 }} onClick={() => void approve()}>{proposed ? "Approve & schedule" : "Approve"}</Button> : null}
        {post.status === "review" || post.status === "approved" ? <SmallButton onClick={() => act("social.back-to-draft", "Moved back to draft")}>Back to draft</SmallButton> : null}
        {post.status === "scheduled" ? <SmallButton onClick={() => act("social.unschedule", "Unscheduled")}>Unschedule</SmallButton> : null}
        {(post.status === "failed" || post.status === "partially_published") && failed ? (
          <Button type="button" style={{ height: 28, fontSize: 12 }} onClick={() => act("social.retry-post", "Retry queued; it runs within 5 minutes")}>Retry {failed} failed</Button>
        ) : null}
        {["draft", "review", "approved", "failed"].includes(post.status) ? (
          <SmallButton onClick={() => {
            if (window.confirm("Delete this post?")) run("social.delete-post", { postId: post.id }, "Post deleted").then(onClose).catch(ignore);
          }}>Delete</SmallButton>
        ) : null}
      </Row>

      {snapshot.space === "me" ? null : <AskForChanges post={post} snapshot={snapshot} run={run} />}

      {post.status === "approved" ? (
        <Card style={{ gap: 8 }}>
          <Muted>{post.scheduleIssueId ? "No publish time yet: the Social agent has a task to pick one. Or set it here." : "No publish time yet. Set it here."}</Muted>
          <Field label={`Publish at (your local time; calendar shows ${tz})`}>
            <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          </Field>
          <Row>
            <Button type="button" style={{ height: 30, fontSize: 12 }} disabled={Boolean(problems?.length)} onClick={() => act("social.schedule", "Scheduled", { scheduledAt: new Date(when).toISOString() })}>Schedule</Button>
            <SmallButton disabled={Boolean(problems?.length)} onClick={() => act("social.schedule", "Publishing within 5 minutes", { scheduledAt: new Date().toISOString() })}>Publish now</SmallButton>
          </Row>
        </Card>
      ) : null}
    </Sheet>
    {viewing !== null ? <MediaViewer items={post.media} start={viewing} onClose={() => setViewing(null)} /> : null}
    </>
  );
}

export function CalendarView({ posts, snapshot, onOpen }: { posts: Post[]; snapshot: Snapshot; onOpen: (post: Post) => void }) {
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
    const when = post.status === "published" || post.status === "partially_published" ? post.publishedAt ?? post.scheduledAt : post.scheduledAt;
    if (!when) continue;
    const key = dayKey(when);
    byDay.set(key, [...(byDay.get(key) ?? []), post]);
  }
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <Row style={{ justifyContent: "space-between" }}>
        <SmallButton onClick={() => setOffset((o) => o - 1)}>← Earlier</SmallButton>
        <Muted>{fmtDate(days[0]!.toISOString(), tz, false)} – {fmtDate(days[13]!.toISOString(), tz, false)} ({tz})</Muted>
        <SmallButton onClick={() => setOffset((o) => o + 1)}>Later →</SmallButton>
      </Row>
      <ChartLegend items={[{ label: "Scheduled", tone: "info" }, { label: "Published", tone: "ok" }, { label: "Failed", tone: "bad" }]} />
      <div style={{ display: "grid", gap: 8, gridTemplateColumns: fluidColumns(150, "auto-fill") }}>
        {days.map((day) => {
          const key = dayKey(day.toISOString());
          const list = (byDay.get(key) ?? []).sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)));
          return (
            <div key={key} style={{ display: "grid", gap: 6, alignContent: "start", minHeight: 90, padding: 8, borderRadius: 10, border: `1px solid ${key === todayKey ? tone("accent").border : tokens.border}`, background: key === todayKey ? `linear-gradient(180deg, ${tone("accent").soft}, transparent 60%), ${tokens.card}` : tokens.card, minWidth: 0 }}>
              <Row style={{ justifyContent: "space-between" }}>
                <Muted style={{ fontWeight: 600, color: key === todayKey ? tone("accent").fg : undefined }}>{day.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</Muted>
                {list.length ? <Pill size="sm" tone="accent">{list.length}</Pill> : null}
              </Row>
              {list.map((post) => (
                <button key={post.id} type="button" onClick={() => onOpen(post)} style={{ appearance: "none", textAlign: "left", fontSize: 11, lineHeight: 1.35, padding: "5px 7px", borderRadius: 8, border: "none", borderLeft: `3px solid ${tone(toneOf(POST_TONE, post.status)).solid}`, background: tone(toneOf(POST_TONE, post.status)).soft, color: tokens.fg, cursor: "pointer", fontFamily: "inherit", overflowWrap: "anywhere", minWidth: 0 }}>
                  <strong>{post.scheduledAt ? new Date(post.scheduledAt).toLocaleTimeString(undefined, { timeZone: tz, hour: "2-digit", minute: "2-digit" }) : ""}</strong>{" "}
                  {post.body.slice(0, 60)}
                  <div style={{ color: tokens.muted }}>{post.status.replace("_", " ")} · {post.destinations.map((d) => platformLabel(d.platform)).join(", ")}</div>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
