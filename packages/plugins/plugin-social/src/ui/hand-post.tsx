/**
 * Post one destination by hand: copy the caption, hand the media to the platform's app (the phone's share sheet) or
 * save it, open the platform's own composer, then record the link. Used for manual accounts (no publishing link, for
 * example TikTok before its app approval) and for a destination whose automatic publish failed.
 */
import { useState } from "react";
import { Button, Input, tokens, tone } from "@partnersinbiz/pib-plugin-ui";
import { ExternalLink, ignore, Muted, platformLabel, Row, SmallButton } from "./parts.js";
import type { Destination, Post, RunAction } from "./types.js";

type ShareNavigator = Navigator & { canShare?: (data: { files?: File[] }) => boolean };

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers and pages without clipboard permission: a hidden field and the copy command.
    try {
      const field = document.createElement("textarea");
      field.value = text;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      const ok = document.execCommand("copy");
      field.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function fileName(url: string, index: number, mime: string | null): string {
  const last = url.split("?")[0]!.split("/").pop() || "";
  if (/\.[a-z0-9]{2,5}$/i.test(last)) return last;
  const ext = mime?.split("/")[1]?.replace("quicktime", "mov") ?? "bin";
  return `post-media-${index + 1}.${ext}`;
}

/** The media as files the share sheet can take; null when this browser cannot share files or a download fails. */
async function mediaFiles(media: Post["media"]): Promise<File[] | null> {
  const nav = navigator as ShareNavigator;
  if (typeof nav.share !== "function" || typeof nav.canShare !== "function") return null;
  try {
    const files: File[] = [];
    for (const [i, m] of media.entries()) {
      const res = await fetch(m.url);
      if (!res.ok) return null;
      const blob = await res.blob();
      files.push(new File([blob], fileName(m.url, i, m.mime ?? blob.type), { type: m.mime ?? blob.type }));
    }
    return nav.canShare({ files }) ? files : null;
  } catch {
    return null;
  }
}

export function canPostByHand(post: Post, d: Destination, isUser: boolean): boolean {
  if (!isUser || !d.handPost || d.status === "published" || d.status === "publishing") return false;
  if (!["approved", "scheduled", "publishing", "partially_published", "failed"].includes(post.status)) return false;
  return Boolean(d.manual) || d.status === "failed";
}

export function HandPost({ post, destination: d, run }: { post: Post; destination: Destination; run: RunAction }) {
  const hand = d.handPost!;
  const label = platformLabel(d.platform);
  const [copied, setCopied] = useState(false);
  const [files, setFiles] = useState<File[] | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [noShare, setNoShare] = useState(false);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const hasMedia = post.media.length > 0;

  const open = () => {
    // Copy first (inside the click), then open: the caption is on the clipboard whatever the platform does with the link.
    void copyText(hand.text).then(setCopied);
    window.open(hand.url, "_blank", "noopener");
  };
  const prepare = async () => {
    setPreparing(true);
    const ready = await mediaFiles(post.media);
    setPreparing(false);
    if (ready) setFiles(ready);
    else setNoShare(true);
  };
  const share = () => {
    if (!files) return;
    void copyText(hand.text).then(setCopied);
    // The share sheet lists the platform's app; most apps take the file and not the text, so the caption is copied too.
    void (navigator as ShareNavigator).share({ files, text: hand.text }).catch(ignore);
  };
  const mark = () => {
    setBusy(true);
    run("social.mark-destination-posted", { postId: post.id, destinationId: d.id, url: link.trim() || undefined }, `Marked as posted on ${label}`)
      .catch(ignore)
      .finally(() => setBusy(false));
  };

  return (
    <div style={{ display: "grid", gap: 8, padding: 10, borderRadius: 10, border: `1px solid ${tone("warn").border}`, background: tone("warn").soft, minWidth: 0 }}>
      <strong style={{ fontSize: 12 }}>{d.manual ? `Post this on ${label} by hand` : `Post this on ${label} yourself`}</strong>
      <Muted>
        {hand.prefilled
          ? `${label} opens with the text already in the box.`
          : `${label} has no link that fills in a post, so the caption is copied for you to paste.`}
        {hasMedia && hand.mediaByHand ? " Add the media there: send it to the app from your phone, or save it first." : ""}
      </Muted>
      {hand.title ? <Muted>Title: <strong>{hand.title}</strong></Muted> : null}
      {hasMedia && hand.mediaByHand ? (
        <Row>
          {files ? (
            <Button type="button" style={{ height: 28, fontSize: 12 }} onClick={share}>Send media to {label}</Button>
          ) : noShare ? null : (
            <SmallButton disabled={preparing} onClick={() => void prepare()}>{preparing ? "Getting the media ready…" : "Get media ready to send"}</SmallButton>
          )}
          {post.media.map((m, i) => (
            <a key={`${m.url}-${i}`} href={m.url} download={fileName(m.url, i, m.mime)} target="_blank" rel="noopener" style={{ color: tokens.fg, fontSize: 12, textDecoration: "underline" }}>
              Save {m.kind} {post.media.length > 1 ? i + 1 : ""}
            </a>
          ))}
        </Row>
      ) : null}
      {noShare ? <Muted>This browser cannot hand files to an app. Save the media and add it in {label}.</Muted> : null}
      <Row>
        <Button type="button" style={{ height: 28, fontSize: 12 }} onClick={open}>{hand.prefilled ? `Open ${label} with the text` : `Copy caption and open ${label}`}</Button>
        <SmallButton onClick={() => void copyText(hand.text).then(setCopied)}>{copied ? "Caption copied" : "Copy caption"}</SmallButton>
        {hand.firstComment ? <SmallButton onClick={() => void copyText(hand.firstComment!).then(ignore)}>Copy first comment</SmallButton> : null}
      </Row>
      <Row style={{ alignItems: "flex-end" }}>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder={`Link to the post on ${label} (optional)`} style={{ height: 30, fontSize: 12 }} />
        </div>
        <SmallButton disabled={busy} onClick={mark}>{busy ? "Saving…" : "Mark as posted"}</SmallButton>
        {d.status === "awaiting_manual" ? (
          <SmallButton
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Skip ${label} for this post? The account is removed from the post.`)) {
                run("social.skip-destination", { postId: post.id, destinationId: d.id }, `Skipped ${label}`).catch(ignore);
              }
            }}
          >
            Skip
          </SmallButton>
        ) : null}
      </Row>
      {d.externalUrl ? <ExternalLink href={d.externalUrl}>View on {label}</ExternalLink> : null}
    </div>
  );
}
