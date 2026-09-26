import { useMemo, useRef, useState } from "react";
import { MetricCard } from "@paperclipai/plugin-sdk/ui";
import { BarChart, Button, EmptyState, Field, Input, Modal, Select, StatRow, TextArea, Toolbar, tokens } from "@partnersinbiz/pib-plugin-ui";
import { SOCIAL_MEDIA_MIME } from "../platforms.js";
import { AgentCard } from "./agent.js";
import { Thumb, uploadToR2 } from "./composer.js";
import { Banner, Card, ExternalLink, fmtDate, ignore, Muted, platformLabel, Row, scopeName, scopeParams, SmallButton } from "./parts.js";
import type { InboxItem, Post, RunAction, Snapshot } from "./types.js";

export function OverviewTab({ snapshot, posts, run, onOpenPicker }: { snapshot: Snapshot; posts: Post[]; run: RunAction; onOpenPicker: (id: string) => void }) {
  const byStatus = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const post of posts) counts[post.status] = (counts[post.status] ?? 0) + 1;
    return counts;
  }, [posts]);
  const needsAttention = snapshot.accounts.filter((a) => a.status === "needs_reconnect" || a.status === "expiring");
  return (
    <div style={{ display: "grid", gap: 16 }}>
      {snapshot.pendingPickers.map((p) => (
        <Banner key={p.pickerId} tone="info" title={`Finish connecting ${platformLabel(p.platform)}`}>
          You signed in but have not chosen which accounts to add. <SmallButton onClick={() => onOpenPicker(p.pickerId)}>Choose accounts</SmallButton>
        </Banner>
      ))}
      {needsAttention.length ? (
        <Banner tone="warn" title={`${needsAttention.length} account${needsAttention.length === 1 ? "" : "s"} need attention`}>
          {needsAttention.map((a) => <div key={a.id}>• {platformLabel(a.platform)} · {a.displayName}: {a.lastError ?? a.status}</div>)}
        </Banner>
      ) : null}
      <StatRow>
        <MetricCard label="Connected accounts" value={snapshot.accounts.filter((a) => a.connected).length} />
        <MetricCard label="In review" value={byStatus.review ?? 0} />
        <MetricCard label="Scheduled" value={byStatus.scheduled ?? 0} />
        <MetricCard label="Failed" value={(byStatus.failed ?? 0) + (byStatus.partially_published ?? 0)} />
      </StatRow>
      <AgentCard agent={snapshot.agent} run={run} ownPage={!snapshot.scope} />
      <BarChart title="Posts by status" items={Object.entries(byStatus).map(([label, value]) => ({ label: label.replace("_", " "), value }))} />
    </div>
  );
}

const INTENTS = ["question", "complaint", "praise", "lead", "spam", "other"];
const SENTIMENTS = ["negative", "neutral", "positive"];

function TriageChip({ label, tone, title }: { label: string; tone?: "warn" | "bad" | "good"; title?: string }) {
  const color = tone === "bad" ? "var(--destructive)" : tone === "warn" ? "#b45309" : tone === "good" ? "#15803d" : tokens.muted;
  return <span title={title} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, border: `1px solid ${tokens.border}`, color }}>{label}</span>;
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
        <TriageChip label={`${t.intent}${mark("intent")}`} title={`Jev ${Math.round(t.intentConfidence * 100)}% sure`} />
        <TriageChip label={`${t.sentiment}${mark("sentiment")}`} tone={t.sentiment === "negative" ? "warn" : t.sentiment === "positive" ? "good" : undefined} />
        <TriageChip label={`${t.needsReply ? "needs reply" : "no reply needed"}${mark("needs_reply")}`} />
        {t.action === "queued" ? <TriageChip label="Queued for the agent" /> : null}
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
          <SmallButton key={id} onClick={() => setStatus(id!)} style={status === id ? { background: tokens.primary, color: tokens.primaryFg } : undefined}>{label}</SmallButton>
        ))}
      </Toolbar>
      <Muted>
        Comments on recent posts (Facebook, Instagram, Threads, YouTube) and mentions (X, Bluesky, Mastodon) are pulled every 15 minutes.
        {snapshot.config.jev ? " Jev sorts new items: spam is marked read, replies go to the agent in one issue per account per day, and risky items go to a person." : ""}
      </Muted>
      {items.length === 0 ? <EmptyState title="Nothing here" description="New comments and mentions show up here." /> : null}
      {items.map((item) => {
        const account = item.accountId ? accounts.get(item.accountId) : undefined;
        return (
          <Card key={item.id} style={{ gap: 8 }}>
            <Row style={{ justifyContent: "space-between" }}>
              <strong style={{ fontSize: 13 }}>{item.author || "Someone"}</strong>
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
      {assets.length === 0 ? <EmptyState title="No media yet" description="Upload images and videos to reuse them in posts." /> : (
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
      {snapshot.feeds.length === 0 ? <EmptyState title="No feeds" description="Add a blog or news RSS feed to turn new items into draft posts." /> : null}
      {snapshot.feeds.map((feed) => (
        <Card key={feed.id} style={{ gap: 6 }}>
          <Row style={{ justifyContent: "space-between" }}>
            <strong style={{ fontSize: 13 }}>{feed.title ?? feed.url}</strong>
            <SmallButton onClick={() => run("social.set-rss-active", { feedId: feed.id, active: !feed.isActive }, feed.isActive ? "Feed paused" : "Feed resumed").catch(ignore)}>{feed.isActive ? "Pause" : "Resume"}</SmallButton>
          </Row>
          <Muted>{feed.url}</Muted>
          <Muted>
            {feed.accountIds.map((id) => accounts.get(id)?.displayName ?? "removed").join(", ") || "no destinations"} · checked {fmtDate(feed.lastCheckedAt, snapshot.config.timezone)}
          </Muted>
          {feed.lastError ? <Muted style={{ color: "var(--destructive)" }}>{feed.lastError}</Muted> : null}
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
      {snapshot.templates.length === 0 ? <EmptyState title="No templates yet" description="Save reusable post copy so drafts stay on-brand." /> : null}
      {snapshot.templates.map((t) => (
        <Card key={t.id} style={{ gap: 4 }}>
          <Row style={{ justifyContent: "space-between" }}>
            <strong style={{ fontSize: 13 }}>{t.name}</strong>
            <Muted>{t.platform ? platformLabel(t.platform) : "Any platform"}</Muted>
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
