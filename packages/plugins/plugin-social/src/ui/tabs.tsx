import { useMemo, useRef, useState } from "react";
import {
  Activity,
  BarChart,
  Button,
  CalendarCheck,
  ChartColumn,
  ChartPie,
  CircleCheck,
  CircleX,
  Clock,
  EmptyState,
  Eye,
  Field,
  FileText,
  Input,
  KpiCard,
  MessageSquare,
  Modal,
  Package,
  Pill,
  Plug,
  Radio,
  SectionCard,
  Select,
  Send,
  StackedBar,
  StatusDot,
  TextArea,
  Timeline,
  Toolbar,
  TrendChart,
  TrendingUp,
  fluidColumns,
  relativeTime,
  seriesColor,
  tokens,
  tone,
  type LinkProps,
  type ToneInput,
} from "@partnersinbiz/pib-plugin-ui";
import { SOCIAL_MEDIA_MIME } from "../platforms.js";
import { AgentCard } from "./agent.js";
import { Thumb, uploadToR2 } from "./composer.js";
import { Banner, Card, chipStyle, ExternalLink, fmtDate, ignore, Muted, PlatformBadge, platformLabel, Row, scopeName, scopeParams, SmallButton } from "./parts.js";
import { ACCOUNT_TONE, countDelta, destinationSegments, liftTrend, platformIndex, postSegments, publishedSeries, recentActivity, toneOf, upcoming } from "./series.js";
import type { InboxItem, Post, RunAction, Snapshot } from "./types.js";

export type TabLink = (tab: string) => LinkProps;

/** Cards in a row share its height; keep their content at the top. */
const top = { alignContent: "start" } as const;

const grid = (min: number, gap = 16) => ({ display: "grid", gap, gridTemplateColumns: fluidColumns(min), minWidth: 0 }) as const;

