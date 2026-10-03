// The client approval page: pure rendering and form checks for server.mjs (unit-tested in tests/approval-server.spec.ts).
// No I/O here. Everything that came from the database or the client is escaped; media is shown only from https addresses.
import { createHash } from "node:crypto";

/** A link token: 32 random bytes as base64url (43 characters). Anything else is not a link we made. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** What the database stores: the SHA-256 (hex) of the token in the URL. Must match the plugin's `hashToken`. */
export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export const esc = (value) =>
  String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Security headers: no scripts at all, images and video only over https, no referrer (the token is in the URL), never cached or indexed. */
export const SECURITY_HEADERS = {
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; img-src https: data:; media-src https:; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

const STYLE = `
*{box-sizing:border-box}body{margin:0;background:#f4f5f7;color:#16181d;font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:640px;margin:0 auto;padding:16px 16px 48px}h1{font-size:22px;margin:16px 0 4px}h2{font-size:15px;margin:0 0 8px}
.muted{color:#5b6270;font-size:14px}.card{background:#fff;border:1px solid #dfe2e8;border-radius:12px;padding:14px 16px;margin:12px 0}
.text{white-space:pre-wrap;overflow-wrap:anywhere}.media{display:grid;gap:8px;margin:12px 0}.media img,.media video{width:100%;height:auto;border-radius:8px;border:1px solid #dfe2e8;background:#000}
label{display:block;font-weight:600;margin:12px 0 4px}input,textarea{width:100%;font:inherit;padding:10px 12px;border:1px solid #b9bfca;border-radius:8px;background:#fff}
textarea{min-height:96px}.row{display:flex;gap:12px;flex-wrap:wrap;margin-top:16px}
button{flex:1 1 180px;font:inherit;font-weight:700;padding:14px 16px;border-radius:10px;border:0;cursor:pointer}
.yes{background:#13795b;color:#fff}.no{background:#fff;color:#16181d;border:1px solid #b9bfca}
.err{background:#fde8e8;border:1px solid #f5b5b5;color:#7a1a1a;padding:10px 12px;border-radius:8px;margin:12px 0}
.ok{background:#e6f4ee;border:1px solid #b3dcc9;color:#0d5a43;padding:10px 12px;border-radius:8px;margin:12px 0}
.pill{display:inline-block;background:#eef0f4;border-radius:999px;padding:2px 10px;font-size:13px;font-weight:600}
`;

const shell = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;

/** A one-message page (invalid link, expired, thank you). */
export function messagePage(title, text, tone = "plain") {
  return shell(title, `<h1>${esc(title)}</h1><div class="${tone === "ok" ? "ok" : tone === "err" ? "err" : "card"}"><p>${esc(text)}</p></div>`);
}

function whenText(value, timeZone) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-ZA", { timeZone: timeZone || "Africa/Johannesburg", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  } catch {
    return date.toISOString();
  }
}

const httpsOnly = (url) => typeof url === "string" && /^https:\/\//i.test(url) && url.length < 2000;

function mediaHtml(media) {
  const items = (Array.isArray(media) ? media : []).filter((m) => httpsOnly(m?.url)).slice(0, 20);
  if (items.length === 0) return "";
  return `<div class="media">${items
    .map((m) =>
      m.kind === "video"
        ? `<video controls playsinline preload="metadata" src="${esc(m.url)}"></video>`
        : `<img loading="lazy" src="${esc(m.url)}" alt="${esc(m.altText || "Image in the post")}">`,
    )
    .join("")}</div>`;
}

/**
 * The page a client sees: the post as it will appear on each account, then the decision form.
 * `state`: `{ status, answeredBy, answeredAt, error, values, action }` (`action` is the form's absolute path). A post already answered shows the answer and no form.
 */
export function approvalPage(snapshot, state = {}) {
  const s = snapshot && typeof snapshot === "object" ? snapshot : {};
  const destinations = Array.isArray(s.destinations) ? s.destinations : [];
  const when = whenText(s.scheduledAt, s.timezone);
  const poster = s.poster ? esc(s.poster) : "Your social media team";
  const cards = destinations
    .map(
      (d) =>
        `<section class="card"><h2><span class="pill">${esc(d.label || d.platform)}</span> ${esc(d.account)}</h2>${d.title ? `<p><strong>${esc(d.title)}</strong></p>` : ""}<div class="text">${esc(d.text)}</div>${d.link ? `<p class="muted">Link: ${esc(d.link)}</p>` : ""}</section>`,
    )
    .join("");
  const first = s.firstComment ? `<section class="card"><h2>First comment</h2><div class="text">${esc(s.firstComment)}</div></section>` : "";
  const answered = state.status === "approved" || state.status === "changes_requested";
  const answerBanner = answered
    ? `<div class="ok">${state.status === "approved" ? "You approved this post" : "You asked for changes"}${state.answeredBy ? `, ${esc(state.answeredBy)}` : ""}${state.answeredAt ? ` (${esc(whenText(state.answeredAt, s.timezone) ?? "")})` : ""}. Thank you.</div>`
    : "";
  const v = state.values ?? {};
  const form = answered
    ? ""
    : `<form method="post" action="${esc(state.action ?? "decision")}" class="card"><h2>Your answer</h2>${state.error ? `<div class="err">${esc(state.error)}</div>` : ""}
<label for="name">Your name</label><input id="name" name="name" maxlength="120" autocomplete="name" value="${esc(v.name ?? "")}">
<label for="note">Comments (needed if you ask for changes)</label><textarea id="note" name="note" maxlength="1000">${esc(v.note ?? "")}</textarea>
<div class="row"><button class="yes" type="submit" name="decision" value="approved">Approve</button><button class="no" type="submit" name="decision" value="changes_requested">Request changes</button></div>
<p class="muted">Nothing is posted until you approve. Approving covers exactly what you see on this page.</p></form>`;
  return shell(
    "Approve your post",
    `<h1>Please approve this post</h1><p class="muted">${s.clientName ? `For ${esc(s.clientName)}. ` : ""}Prepared by ${poster}${when ? `. Planned for ${esc(when)}` : ""}.</p>${answerBanner}${mediaHtml(s.media)}${cards}${first}${form}`,
  );
}

/** Reads the decision form. Returns `{ ok: true, decision, name, note }` or `{ ok: false, error, values }` to show again. */
export function parseDecision(form) {
  const decision = form.get("decision");
  const name = String(form.get("name") ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  const note = String(form.get("note") ?? "").trim().slice(0, 1000);
  const values = { name, note };
  if (decision !== "approved" && decision !== "changes_requested") return { ok: false, error: "Please choose Approve or Request changes.", values };
  if (name.length < 2) return { ok: false, error: "Please type your name, so we know who answered.", values };
  if (decision === "changes_requested" && note.length < 3) return { ok: false, error: "Please say what you would like changed.", values };
  return { ok: true, decision, name, note: note || null };
}
