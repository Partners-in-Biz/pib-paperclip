// Public client preview service (preview.partnersinbiz.online, behind Caddy). Serves the proposals the SEO plugin
// saved in plugin_seo_8099f8879a.previews and records the client's Approve / Request changes answer.
// Runs as its own systemd unit with a database role that can read previews and write only the answer columns.
import http from "node:http";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { chromiumEnv, domArgs, makeProfile, SHOT_MAX_AGE_MS, shotArgs, sweepProfiles, sweepShots } from "./sweep.mjs";

const require = createRequire("/home/paperclip/paperclip-runtime/current/node_modules/");
const { Pool } = require("pg");

const SCHEMA = "plugin_seo_8099f8879a";
const PORT = Number(process.env.PORT ?? 3031);
const CHROME = process.env.CHROME_PATH ?? "/home/paperclip/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";
const SHOTS = process.env.SHOTS_DIR ?? "/tmp/pib-preview-shots";
// One private folder per Chromium run, removed when it ends (sweep.mjs); the service's /tmp is private, so nothing else cleans it.
const PROFILES = process.env.PROFILES_DIR ?? "/tmp/pib-preview-profiles";
// A cached screenshot is reused for an hour, minus a margin so the sweep never deletes one while it is being served.
const SHOT_REUSE_MS = SHOT_MAX_AGE_MS - 300_000;

/** Delete screenshots and leftover profile folders older than an hour. Runs on every call that starts Chromium; never throws. */
async function housekeeping() {
  try {
    const [shots, profiles] = await Promise.all([sweepShots(SHOTS), sweepProfiles(PROFILES)]);
    if (shots + profiles > 0) console.log(`housekeeping: removed ${shots} screenshot(s) and ${profiles} profile folder(s)`);
  } catch (error) {
    console.error("housekeeping failed", error instanceof Error ? error.message : error);
  }
}

/** Run Chromium with its own profile folder, which is removed afterwards whatever happens. */
async function withChromium(run) {
  const profile = await makeProfile(PROFILES);
  try {
    return await run(profile.dir);
  } finally {
    await profile.cleanup();
  }
}
const pool = new Pool({ connectionString: process.env.PREVIEW_DATABASE_URL, max: 4 });

const SECURITY = {
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src * data: blob:; script-src 'none'; style-src * 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'; base-uri *",
};

const page = (text) => `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preview</title><body style="font:18px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;text-align:center"><p>${text}</p></body>`;
const send = (res, status, body, type = "text/html; charset=utf-8") => {
  res.writeHead(status, { "Content-Type": type, ...SECURITY });
  res.end(body);
};

const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const entry = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  entry.push(now);
  hits.set(ip, entry);
  if (hits.size > 5000) hits.clear();
  return entry.length > 90;
}

const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;

