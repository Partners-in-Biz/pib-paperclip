/**
 * Mock-ups of a post as each platform shows it in its feed: the account's name and picture, the text that platform
 * gets, where the feed cuts it, and the media. They use each platform's own light look on purpose (a post looks the
 * same there whatever theme this page has), so the colours here are fixed and not the page's tokens.
 */
import { useState, type CSSProperties, type ReactNode } from "react";
import { tokens, tone } from "@partnersinbiz/pib-plugin-ui";
import type { SocialPlatform } from "../platforms.js";
import { chipStyle, Muted, PlatformBadge, platformLabel, Row, SmallButton } from "./parts.js";
import { atHandle, foldText, previewModel, textParts, type PreviewModel, type PreviewSource } from "./preview-model.js";
import type { Account } from "./types.js";

export interface PreviewAccount {
  id: string;
  platform: string | null;
  name: string;
  handle?: string | null;
  avatarUrl?: string | null;
}

const INK = "#0f1419";
const SOFT = "#65676b";
const LINE = "#e4e6eb";
const LINK: Partial<Record<SocialPlatform, string>> = { linkedin: "#0a66c2", facebook: "#0866ff", x: "#1d9bf0", bluesky: "#1083fe", threads: "#0095f6", mastodon: "#6364ff", instagram: "#00376b", reddit: "#0079d3" };
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const frame: CSSProperties = { background: "#fff", color: INK, borderRadius: 12, border: `1px solid ${LINE}`, fontFamily: FONT, fontSize: 14, lineHeight: 1.4, overflow: "hidden", width: "100%", maxWidth: 420, textAlign: "left", minWidth: 0 };

function Face({ account, size = 40, square = false }: { account: PreviewAccount; size?: number; square?: boolean }) {
  const radius = square ? 6 : 999;
  if (account.avatarUrl) return <img src={account.avatarUrl} alt="" width={size} height={size} referrerPolicy="origin" style={{ borderRadius: radius, objectFit: "cover", flexShrink: 0 }} />;
  return (
    <span aria-hidden="true" style={{ width: size, height: size, borderRadius: radius, display: "grid", placeItems: "center", background: "#dfe3e8", color: "#4b5563", fontWeight: 700, fontSize: Math.round(size * 0.42), flexShrink: 0 }}>
      {account.name.replace(/^@/, "").slice(0, 1).toUpperCase() || "?"}
    </span>
  );
}

/** Post text coloured as the platform colours it, cut where the feed cuts it; "more" shows the rest. */
function Text({ model, style, prefix }: { model: PreviewModel; style?: CSSProperties; prefix?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const fold = foldText(model.text, model.platform);
  const color = (model.platform && LINK[model.platform]) || "#1d4ed8";
  const shown = open ? model.text : fold.shown;
  return (
    <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", ...style }}>
      {prefix}
      {textParts(shown).map((part, i) => (part.kind === "text" ? <span key={i}>{part.value}</span> : <span key={i} style={{ color }}>{part.value}</span>))}
      {fold.cut ? (
        <button type="button" onClick={(event) => { event.stopPropagation(); setOpen((v) => !v); }} style={{ appearance: "none", border: "none", background: "none", padding: 0, marginLeft: 4, color: SOFT, font: "inherit", cursor: "pointer" }}>
          {open ? "less" : "…more"}
        </button>
      ) : null}
    </div>
  );
}

function Tile({ item, style }: { item: PreviewSource["media"][number]; style?: CSSProperties }) {
  const fill: CSSProperties = { width: "100%", height: "100%", objectFit: "cover", display: "block" };
  return (
    <div style={{ position: "relative", background: "#0b0b0c", minHeight: 0, overflow: "hidden", ...style }}>
      {item.kind === "video" ? <video src={item.url} muted playsInline preload="metadata" style={fill} /> : <img src={item.url} alt={item.altText ?? ""} style={fill} />}
      {item.kind === "video" ? <span aria-hidden="true" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#fff", fontSize: 34, textShadow: "0 1px 8px rgba(0,0,0,.6)" }}>▶</span> : null}
    </div>
  );
}

/** One item fills the width; two to four make a grid; more show "+N" on the fourth. */
function MediaGrid({ media, ratio = "16 / 10", radius = 0 }: { media: PreviewSource["media"]; ratio?: string; radius?: number }) {
  if (media.length === 0) return null;
  const shown = media.slice(0, 4);
  const more = media.length - shown.length;
  const columns = shown.length === 1 ? "1fr" : "1fr 1fr";
  return (
    <div style={{ display: "grid", gridTemplateColumns: columns, gap: 2, aspectRatio: ratio, borderRadius: radius, overflow: "hidden" }}>
      {shown.map((item, i) => (
        <div key={`${item.url}-${i}`} style={{ position: "relative", minHeight: 0, gridColumn: shown.length === 3 && i === 0 ? "1 / -1" : undefined }}>
          <Tile item={item} style={{ position: "absolute", inset: 0 }} />
          {more > 0 && i === shown.length - 1 ? <span style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: "rgba(0,0,0,.5)", color: "#fff", fontSize: 22, fontWeight: 600 }}>+{more}</span> : null}
        </div>
      ))}
    </div>
  );
}

