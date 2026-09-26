import { useEffect, useMemo, useState } from "react";
import { Button, EmptyState, Field, Input, Sheet, Toolbar, tokens } from "@partnersinbiz/pib-plugin-ui";
import { PLATFORM_LABELS, isSocialPlatform } from "../platforms.js";
import { Thumb } from "./composer.js";
import { Banner, Card, DestinationStatus, ExternalLink, fmtDate, ignore, Muted, platformLabel, PostStatus, Row, SmallButton } from "./parts.js";
import type { Post, RunAction, Snapshot } from "./types.js";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "draft", label: "Drafts" },
  { id: "review", label: "In review" },
  { id: "approved", label: "Approved" },
  { id: "scheduled", label: "Scheduled" },
  { id: "published", label: "Published" },
  { id: "problems", label: "Failed" },
];

function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function PostsTab({ posts, snapshot, onOpen, onNew }: { posts: Post[]; snapshot: Snapshot; onOpen: (post: Post) => void; onNew: () => void }) {
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();
  const rows = useMemo(() => posts.filter((post) => {
    if (filter === "problems" && post.status !== "failed" && post.status !== "partially_published") return false;
    if (filter === "published" && post.status !== "published") return false;
    if (!["all", "problems", "published"].includes(filter) && post.status !== filter) return false;
    return !q || post.body.toLowerCase().includes(q);
  }), [posts, filter, q]);
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search posts…">
        {FILTERS.map((f) => (
          <SmallButton key={f.id} onClick={() => setFilter(f.id)} style={filter === f.id ? { background: tokens.primary, color: tokens.primaryFg } : undefined}>{f.label}</SmallButton>
        ))}
        <Button type="button" onClick={onNew}>+ New post</Button>
      </Toolbar>
      {rows.length === 0 ? (
        <EmptyState title="No posts here" description="Write a post, pick destinations, and send it for review." action={<Button type="button" onClick={onNew}>+ New post</Button>} />
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {rows.map((post) => (
            <button
              key={post.id}
              type="button"
              onClick={() => onOpen(post)}
              style={{ appearance: "none", textAlign: "left", display: "grid", gap: 6, padding: 12, borderRadius: 12, border: `1px solid ${tokens.border}`, background: tokens.card, color: tokens.fg, cursor: "pointer", fontFamily: "inherit" }}
            >
              <Row style={{ justifyContent: "space-between" }}>
                <Row>
                  <PostStatus status={post.status} />
                  {post.source !== "manual" ? <Muted>{post.source.replace("_", " ")}</Muted> : null}
                </Row>
                <Muted>
                  {post.status === "published" || post.status === "partially_published"
                    ? `Published ${fmtDate(post.publishedAt, snapshot.config.timezone)}`
                    : post.scheduledAt ? `Scheduled ${fmtDate(post.scheduledAt, snapshot.config.timezone)}` : `Updated ${fmtDate(post.updatedAt, snapshot.config.timezone)}`}
                </Muted>
              </Row>
              <div style={{ fontSize: 13, lineHeight: 1.45, whiteSpace: "pre-wrap", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" }}>{post.body}</div>
              <Row>
                {post.destinations.map((d) => (
                  <span key={d.id} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, border: `1px solid ${tokens.border}`, color: d.status === "failed" ? "var(--destructive)" : tokens.muted }}>
                    {platformLabel(d.platform)} · {d.status}
                  </span>
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
  const tz = snapshot.config.timezone;
  const isUser = Boolean(snapshot.viewer.userId);

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

  const act = (key: string, success: string, extra: Record<string, unknown> = {}) => run(key, { postId: post.id, ...extra }, success).catch(ignore);
  const failed = post.destinations.filter((d) => d.status === "failed").length;

  return (
    <Sheet open title="Post" onClose={onClose}>
      <Row style={{ justifyContent: "space-between" }}>
        <PostStatus status={post.status} />
        <Muted>{post.clientName ?? "Own work"}</Muted>
      </Row>
      {post.error ? <Banner tone="error" title="Publishing problem">{post.error}{post.failureIssueId ? " An issue was opened for this post." : ""}</Banner> : null}
      <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{post.body}</div>
      {post.media.length ? (
        <Row>{post.media.map((m, i) => <Thumb key={`${m.url}-${i}`} asset={{ url: m.url, kind: m.kind }} />)}</Row>
      ) : null}
      {post.firstComment ? <Muted>First comment: {post.firstComment}</Muted> : null}
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
        <strong style={{ fontSize: 12 }}>Destinations</strong>
        {post.destinations.length === 0 ? <Muted>No destinations yet. Edit the post and pick accounts.</Muted> : null}
        {post.destinations.map((d) => (
          <div key={d.id} style={{ display: "grid", gap: 4, paddingTop: 6, borderTop: `1px solid ${tokens.border}` }}>
            <Row style={{ justifyContent: "space-between" }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>{platformLabel(d.platform)} · {d.accountName}</span>
              <DestinationStatus status={d.status} />
            </Row>
            <Muted>
              Attempts {d.attempts}
              {d.nextAttemptAt && d.status === "retrying" ? ` · next try ${fmtDate(d.nextAttemptAt, tz)}` : ""}
              {d.publishedAt ? ` · published ${fmtDate(d.publishedAt, tz)}` : ""}
            </Muted>
            {d.externalUrl ? <ExternalLink href={d.externalUrl}>View on {platformLabel(d.platform)}</ExternalLink> : null}
            {d.lastError ? <Muted style={{ color: "var(--destructive)" }}>{d.lastError}</Muted> : null}
          </div>
        ))}
      </Card>

      {problems && problems.length ? (
        <Banner tone="warn" title="Fix before scheduling">{problems.map((p) => <div key={p}>• {p}</div>)}</Banner>
      ) : null}

      <Row>
        {post.status === "draft" || post.status === "review" ? <SmallButton onClick={() => onEdit(post)}>Edit</SmallButton> : null}
        {post.status === "draft" ? <SmallButton onClick={() => act("social.review", "Sent for review")}>Send for review</SmallButton> : null}
        {post.status === "review" && isUser ? <Button type="button" style={{ height: 28, fontSize: 12 }} onClick={() => act("social.approve", "Approved")}>Approve</Button> : null}
        {post.status === "review" || post.status === "approved" ? <SmallButton onClick={() => act("social.back-to-draft", "Moved back to draft")}>Back to draft</SmallButton> : null}
        {post.status === "scheduled" ? <SmallButton onClick={() => act("social.unschedule", "Unscheduled")}>Unschedule</SmallButton> : null}
        {(post.status === "failed" || post.status === "partially_published") && failed ? (
          <Button type="button" style={{ height: 28, fontSize: 12 }} onClick={() => act("social.retry-post", "Retry queued; it runs within 5 minutes")}>Retry {failed} failed</Button>
        ) : null}
        {["draft", "review", "approved"].includes(post.status) ? (
          <SmallButton onClick={() => {
            if (window.confirm("Delete this post?")) run("social.delete-post", { postId: post.id }, "Post deleted").then(onClose).catch(ignore);
          }}>Delete</SmallButton>
        ) : null}
      </Row>

      {post.status === "approved" ? (
        <Card style={{ gap: 8 }}>
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
      <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
        {days.map((day) => {
          const key = dayKey(day.toISOString());
          const list = (byDay.get(key) ?? []).sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)));
          return (
            <div key={key} style={{ display: "grid", gap: 6, alignContent: "start", minHeight: 90, padding: 8, borderRadius: 10, border: `1px solid ${tokens.border}`, background: tokens.card }}>
              <Muted style={{ fontWeight: 600 }}>{day.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</Muted>
              {list.map((post) => (
                <button key={post.id} type="button" onClick={() => onOpen(post)} style={{ appearance: "none", textAlign: "left", fontSize: 11, lineHeight: 1.35, padding: "5px 7px", borderRadius: 8, border: "none", background: tokens.secondary, color: tokens.fg, cursor: "pointer", fontFamily: "inherit" }}>
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