export function OverviewTab({ snapshot, posts, run, onOpenPicker, onOpenPost, tabLink, now = new Date() }: {
  snapshot: Snapshot;
  posts: Post[];
  run: RunAction;
  onOpenPicker: (id: string) => void;
  onOpenPost?: (post: Post) => void;
  tabLink?: TabLink;
  now?: Date;
}) {
  const byStatus = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const post of posts) counts[post.status] = (counts[post.status] ?? 0) + 1;
    return counts;
  }, [posts]);
  const published = useMemo(() => publishedSeries(snapshot.stats, now, 14), [snapshot.stats, now.toDateString()]);
  const lift = useMemo(() => liftTrend(snapshot.stats), [snapshot.stats]);
  const activity = useMemo(() => recentActivity(posts, now), [posts]);
  const next = useMemo(() => upcoming(posts, now), [posts]);
  const needsAttention = snapshot.accounts.filter((a) => a.status === "needs_reconnect" || a.status === "expiring");
  const broken = snapshot.accounts.filter((a) => a.status === "needs_reconnect").length;
  const connected = snapshot.accounts.filter((a) => a.connected).length;
  const failed = (byStatus.failed ?? 0) + (byStatus.partially_published ?? 0);
  const review = byStatus.review ?? 0;
  const scheduled = byStatus.scheduled ?? 0;
  const lastLift = lift.values.length ? lift.values[lift.values.length - 1]! : null;
  const prevLift = lift.values.length > 1 ? lift.values[lift.values.length - 2]! : null;
  const liftDelta = lastLift !== null && prevLift !== null ? Math.round((lastLift - prevLift) * 10) / 10 : null;
  const link = (tab: string) => (tabLink ? tabLink(tab) : null);
  const postSegs = postSegments(posts);
  const destSegs = destinationSegments(snapshot.stats?.destinationStatus);
  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      {snapshot.pendingPickers.map((p) => (
        <Banner key={p.pickerId} tone="info" title={`Finish connecting ${platformLabel(p.platform)}`}>
          You signed in but have not chosen which accounts to add. <SmallButton onClick={() => onOpenPicker(p.pickerId)}>Choose accounts</SmallButton>
        </Banner>
      ))}
      {needsAttention.length ? (
        <Banner tone={broken ? "error" : "warn"} title={`${needsAttention.length} account${needsAttention.length === 1 ? " needs" : "s need"} attention`}>
          {needsAttention.map((a) => <div key={a.id}>• {platformLabel(a.platform)} · {a.displayName}: {a.lastError ?? a.status}</div>)}
        </Banner>
      ) : null}

      <div style={grid(150, 10)}>
        <KpiCard
          label="Published (14 days)"
          value={published.total}
          icon={Send}
          delta={countDelta(published.total, published.previous, "the 14 days before")}
          sparkline={published.totals}
          hint={published.total ? undefined : "Nothing published yet"}
          link={link("posts")}
        />
        <KpiCard label="Scheduled" value={scheduled} icon={CalendarCheck} hint={next[0]?.scheduledAt ? `Next ${relativeTime(next[0].scheduledAt, now)}` : "Nothing queued"} link={link("calendar")} />
        <KpiCard label="In review" value={review} icon={Eye} tone={review ? "warn" : undefined} hint={review ? "Waiting for approval" : "Nothing waiting"} link={link("posts")} />
        <KpiCard label="Failed" value={failed} icon={CircleX} tone={failed ? "bad" : undefined} hint={failed ? "Open the post to retry" : "No failures"} link={link("posts")} />
        <KpiCard
          label="Accounts"
          value={`${connected} / ${snapshot.accounts.length}`}
          icon={Plug}
          tone={broken ? "bad" : needsAttention.length ? "warn" : undefined}
          hint={broken ? `${broken} to reconnect` : needsAttention.length ? `${needsAttention.length} expiring` : snapshot.accounts.length ? "All connected" : "None yet"}
          link={link("accounts")}
        />
        <KpiCard
          label="Engagement lift"
          value={lastLift === null ? "—" : `${lastLift > 0 ? "+" : ""}${lastLift}%`}
          icon={TrendingUp}
          delta={liftDelta === null ? null : `${liftDelta >= 0 ? "+" : "−"}${Math.abs(liftDelta)} pts vs last week`}
          hint={lastLift === null ? "No scored posts yet" : "Median 7-day lift, this week"}
          sparkline={lift.values.length > 1 ? lift.values : undefined}
          link={link("growth")}
        />
      </div>

      <div style={grid(360)}>
        <SectionCard style={top} title="Published per day" subtitle="Posts that went out on each platform, last 14 days" icon={ChartColumn}>
          {published.total ? (
            <BarChart
              data={published.data}
              series={published.series.map((s) => ({ key: s.key, label: s.label, color: seriesColor(platformIndex(s.platform)) }))}
              unit="posts"
              title="Posts published per day"
              height={120}
            />
          ) : <EmptyState compact icon={Send} title="Nothing published in 14 days" description="Approve and schedule a post to see it here." />}
        </SectionCard>
        <SectionCard style={top} title="Engagement lift" subtitle={`Median 7-day lift vs each account's usual, per week${lift.posts ? ` · ${lift.posts} scored` : ""}`} icon={TrendingUp}>
          <TrendChart
            labels={lift.labels}
            series={[{ key: "lift", label: "Median lift", values: lift.values }]}
            formatValue={(v) => `${v > 0 ? "+" : ""}${Math.round(v * 10) / 10}%`}
            title="Weekly median engagement lift"
            height={120}
            emptyText="Lifts show once posts have 7 days of metrics."
          />
        </SectionCard>
      </div>

      <div style={grid(360)}>
        <SectionCard style={top} title="Where posts stand" subtitle="Posts by status, and destinations of posts from the last 30 days" icon={ChartPie}>
          {postSegs.length ? <StackedBar title="Posts by status" segments={postSegs} height={12} /> : <Muted>No posts yet.</Muted>}
          {destSegs.length ? (
            <div style={{ display: "grid", gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: tokens.muted }}>Destinations (30 days)</span>
              <StackedBar title="Destinations by status" segments={destSegs} height={8} />
            </div>
          ) : null}
        </SectionCard>
        <SectionCard
          style={top}
          title="Accounts"
          subtitle={snapshot.accounts.length ? `${connected} connected${broken ? ` · ${broken} to reconnect` : ""}` : "Connect a platform to start"}
          icon={Plug}
          tone={broken ? "bad" : undefined}
          strip={broken > 0}
          actions={tabLink ? <a {...tabLink("accounts")} style={{ fontSize: 13, fontWeight: 600, color: tokens.primary, textDecoration: "none" }}>Manage →</a> : undefined}
        >
          {snapshot.accounts.length ? <AccountGrid accounts={snapshot.accounts} /> : <EmptyState compact icon={Plug} title="No accounts yet" description="Connect Facebook, LinkedIn or another platform on the Accounts tab." />}
        </SectionCard>
      </div>

      <div style={grid(360)}>
        <SectionCard style={top} title="Recent activity" subtitle="What went out, and what failed" icon={Activity}>
          <Timeline
            empty="Nothing published yet."
            limit={6}
            now={now}
            items={activity.map((a) => ({
              id: a.id,
              at: a.at,
              tone: a.kind === "failed" ? "bad" : "ok",
              icon: a.kind === "failed" ? CircleX : CircleCheck,
              title: `${a.kind === "failed" ? "Failed on" : "Published to"} ${platformLabel(a.platform)} · ${a.accountName}`,
              detail: a.error ?? snippet(a.body),
            }))}
          />
        </SectionCard>
        <SectionCard style={top} title="Coming up" subtitle={scheduled ? `${scheduled} scheduled` : "Nothing scheduled"} icon={CalendarCheck}>
          {next.length ? (
            <div style={{ display: "grid", gap: 8 }}>
              {next.map((post) => (
                <button key={post.id} type="button" onClick={() => onOpenPost?.(post)} style={{ appearance: "none", textAlign: "left", display: "grid", gap: 4, padding: "8px 10px", borderRadius: 10, border: `1px solid ${tokens.border}`, background: "transparent", color: tokens.fg, cursor: onOpenPost ? "pointer" : "default", fontFamily: "inherit", minWidth: 0 }}>
                  <Row style={{ justifyContent: "space-between" }}>
                    <Row style={{ gap: 4 }}>{post.destinations.map((d) => <PlatformBadge key={d.id} platform={d.platform} size={20} />)}</Row>
                    <Pill tone="info" size="sm" icon={Clock}>{fmtDate(post.scheduledAt, snapshot.config.timezone)}</Pill>
                  </Row>
                  <span style={{ fontSize: 12.5, lineHeight: 1.45, overflowWrap: "anywhere" }}>{snippet(post.body)}</span>
                </button>
              ))}
            </div>
          ) : <EmptyState compact icon={CalendarCheck} title="Nothing scheduled" description="Approved posts get a time slot from the post sheet." />}
        </SectionCard>
      </div>

      <AgentCard agent={snapshot.agent} run={run} ownPage={!snapshot.scope} />
    </div>
  );
}