async function readForm(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw new Error("too large");
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
function wordsOf(html) {
  const text = html
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<div id="pib-preview-bar"[\s\S]*?<\/form><\/div><div style="height:64px"><\/div>/i, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&");
  return (text.toLowerCase().match(WORD) ?? []).slice(0, 200_000);
}

/** What a visitor's browser ends up showing (scripts run), as HTML. */
function renderedDom(url) {
  const run = async () => {
    await housekeeping();
    return withChromium(
      (dir) =>
        new Promise((resolve, reject) => {
          execFile(
            CHROME,
            domArgs(dir, url),
            { timeout: 60_000, maxBuffer: 40 * 1024 * 1024, env: chromiumEnv(dir) },
            (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
          );
        }),
    );
  };
  const next = shotQueue.then(run, run);
  shotQueue = next.catch(() => undefined);
  return next;
}

/** Share of the live page's visible words (as rendered) that the proposal still shows. */
async function renderedStats(row, token) {
  const [live, proposed] = [await renderedDom(row.page_url), await renderedDom(`http://127.0.0.1:${PORT}/p/${token}?key=${encodeURIComponent(row.review_key)}`)];
  const a = wordsOf(live);
  const b = wordsOf(proposed);
  const pool = new Map();
  for (const w of b) pool.set(w, (pool.get(w) ?? 0) + 1);
  let kept = 0;
  for (const w of a) {
    const n = pool.get(w) ?? 0;
    if (n > 0) {
      kept += 1;
      pool.set(w, n - 1);
    }
  }
  return { liveWords: a.length, previewWords: b.length, keptPct: a.length ? Math.round((kept / a.length) * 100) : 100, addedWords: Math.max(0, b.length - kept), removedWords: Math.max(0, a.length - kept), at: new Date().toISOString() };
}

/** One screenshot at a time: Chromium is heavy and the pages are reviewed one by one. */
let shotQueue = Promise.resolve();
function screenshot(url, file, mobile = false) {
  const run = async () => {
    await housekeeping();
    return withChromium(
      (dir) =>
        new Promise((resolve, reject) => {
          execFile(
            CHROME,
            shotArgs(dir, url, file, mobile),
            { timeout: 60_000, env: chromiumEnv(dir) },
            (error) => (error ? reject(error) : resolve()),
          );
        }),
    );
  };
  const next = shotQueue.then(run, run);
  shotQueue = next.catch(() => undefined);
  return next;
}

async function shotFor(row, token, which, mobile = false) {
  await housekeeping();
  await mkdir(SHOTS, { recursive: true });
  const file = `${SHOTS}/${token}-${which}${mobile ? "-m" : ""}.png`;
  try {
    const st = await stat(file);
    if (Date.now() - st.mtimeMs < SHOT_REUSE_MS) return readFile(file);
  } catch {}
  const url = which === "live" ? row.page_url : `http://127.0.0.1:${PORT}/p/${token}?key=${encodeURIComponent(row.review_key)}`;
  await screenshot(url, file, mobile);
  return readFile(file);
}

function reviewPage(token, key, row) {
  const st = typeof row.stats === "string" ? JSON.parse(row.stats) : row.stats ?? {};
  const base = `/p/${token}`;
  const q = `key=${encodeURIComponent(key)}`;
  return `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review: ${esc(row.title)}</title>
<body style="font:15px/1.5 system-ui,sans-serif;margin:0;padding:16px;background:#f3f4f6;color:#111">
<h1 style="font-size:20px;margin:0 0 4px">Check before the client sees it</h1>
<p style="margin:0 0 12px">${esc(row.title)}<br><a href="${esc(row.page_url)}">${esc(row.page_url)}</a> · review status: <strong>${esc(row.review_status)}</strong></p>
${(() => {
  const r = st.rendered;
  if (!r) return `<p style="background:#fef3c7;padding:8px 12px;border-radius:6px">The rendered check could not be made. Do not pass this preview until it works: reload this page.</p>`;
  const bad = r.keptPct < 70;
  return `<p style="background:${bad ? "#fee2e2" : "#dcfce7"};padding:8px 12px;border-radius:6px;margin:0 0 12px"><strong>What a visitor sees:</strong> the proposal still shows <strong>${esc(r.keptPct)}%</strong> of the live page's text (${esc(r.liveWords)} words live, ${esc(r.removedWords)} missing, ${esc(r.addedWords)} new). ${bad ? "A lot of the live page is missing from the proposal. Do not pass it." : "Now compare the screenshots for layout, listings and images."}</p>`;
})()}
<p style="margin:0 0 4px;color:#555">Figures from the page source (before scripts run):</p>
<table style="border-collapse:collapse;background:#fff;margin-bottom:12px"><tbody>
<tr><td style="padding:4px 12px">Words on the live page</td><td><strong>${esc(st.liveWords)}</strong></td></tr>
<tr><td style="padding:4px 12px">Words on the proposal</td><td><strong>${esc(st.previewWords)}</strong></td></tr>
<tr><td style="padding:4px 12px">Live text kept</td><td><strong>${esc(st.keptPct)}%</strong> (added ${esc(st.addedWords)}, removed ${esc(st.removedWords)})</td></tr></tbody></table>
<p style="margin:0 0 8px">Left: the live page as it is now (with its scripts, so listings and menus show). Right: the proposal (static copy of the same page with the new copy added). Anything on the left that is missing on the right is a problem. Images: <a href="${base}/shot/live?${q}">live.png</a> · <a href="${base}/shot/proposed?${q}">proposed.png</a> (first load takes up to a minute).</p>
<div style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap">
<figure style="margin:0;flex:1;min-width:300px"><figcaption><strong>Live now</strong></figcaption><img style="width:100%;border:1px solid #ccc;background:#fff" src="${base}/shot/live?${q}" alt="live"></figure>
<figure style="margin:0;flex:1;min-width:300px"><figcaption><strong>Proposal</strong></figcaption><img style="width:100%;border:1px solid #ccc;background:#fff" src="${base}/shot/proposed?${q}" alt="proposal"></figure>
</div>
<h2 style="font-size:16px;margin:16px 0 4px">On a phone</h2>
<div style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap">
<figure style="margin:0"><figcaption><strong>Live now</strong></figcaption><img style="width:260px;border:1px solid #ccc;background:#fff" src="${base}/shot/live-mobile?${q}" alt="live phone"></figure>
<figure style="margin:0"><figcaption><strong>Proposal</strong></figcaption><img style="width:260px;border:1px solid #ccc;background:#fff" src="${base}/shot/proposed-mobile?${q}" alt="proposal phone"></figure>
</div></body>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim();
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/health") return send(res, 200, "ok", "text/plain");
    if (limited(ip)) return send(res, 429, page("Too many requests. Please try again in a minute."));
    // /p/<site>/<token>[...]: the site name is only there to read; the token is the secret. /p/<token> (older links) works too.
    const m = /^\/p\/(?:[a-z0-9-]{1,30}\/)?([A-Za-z0-9_-]{20,64})(\/decision|\/review|\/shot\/(?:live|proposed)(?:-mobile)?)?$/.exec(url.pathname);
    if (!m) return send(res, 404, page("This preview link is not valid."));
    const token = m[1];
    const key = url.searchParams.get("key") ?? "";
    const staff = async () => {
      const { rows } = await pool.query(`SELECT page_url, title, stats, review_key, review_status, html, expires_at < now() AS expired FROM ${SCHEMA}.previews WHERE id = $1`, [token]);
      return rows[0] && rows[0].review_key && key && key === rows[0].review_key ? rows[0] : null;
    };
    const sub = m[2] ?? "";
    if (req.method === "GET" && sub === "") {
      const { rows } = await pool.query(`SELECT html, review_status, review_key, expires_at < now() AS expired FROM ${SCHEMA}.previews WHERE id = $1`, [token]);
      if (!rows[0]) return send(res, 404, page("This preview link is not valid."));
      if (rows[0].expired) return send(res, 410, page("This preview has expired. Ask us for a fresh link."));
      if (key && key === rows[0].review_key) return send(res, 200, rows[0].html);
      if (rows[0].review_status !== "passed") return send(res, 200, page("This preview is being checked and is not ready yet. Please try again later."));
      return send(res, 200, rows[0].html);
    }
    if (req.method === "GET" && sub === "/review") {
      const row = await staff();
      if (!row) return send(res, 404, page("This link is not valid."));
      const stats = typeof row.stats === "string" ? JSON.parse(row.stats) : row.stats ?? {};
      if (!stats.rendered) {
        try {
          const rendered = await renderedStats(row, token);
          await pool.query(`UPDATE ${SCHEMA}.previews SET stats = stats || jsonb_build_object('rendered', $2::jsonb) WHERE id = $1`, [token, JSON.stringify(rendered)]);
          row.stats = { ...stats, rendered };
        } catch (error) {
          console.error("rendered check failed", error instanceof Error ? error.message : error);
        }
      }
      return send(res, 200, reviewPage(token, key, row));
    }
    const shot = /^\/(shot)\/(live|proposed)(-mobile)?$/.exec(sub);
    if (req.method === "GET" && shot) {
      const row = await staff();
      if (!row) return send(res, 404, page("This link is not valid."));
      try {
        return send(res, 200, await shotFor(row, token, shot[2], Boolean(shot[3])), "image/png");
      } catch (error) {
        console.error("screenshot failed", error instanceof Error ? error.message : error);
        return send(res, 502, page("The screenshot could not be made. Try again in a minute."));
      }
    }
    if (req.method === "POST" && sub === "/decision") {
      const form = await readForm(req);
      const decision = form.get("decision");
      if (decision !== "approved" && decision !== "changes_requested") return send(res, 400, page("Please choose Approve or Request changes."));
      const note = (form.get("note") ?? "").trim().slice(0, 1000) || null;
      const { rowCount } = await pool.query(
        `UPDATE ${SCHEMA}.previews SET status = $2, decision_note = $3, decided_at = now(), notified_at = NULL WHERE id = $1 AND expires_at > now() AND review_status = 'passed'`,
        [token, decision, note],
      );
      if (!rowCount) return send(res, 409, page("This preview is not ready for an answer yet, or has expired."));
      return send(res, 200, page(decision === "approved" ? "Thank you. We have your approval and will make the change." : "Thank you. We have your comments and will send an updated version."));
    }
    return send(res, 405, page("Not allowed."));
  } catch (error) {
    console.error("preview error", error instanceof Error ? error.message : error);
    return send(res, 500, page("Something went wrong. Please try again."));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`preview service on 127.0.0.1:${PORT}`);
  void housekeeping();
});