function Actions({ items, style }: { items: string[]; style?: CSSProperties }) {
  return (
    <div aria-hidden="true" style={{ display: "flex", justifyContent: "space-around", padding: "8px 12px", borderTop: `1px solid ${LINE}`, color: SOFT, fontSize: 13, fontWeight: 600, ...style }}>
      {items.map((item) => <span key={item}>{item}</span>)}
    </div>
  );
}

function LinkCard({ link }: { link: string }) {
  let host = link;
  try {
    host = new URL(link).hostname.replace(/^www\./, "");
  } catch {
    // keep the raw text
  }
  return <div style={{ margin: "0 12px 10px", padding: "8px 10px", borderRadius: 8, border: `1px solid ${LINE}`, background: "#f7f8fa", color: SOFT, fontSize: 12, overflowWrap: "anywhere" }}>🔗 {host}</div>;
}

function FirstComment({ model, account }: { model: PreviewModel; account: PreviewAccount }) {
  if (!model.firstComment) return null;
  return (
    <div style={{ display: "flex", gap: 8, padding: "8px 12px 12px", borderTop: `1px solid ${LINE}` }}>
      <Face account={account} size={26} />
      <div style={{ background: "#f0f2f5", borderRadius: 12, padding: "6px 10px", fontSize: 13, minWidth: 0, overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>
        <strong style={{ display: "block", fontSize: 12 }}>{account.name}</strong>
        {model.firstComment}
      </div>
    </div>
  );
}

function Feed({ model, account }: { model: PreviewModel; account: PreviewAccount }) {
  const linkedin = model.platform === "linkedin";
  const reddit = model.platform === "reddit";
  const sub = reddit ? `r/${model.subreddit ?? "subreddit"} · now` : linkedin ? "Now · 🌐" : model.platform === "facebook" ? "Just now · 🌐" : "Now";
  return (
    <div style={frame}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "12px 12px 8px" }}>
        <Face account={account} size={linkedin ? 44 : 40} square={linkedin} />
        <div style={{ display: "grid", minWidth: 0 }}>
          <strong style={{ fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account.name}</strong>
          <span style={{ fontSize: 12, color: SOFT }}>{sub}</span>
        </div>
      </div>
      {model.title ? <strong style={{ display: "block", padding: "0 12px 6px", fontSize: 16 }}>{model.title}</strong> : null}
      <Text model={model} style={{ padding: "0 12px 10px" }} />
      {model.link && model.media.length === 0 ? <LinkCard link={model.link} /> : null}
      <MediaGrid media={model.media} ratio={model.media.length === 1 ? "4 / 3" : "16 / 10"} />
      <Actions items={reddit ? ["▲ Vote", "Comment", "Share"] : linkedin ? ["Like", "Comment", "Repost", "Send"] : ["Like", "Comment", "Share"]} style={model.media.length ? { borderTop: "none" } : undefined} />
      <FirstComment model={model} account={account} />
    </div>
  );
}

function Micro({ model, account }: { model: PreviewModel; account: PreviewAccount }) {
  const handle = atHandle(account.handle);
  return (
    <div style={frame}>
      <div style={{ display: "flex", gap: 10, padding: 12 }}>
        <Face account={account} size={40} />
        <div style={{ display: "grid", gap: 6, minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", gap: 4, minWidth: 0, fontSize: 14 }}>
            <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account.name}</strong>
            <span style={{ color: SOFT, whiteSpace: "nowrap" }}>{handle ? `${handle} · ` : ""}now</span>
          </div>
          <Text model={model} />
          {model.link && model.media.length === 0 ? <div style={{ margin: "0 -12px" }}><LinkCard link={model.link} /></div> : null}
          <MediaGrid media={model.media} radius={14} />
          <div aria-hidden="true" style={{ display: "flex", justifyContent: "space-between", color: SOFT, fontSize: 13, paddingTop: 2, maxWidth: 300 }}>
            <span>💬</span><span>🔁</span><span>♡</span><span>↗</span>
          </div>
          {model.firstComment ? <div style={{ borderTop: `1px solid ${LINE}`, paddingTop: 8, fontSize: 13, color: INK, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}><span style={{ color: SOFT }}>Reply · </span>{model.firstComment}</div> : null}
        </div>
      </div>
    </div>
  );
}

function Instagram({ model, account }: { model: PreviewModel; account: PreviewAccount }) {
  const [index, setIndex] = useState(0);
  const name = atHandle(account.handle)?.slice(1) ?? account.name;
  const item = model.media[Math.min(index, model.media.length - 1)];
  return (
    <div style={frame}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "10px 12px" }}>
        <Face account={account} size={32} />
        <strong style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</strong>
      </div>
      {item ? (
        <div style={{ position: "relative" }}>
          <Tile item={item} style={{ aspectRatio: "4 / 5" }} />
          {model.media.length > 1 ? (
            <>
              <span style={{ position: "absolute", top: 10, right: 10, padding: "2px 8px", borderRadius: 999, background: "rgba(0,0,0,.6)", color: "#fff", fontSize: 12 }}>{Math.min(index, model.media.length - 1) + 1}/{model.media.length}</span>
              <button type="button" aria-label="Next image" onClick={(event) => { event.stopPropagation(); setIndex((i) => (i + 1) % model.media.length); }} style={{ position: "absolute", right: 8, top: "50%", width: 28, height: 28, marginTop: -14, borderRadius: 999, border: "none", background: "rgba(255,255,255,.85)", color: INK, cursor: "pointer", fontSize: 14 }}>›</button>
            </>
          ) : null}
        </div>
      ) : (
        <div style={{ aspectRatio: "4 / 5", display: "grid", placeItems: "center", background: "#f0f2f5", color: SOFT, fontSize: 13, padding: 16, textAlign: "center" }}>Instagram needs an image or video</div>
      )}
      <div aria-hidden="true" style={{ display: "flex", gap: 14, padding: "10px 12px 4px", fontSize: 18 }}><span>♡</span><span>💬</span><span>↗</span></div>
      <Text model={model} style={{ padding: "2px 12px 12px", fontSize: 13 }} prefix={<strong style={{ marginRight: 6 }}>{name}</strong>} />
      {model.firstComment ? <div style={{ padding: "0 12px 12px", fontSize: 13, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}><strong style={{ marginRight: 6 }}>{name}</strong>{model.firstComment}</div> : null}
    </div>
  );
}

function Vertical({ model, account }: { model: PreviewModel; account: PreviewAccount }) {
  const item = model.media.find((m) => m.kind === "video") ?? model.media[0];
  return (
    <div style={{ ...frame, maxWidth: 270, background: "#000", color: "#fff", border: "1px solid #222", position: "relative", aspectRatio: "9 / 16" }}>
      {item ? <Tile item={item} style={{ position: "absolute", inset: 0 }} /> : <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#9ca3af", fontSize: 13, padding: 16, textAlign: "center" }}>{model.label} needs a video</div>}
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "40px 12px 12px", background: "linear-gradient(transparent, rgba(0,0,0,.75))", display: "grid", gap: 4 }}>
        <strong style={{ fontSize: 14 }}>{atHandle(account.handle) ?? account.name}</strong>
        {model.title ? <strong style={{ fontSize: 13 }}>{model.title}</strong> : null}
        <Text model={model} style={{ fontSize: 13, color: "#fff" }} />
      </div>
    </div>
  );
}

function Video({ model, account }: { model: PreviewModel; account: PreviewAccount }) {
  const item = model.media.find((m) => m.kind === "video") ?? model.media[0];
  return (
    <div style={frame}>
      {item ? <Tile item={item} style={{ aspectRatio: "16 / 9" }} /> : <div style={{ aspectRatio: "16 / 9", display: "grid", placeItems: "center", background: "#f0f2f5", color: SOFT, fontSize: 13 }}>YouTube needs a video</div>}
      <div style={{ display: "flex", gap: 10, padding: 12 }}>
        <Face account={account} size={36} />
        <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
          <strong style={{ fontSize: 15, overflowWrap: "anywhere" }}>{model.title ?? "(no title yet)"}</strong>
          <span style={{ fontSize: 12, color: SOFT }}>{account.name} · 0 views · now</span>
          <Text model={model} style={{ fontSize: 13, color: "#303030" }} />
        </div>
      </div>
    </div>
  );
}

function Pin({ model, account }: { model: PreviewModel; account: PreviewAccount }) {
  const item = model.media[0];
  return (
    <div style={{ ...frame, maxWidth: 270, borderRadius: 18 }}>
      {item ? <Tile item={item} style={{ aspectRatio: "2 / 3" }} /> : <div style={{ aspectRatio: "2 / 3", display: "grid", placeItems: "center", background: "#f0f2f5", color: SOFT, fontSize: 13 }}>Pinterest needs an image</div>}
      <div style={{ display: "grid", gap: 4, padding: 12 }}>
        {model.title ? <strong style={{ fontSize: 15 }}>{model.title}</strong> : null}
        <Text model={model} style={{ fontSize: 13 }} />
        <div style={{ display: "flex", gap: 8, alignItems: "center", paddingTop: 4 }}><Face account={account} size={24} /><span style={{ fontSize: 12 }}>{account.name}</span></div>
      </div>
    </div>
  );
}

/** One platform's mock-up, with what that platform would refuse listed under it. */
export function PlatformPreview({ source, account }: { source: PreviewSource; account: PreviewAccount }) {
  const model = previewModel(source, account.platform);
  const Layout = { feed: Feed, micro: Micro, instagram: Instagram, vertical: Vertical, video: Video, pin: Pin }[model.layout];
  return (
    <div style={{ display: "grid", gap: 6, justifyItems: "start", minWidth: 0 }}>
      <Layout model={model} account={account} />
      <Muted>
        {model.label}: {model.length}{model.maxText ? ` of ${model.maxText}` : ""} characters{model.media.length ? ` · ${model.media.length} media` : ""}
      </Muted>
      {model.problems.map((problem) => <Muted key={problem} style={{ color: tone("bad").fg }}>• {problem}</Muted>)}
    </div>
  );
}

/** The accounts a post goes to, as the preview needs them; destinations of accounts this scope no longer lists keep their name. */
export function previewAccounts(accounts: Account[], destinations: Array<{ accountId: string; platform: string | null; accountName: string }>): PreviewAccount[] {
  return destinations.map((d) => {
    const account = accounts.find((a) => a.id === d.accountId);
    return { id: d.accountId, platform: d.platform, name: account?.displayName ?? d.accountName, handle: account?.handle ?? null, avatarUrl: account?.avatarUrl ?? null };
  });
}

/** A stand-in account so a post without destinations still shows something. */
export const NO_ACCOUNT: PreviewAccount = { id: "", platform: null, name: "Your account" };

/** The preview with a chip per account the post goes to. */
export function PostPreview({ source, accounts, empty }: { source: PreviewSource; accounts: PreviewAccount[]; empty?: string }) {
  const [activeId, setActiveId] = useState("");
  const active = accounts.find((a) => a.id === activeId) ?? accounts[0] ?? NO_ACCOUNT;
  return (
    <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
      {accounts.length > 1 ? (
        <Row>
          {accounts.map((account) => (
            <SmallButton key={account.id} aria-pressed={account.id === active.id} onClick={(event) => { event.stopPropagation(); setActiveId(account.id); }} style={{ ...chipStyle(account.id === active.id), gap: 6, display: "inline-flex", alignItems: "center" }}>
              <PlatformBadge platform={account.platform} size={18} />{platformLabel(account.platform)}
            </SmallButton>
          ))}
        </Row>
      ) : null}
      {accounts.length === 0 && empty ? <Muted style={{ color: tokens.muted }}>{empty}</Muted> : null}
      <PlatformPreview source={source} account={active} />
    </div>
  );
}
