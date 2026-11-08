/**
 * The board on a phone (PAR-8094): editing needs a larger screen, so a board at 640 px or less is a review screen.
 * No React Flow here, so nothing drags, there are no handles and nothing connects. The selected result fills the
 * width; the other results sit in a strip under it; Reject / Approve stay at the bottom and use the `review` action.
 */
import { useState, type AnchorHTMLAttributes } from "react";
import { errorText } from "@partnersinbiz/pib-plugin-ui";
import { metaLine, posterFrameUrl, statusTone } from "./library.js";
import { previewPlaceholder } from "./preview-state.js";
import { awaitingLine, clipPrompt, nextAfterReview, reviewPill, type ReviewItem } from "./phone-review.js";
import { useStudioAction } from "./action.js";

export const phoneReviewCss = `
.studio-phone { display: grid; gap: 0.75rem; padding: 0.75rem 0.75rem calc(5.5rem + env(safe-area-inset-bottom)); min-width: 0; }
.studio-phone-head { display: flex; align-items: center; gap: 0.5rem; min-width: 0; }
.studio-phone-head a { flex: none; display: inline-grid; place-items: center; width: 3rem; height: 3rem; margin: -0.75rem -0.5rem -0.75rem -0.75rem; color: var(--foreground); text-decoration: none; font-size: var(--text-base, 1rem); }
.studio-phone-head h1 { flex: 1 1 auto; min-width: 0; margin: 0; font-size: var(--text-base, 1rem); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.studio-phone-banner { margin: 0; padding: 0.5rem 0.75rem; border: 1px solid var(--border); border-radius: 0.75rem; color: var(--muted-foreground); font-size: var(--text-compact, 13px); }
.studio-phone-main { display: grid; border: 1px solid var(--border); border-radius: 0.75rem; overflow: hidden; background: var(--card); color: var(--card-foreground, var(--foreground)); min-width: 0; }
.studio-phone-main .studio-media { border-radius: 0; aspect-ratio: 4 / 3; }
.studio-phone-main .studio-media > img, .studio-phone-main .studio-media > video { object-fit: cover; }
.studio-phone-body { display: grid; gap: 0.25rem; padding: 0.75rem; min-width: 0; }
.studio-phone-body h2 { margin: 0; font-size: var(--text-base, 1rem); font-weight: 600; overflow-wrap: anywhere; }
.studio-phone-body p { margin: 0; font-size: var(--text-compact, 13px); color: var(--muted-foreground); overflow-wrap: anywhere; }
.studio-phone-more { font: inherit; padding: 0; border: 0; background: none; color: var(--studio-accent, var(--ring)); cursor: pointer; }
.studio-phone-strip { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.5rem; margin: 0; padding: 0; list-style: none; }
.studio-phone-strip button { display: block; width: 100%; min-height: 3rem; padding: 0; border: 1px solid var(--border); border-radius: 0.5rem; overflow: hidden; background: var(--muted); cursor: pointer; position: relative; }
.studio-phone-strip .studio-media { aspect-ratio: 1; border-radius: 0; }
.studio-phone-strip .studio-media > img, .studio-phone-strip .studio-media > video { object-fit: cover; }
.studio-phone-strip .studio-pill { position: absolute; left: 0.25rem; top: 0.25rem; }
.studio-phone-note { margin: 0; color: var(--muted-foreground); font-size: var(--text-xs, 12px); }
.studio-phone-bar { position: fixed; z-index: 30; left: 0; right: 0; bottom: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; padding: 0.75rem 0.75rem calc(0.75rem + env(safe-area-inset-bottom)); border-top: 1px solid var(--border); background: var(--background); }
.studio-phone-bar button { min-height: 3rem; font: inherit; font-weight: 600; border-radius: 0.625rem; cursor: pointer; }
.studio-phone-bar button:disabled { opacity: 0.5; cursor: not-allowed; }
.studio-phone-reject { border: 1px solid var(--border); background: var(--card); color: var(--foreground); }
.studio-phone-approve { border: 1px solid var(--foreground); background: var(--foreground); color: var(--background); }
.studio-phone button:focus-visible, .studio-phone-bar button:focus-visible, .studio-phone a:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
`;

const TONE_CLASS = { warn: "draft", ok: "approved", bad: "rejected", neutral: "neutral" } as const;