function snippet(text: string, max = 110): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Accounts as small cards: platform badge, name, status dot. */
export function AccountGrid({ accounts }: { accounts: Snapshot["accounts"] }) {
  return (
    <div style={{ display: "grid", gap: 8, gridTemplateColumns: fluidColumns(200, "auto-fill"), minWidth: 0 }}>
      {accounts.map((a) => {
        const t = toneOf(ACCOUNT_TONE, a.status);
        return (
          <div key={a.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 10px", borderRadius: 10, border: `1px solid ${t === "bad" ? tone("bad").border : tokens.border}`, background: t === "bad" ? tone("bad").soft : "transparent", minWidth: 0 }}>
            <PlatformBadge platform={a.platform} />
            <div style={{ display: "grid", gap: 1, minWidth: 0, flex: 1 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.displayName}</span>
              <span style={{ fontSize: 11.5, color: t === "bad" ? tone("bad").fg : tokens.muted }}>{platformLabel(a.platform)} · {a.status === "needs_reconnect" ? "needs reconnect" : a.status}</span>
            </div>
            <StatusDot tone={t} halo label={`${a.displayName}: ${a.status.replace(/_/g, " ")}`} />
          </div>
        );
      })}
    </div>
  );
}

const INTENTS = ["question", "complaint", "praise", "lead", "spam", "other"];
const SENTIMENTS = ["negative", "neutral", "positive"];

const INTENT_TONE: Record<string, ToneInput> = { question: "info", complaint: "warn", praise: "ok", lead: "ok", spam: "neutral", other: "neutral" };

function TriageChip({ label, tone: t, title }: { label: string; tone?: ToneInput; title?: string }) {
  return <Pill tone={t ?? "neutral"} size="sm" title={title}>{label}</Pill>;
}

/** Jev's answers on an inbox item, with a way to correct them (logged as labelled data). */
function TriageRow({ item, run }: { item: InboxItem; run: RunAction }) {
  const [fixing, setFixing] = useState(false);
  const t = item.triage;
  if (!t) return null;
  const correct = (key: string, value: string) => run("social.correct-triage", { itemId: item.id, key, value }, "Correction saved").catch(ignore);
  const mark = (key: string) => (t.corrected.includes(key) ? " (corrected)" : "");
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <Row>
        {t.escalate ? <TriageChip label={`Needs a person${mark("escalate")}`} tone="bad" title="Legal, safety or PR risk" /> : null}
        {t.action === "spam_read" && !t.corrected.includes("intent") ? <TriageChip label="Marked spam" tone="warn" /> : null}
        <TriageChip label={`${t.intent}${mark("intent")}`} tone={INTENT_TONE[t.intent]} title={`Jev ${Math.round(t.intentConfidence * 100)}% sure`} />
        <TriageChip label={`${t.sentiment}${mark("sentiment")}`} tone={t.sentiment === "negative" ? "bad" : t.sentiment === "positive" ? "ok" : undefined} />
        <TriageChip label={`${t.needsReply ? "needs reply" : "no reply needed"}${mark("needs_reply")}`} tone={t.needsReply ? "warn" : undefined} />
        {t.action === "queued" ? <TriageChip label="Queued for the agent" tone="info" /> : null}
        <SmallButton onClick={() => setFixing((f) => !f)} style={{ height: 22, fontSize: 11 }}>{fixing ? "Done" : "Fix"}</SmallButton>
      </Row>
      {fixing ? (
        <Row>
          <Select value={t.intent} onChange={(e) => void correct("intent", e.target.value)} aria-label="Intent" style={{ height: 28, fontSize: 12 }}>
            {INTENTS.map((v) => <option key={v} value={v}>{v}</option>)}
          </Select>
          <Select value={t.sentiment} onChange={(e) => void correct("sentiment", e.target.value)} aria-label="Sentiment" style={{ height: 28, fontSize: 12 }}>
            {SENTIMENTS.map((v) => <option key={v} value={v}>{v}</option>)}
          </Select>
          <Select value={t.needsReply ? "yes" : "no"} onChange={(e) => void correct("needs_reply", e.target.value)} aria-label="Needs reply" style={{ height: 28, fontSize: 12 }}>
            <option value="yes">needs reply</option>
            <option value="no">no reply needed</option>
          </Select>
          <Select value={t.escalate ? "yes" : "no"} onChange={(e) => void correct("escalate", e.target.value)} aria-label="Needs a person" style={{ height: 28, fontSize: 12 }}>
            <option value="no">ordinary</option>
            <option value="yes">needs a person</option>
          </Select>
        </Row>
      ) : null}
    </div>
  );
}

export function InboxTab({ snapshot, run }: { snapshot: Snapshot; run: RunAction }) {
  const [status, setStatus] = useState("new");
  const [replies, setReplies] = useState<Record<string, string>>({});
  const items = snapshot.inbox.filter((i) => !status || i.status === status);
  const counts: Record<string, number> = { "": snapshot.inbox.length };
  for (const i of snapshot.inbox) counts[i.status] = (counts[i.status] ?? 0) + 1;
  const accounts = new Map(snapshot.accounts.map((a) => [a.id, a]));
  const reply = (item: InboxItem) => {
    const body = (replies[item.id] ?? item.replyDraft ?? "").trim();
    if (!body) return;
    run("social.reply-inbox", { itemId: item.id, body }, item.canReply ? "Reply sent" : "Draft post created").then(() => setReplies((r) => ({ ...r, [item.id]: "" }))).catch(ignore);
  };
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Toolbar>
        {[["new", "New"], ["read", "Read"], ["replied", "Replied"], ["", "All"]].map(([id, label]) => (
          <SmallButton key={id} aria-pressed={status === id} onClick={() => setStatus(id!)} style={chipStyle(status === id)}>{label}{counts[id!] ? ` (${counts[id!]})` : ""}</SmallButton>
        ))}
      </Toolbar>
      <Muted>
        Comments on recent posts (Facebook, Instagram, Threads, YouTube) and mentions (X, Bluesky, Mastodon) are pulled every 15 minutes.
        {snapshot.config.jev ? " Jev sorts new items: spam is marked read, replies go to the agent in one issue per account per day, and risky items go to a person." : ""}
      </Muted>
      {items.length === 0 ? <EmptyState icon={MessageSquare} title="Nothing here" description="New comments and mentions show up here every 15 minutes." /> : null}
      {items.map((item) => {
        const account = item.accountId ? accounts.get(item.accountId) : undefined;
        return (
          <Card key={item.id} style={{ gap: 8, ...(item.triage?.escalate ? { borderLeft: `3px solid ${tone("bad").solid}` } : {}) }}>
            <Row style={{ justifyContent: "space-between" }}>
              <Row style={{ flexWrap: "nowrap", minWidth: 0 }}>
                <PlatformBadge platform={item.platform} size={24} />
                <strong style={{ fontSize: 13, overflowWrap: "anywhere" }}>{item.author || "Someone"}</strong>
                {item.status === "new" ? <Pill tone="warn" size="sm" dot>new</Pill> : item.status === "replied" ? <Pill tone="ok" size="sm" dot>replied</Pill> : null}
              </Row>
              <Muted>{platformLabel(item.platform)}{account ? ` · ${account.displayName}` : ""} · {item.kind} · {fmtDate(item.receivedAt, snapshot.config.timezone)}</Muted>
            </Row>
            <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{item.body}</div>
            <TriageRow item={item} run={run} />
            {item.permalink ? <ExternalLink href={item.permalink}>Open on {platformLabel(item.platform)}</ExternalLink> : null}
            {item.replyBody ? <Muted>Replied: {item.replyBody}</Muted> : null}
            {item.status !== "replied" ? (
              <>
                {item.replyDraft ? <Muted>Suggested reply from the agent is prefilled below.</Muted> : null}
                <TextArea rows={2} value={replies[item.id] ?? item.replyDraft ?? ""} onChange={(e) => setReplies((r) => ({ ...r, [item.id]: e.target.value }))} placeholder={item.canReply ? "Write a reply…" : "This platform has no reply API here; a draft post will be created"} />
                <Row>
                  <Button type="button" style={{ height: 28, fontSize: 12 }} onClick={() => reply(item)}>{item.canReply ? "Send reply" : "Create draft post"}</Button>
                  {item.status === "new" ? <SmallButton onClick={() => run("social.mark-inbox-read", { itemId: item.id }).catch(ignore)}>Mark read</SmallButton> : null}
                </Row>
              </>
            ) : null}
          </Card>
        );
      })}
    </div>
  );
}

export function MediaTab({ snapshot, run }: { snapshot: Snapshot; run: RunAction }) {
  const [uploading, setUploading] = useState("");
  const [error, setError] = useState("");
  const [importUrl, setImportUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // This scope's media only; uploads and imports belong to it.
  const assets = snapshot.media;
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {!snapshot.config.r2 ? <Banner tone="warn" title="Cloudflare R2 is not configured">Fill in the R2 section of the Social settings to upload media. Instagram, Threads, TikTok and Pinterest fetch media from its public domain.</Banner> : null}
      {error ? <Banner tone="error" title="Upload failed">{error}</Banner> : null}
      <Card>
        <Row>
          <input ref={input} type="file" multiple accept={SOCIAL_MEDIA_MIME.join(",")} style={{ display: "none" }} onChange={async (e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            setError("");
            for (const file of files) {
              setUploading(file.name);
              try {
                await uploadToR2(run, file, snapshot.scope);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }
            setUploading("");
          }} />
          <Button type="button" disabled={!snapshot.config.r2 || uploading !== ""} onClick={() => input.current?.click()}>{uploading ? `Uploading ${uploading}…` : "Upload files"}</Button>
          <Input value={importUrl} onChange={(e) => setImportUrl(e.target.value)} placeholder="…or import from a public https URL" style={{ flex: "1 1 260px" }} />
          <SmallButton disabled={!snapshot.config.r2 || !importUrl || importing} onClick={() => {
            setImporting(true);
            run("social.import-media", { url: importUrl, ...scopeParams(snapshot) }, "Imported").then(() => setImportUrl("")).catch(ignore).finally(() => setImporting(false));
          }}>{importing ? "Importing…" : "Import"}</SmallButton>
        </Row>
        <Muted>JPEG, PNG, GIF, WebP, MP4 or MOV, up to 512 MB. Uploads go straight to R2 from your browser and belong to {scopeName(snapshot)}.</Muted>
      </Card>
      {assets.length === 0 ? <EmptyState icon={Package} title="No media yet" description="Upload images and videos to reuse them in posts." /> : (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {assets.map((asset) => (
            <div key={asset.id} style={{ display: "grid", gap: 4, width: 84 }}>
              <Thumb asset={asset} />
              <Muted style={{ fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{asset.name}</Muted>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function FeedsTab({ snapshot, run }: { snapshot: Snapshot; run: RunAction }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [accountIds, setAccountIds] = useState<Set<string>>(new Set());
  const accounts = new Map(snapshot.accounts.map((a) => [a.id, a]));
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Toolbar><Button type="button" onClick={() => setOpen(true)}>+ Add feed</Button></Toolbar>
      <Muted>Feeds are checked every 15 minutes. New items become draft posts for review; nothing publishes without approval.</Muted>
      {snapshot.feeds.length === 0 ? <EmptyState icon={Radio} title="No feeds" description="Add a blog or news RSS feed to turn new items into draft posts." action={<Button type="button" onClick={() => setOpen(true)}>+ Add feed</Button>} /> : null}
      {snapshot.feeds.map((feed) => (
        <Card key={feed.id} style={{ gap: 6 }}>
          <Row style={{ justifyContent: "space-between" }}>
            <Row style={{ flexWrap: "nowrap", minWidth: 0, flex: "1 1 200px" }}>
              <StatusDot tone={feed.lastError ? "bad" : feed.isActive ? "ok" : "neutral"} halo label={feed.lastError ? "Error" : feed.isActive ? "Active" : "Paused"} />
              <strong style={{ fontSize: 13, overflowWrap: "anywhere", minWidth: 0 }}>{feed.title ?? feed.url}</strong>
              <Pill tone={feed.isActive ? "ok" : "neutral"} size="sm">{feed.isActive ? "active" : "paused"}</Pill>
            </Row>
            <SmallButton onClick={() => run("social.set-rss-active", { feedId: feed.id, active: !feed.isActive }, feed.isActive ? "Feed paused" : "Feed resumed").catch(ignore)}>{feed.isActive ? "Pause" : "Resume"}</SmallButton>
          </Row>
          <Muted>{feed.url}</Muted>
          <Muted>
            {feed.accountIds.map((id) => accounts.get(id)?.displayName ?? "removed").join(", ") || "no destinations"} · checked {fmtDate(feed.lastCheckedAt, snapshot.config.timezone)}
          </Muted>
          {feed.lastError ? <Muted style={{ color: tone("bad").fg }}>{feed.lastError}</Muted> : null}
        </Card>
      ))}
      <Modal open={open} title="Add RSS feed" onClose={() => setOpen(false)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button type="button" disabled={!url} onClick={() => run("social.create-rss-feed", { url, ...scopeParams(snapshot), accountIds: [...accountIds] }, "Feed added").then(() => {
            setOpen(false);
            setUrl("");
            setAccountIds(new Set());
          }).catch(ignore)}>Add</Button>
        </>
      )}>
        <Field label="Feed URL"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/feed.xml" /></Field>
        <Muted>Drafts from this feed belong to {scopeName(snapshot)}.</Muted>
        <div style={{ display: "grid", gap: 4 }}>
          <Muted>Destinations for the drafts</Muted>
          {snapshot.accounts.filter((a) => a.connected && a.scope === "org").map((a) => (
            <label key={a.id} style={{ display: "flex", gap: 8, fontSize: 12, alignItems: "center" }}>
              <input type="checkbox" checked={accountIds.has(a.id)} onChange={() => setAccountIds((prev) => {
                const next = new Set(prev);
                if (next.has(a.id)) next.delete(a.id);
                else next.add(a.id);
                return next;
              })} />
              {platformLabel(a.platform)} · {a.displayName}
            </label>
          ))}
        </div>
      </Modal>
    </div>
  );
}

export function TemplatesTab({ snapshot, run }: { snapshot: Snapshot; run: RunAction }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [platform, setPlatform] = useState("");
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Toolbar><Button type="button" onClick={() => setOpen(true)}>+ New template</Button></Toolbar>
      {snapshot.templates.length === 0 ? <EmptyState icon={FileText} title="No templates yet" description="Save reusable post copy so drafts stay on-brand." action={<Button type="button" onClick={() => setOpen(true)}>+ New template</Button>} /> : null}
      {snapshot.templates.map((t) => (
        <Card key={t.id} style={{ gap: 4 }}>
          <Row style={{ justifyContent: "space-between" }}>
            <strong style={{ fontSize: 13 }}>{t.name}</strong>
            {t.platform ? <Row style={{ gap: 6 }}><PlatformBadge platform={t.platform} size={20} /><Muted>{platformLabel(t.platform)}</Muted></Row> : <Muted>Any platform</Muted>}
          </Row>
          <div style={{ fontSize: 12, whiteSpace: "pre-wrap", color: tokens.muted }}>{t.body}</div>
        </Card>
      ))}
      <Modal open={open} title="New template" onClose={() => setOpen(false)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button type="button" disabled={!name || !body} onClick={() => run("social.create-template", { name, body, platform: platform || undefined }, "Template saved").then(() => {
            setOpen(false);
            setName("");
            setBody("");
          }).catch(ignore)}>Save</Button>
        </>
      )}>
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Platform (optional)"><Input value={platform} onChange={(e) => setPlatform(e.target.value)} placeholder="linkedin" /></Field>
        <Field label="Body"><TextArea value={body} onChange={(e) => setBody(e.target.value)} rows={5} /></Field>
      </Modal>
    </div>
  );
}