export function PhoneReview({
  companyId,
  title,
  items,
  urls,
  previewError = null,
  modelLabel,
  canReview,
  backLink,
  onReviewed,
}: {
  companyId: string;
  title: string;
  items: ReviewItem[];
  urls: Record<string, string>;
  /** The last preview request failed: cards say so instead of "Loading". */
  previewError?: string | null;
  modelLabel: (id: string) => string;
  /** Viewers can't review (the worker refuses them too), so they don't get the bar. */
  canReview: boolean;
  backLink: AnchorHTMLAttributes<HTMLAnchorElement>;
  onReviewed: () => void;
}) {
  const reviewAction = useStudioAction("review");
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const selected = items.find((i) => i.assetId === pickedId) ?? items[0] ?? null;
  const others = items.filter((i) => i !== selected);

  const pick = (id: string) => {
    setPickedId(id);
    setOpen(false);
    setMessage(null);
  };

  async function review(decision: "approved" | "rejected") {
    if (!selected) return;
    setBusy(true);
    setMessage(null);
    try {
      const out = (await reviewAction({ companyId, assetId: selected.assetId, decision })) as { changed: boolean; exported: boolean };
      setMessage({ tone: "ok", text: out.exported ? "Approved. It's on its way to Social's media library for this client." : out.changed ? (decision === "approved" ? "Approved." : "Rejected.") : `Already ${decision}.` });
      // The reviewed one is no longer a draft; move on to the next draft.
      const next = nextAfterReview(items.map((i) => (i.assetId === selected.assetId ? { ...i, status: decision } : i)), selected.assetId);
      setPickedId(next);
      setOpen(false);
      onReviewed();
    } catch (err) {
      setMessage({ tone: "bad", text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  const prompt = selected ? clipPrompt(selected.prompt) : { text: "", clipped: false };
  return (
    <>
      <style>{phoneReviewCss}</style>
      <div className="studio-phone">
        <header className="studio-phone-head">
          <a {...backLink} aria-label="All canvases">‹</a>
          <h1 title={title}>{title}</h1>
          <span className="studio-chip">View only</span>
        </header>
        <p className="studio-phone-banner" role="note">Editing boards needs a larger screen. Review and approve here.</p>
        {selected ? (
          <article className="studio-phone-main" aria-label="Selected result">
            <Thumb item={selected} url={urls[selected.assetId]} previewError={previewError} big />
            <div className="studio-phone-body">
              <h2>{selected.title}</h2>
              <p>{metaLine({ kind: selected.kind, model: selected.model, credits: selected.credits, createdAt: null }, modelLabel)}</p>
              {selected.prompt ? (
                <p>
                  Prompt: {open ? selected.prompt : prompt.text}
                  {prompt.clipped ? <> <button type="button" className="studio-phone-more" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Less" : "More"}</button></> : null}
                </p>
              ) : <p>No prompt saved for this file.</p>}
            </div>
          </article>
        ) : null}
        {others.length ? (
          <ul className="studio-phone-strip" aria-label="Other results">
            {others.map((i) => (
              <li key={i.assetId}>
                <button type="button" onClick={() => pick(i.assetId)} aria-label={`${i.title}, ${reviewPill(i.status)}`}>
                  <Thumb item={i} url={urls[i.assetId]} previewError={previewError} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="studio-phone-note" role="status">{awaitingLine(items)}</p>
        {message ? <p role={message.tone === "bad" ? "alert" : "status"} className="studio-phone-note" style={message.tone === "bad" ? { color: "var(--destructive)" } : undefined}>{message.text}</p> : null}
        {!canReview && selected ? <p className="studio-phone-note">You can look at this board; reviewing needs edit access.</p> : null}
      </div>
      {canReview && selected ? (
        <div className="studio-phone-bar" role="group" aria-label="Review">
          <button type="button" className="studio-phone-reject" disabled={busy || selected.status === "rejected"} onClick={() => void review("rejected")}>Reject</button>
          <button type="button" className="studio-phone-approve" disabled={busy || selected.status === "approved"} onClick={() => void review("approved")}>{busy ? "Saving…" : selected.status === "approved" ? "Approved" : "Approve"}</button>
        </div>
      ) : null}
    </>
  );
}

/** A result's picture or first video frame with its status pill; the big one shows the pill top-left like the mock. */
function Thumb({ item, url, big, previewError = null }: { item: ReviewItem; url: string | undefined; big?: boolean; previewError?: string | null }) {
  const tone = TONE_CLASS[statusTone(item.status)];
  return (
    <div className="studio-media">
      {!url ? <div className="studio-media-empty" title={previewError ?? undefined} style={{ height: "100%", border: 0 }}>{previewPlaceholder(previewError)}</div>
        : item.kind === "audio" && !big ? <div aria-label={`${item.title} (audio)`} role="img" style={{ height: "100%", display: "grid", placeItems: "center", fontSize: 24 }}>♪</div>
        : item.kind === "audio" ? <div style={{ height: "100%", display: "grid", placeItems: "center", padding: 8, boxSizing: "border-box" }}><audio src={url} controls preload="metadata" aria-label={item.title} style={{ width: "100%" }} /></div>
        : item.kind === "video" ? <video src={big ? url : posterFrameUrl(url)} muted playsInline controls={big} preload="metadata" />
        : <img src={url} alt={item.title} />}
      {big ? <div className="studio-overlay" style={{ left: "0.5rem", top: "0.5rem" }}><span className={`studio-pill studio-tone-${tone}`} aria-label="Review status">{reviewPill(item.status)}</span></div> : null}
    </div>
  );
}
