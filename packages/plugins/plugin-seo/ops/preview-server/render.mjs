// /render for the SEO plugin's create-preview (PAR-8799, plan PAR-8787 r3): POST {url} -> {html}, the DOM a visitor's
// browser ends up with at 1280 px (scripts on). Served by server.mjs on 127.0.0.1:3033 only, never through Caddy
// (3032, the plan's first pick, is the Social approval service on the same VPS).
// - The URL must pass checkRenderUrl (http/https, port 80/443, every address public): else 400, Chromium never starts.
// - Chromium runs with renderArgs: every connection it makes goes through the egress proxy (egress.mjs).
// - One render at a time, own slot (not the screenshot queue): a second request gets 503 at once.
// - Chromium is killed (whole process group) after 14 s (504), when its output passes 10 MiB (413), when the caller
//   goes away and on shutdown. Its profile folder is removed only after it has exited.
import { spawn as nodeSpawn } from "node:child_process";
import { chromiumEnv, checkRenderUrl, lookupAll, renderArgs } from "./sweep.mjs";

export const RENDER_PORT = 3033;
export const RENDER_TIMEOUT_MS = 14_000;
export const RENDER_MAX_BYTES = 10 * 1024 * 1024;
export const RENDER_BODY_MAX = 8192;

const json = (res, status, body) => {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

/** Kill a detached child and everything it started (Chromium forks helpers into the same process group). */
export function killGroup(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

async function readBody(req, max) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The /render handler. Everything that touches the system is injectable for tests:
 * - `proxyPort`: the running egress proxy's port.
 * - `chrome()`: path of the Chromium binary (findChrome).
 * - `withChromium(run)`: runs `run(profileDir)` and removes the folder afterwards (server.mjs).
 * - `checkUrl(url)`: defaults to checkRenderUrl with `resolve`.
 * - `spawn`, `kill`, `timeoutMs`, `maxBytes`, `before()` (housekeeping), `log`.
 */
export function createRenderService({ proxyPort, chrome, withChromium, resolve = lookupAll, checkUrl = (url) => checkRenderUrl(url, resolve), spawn = nodeSpawn, kill = killGroup, timeoutMs = RENDER_TIMEOUT_MS, maxBytes = RENDER_MAX_BYTES, before = async () => {}, log = () => {} }) {
  let current = null; // the running Chromium child
  let busy = false;

  function runChromium(bin, dir, url, res) {
    return new Promise((done) => {
      const child = spawn(bin, renderArgs(dir, url, proxyPort), { detached: true, stdio: ["ignore", "pipe", "pipe"], env: chromiumEnv(dir) });
      current = child;
      const out = [];
      let bytes = 0;
      let outcome = null; // the answer, decided once
      let err = "";
      const decide = (status, body, stop) => {
        if (outcome) return;
        outcome = { status, body };
        clearTimeout(timer);
        if (stop) kill(child);
        json(res, status, body);
      };
      const timer = setTimeout(() => decide(504, { error: `render took longer than ${timeoutMs} ms` }, true), timeoutMs);
      res.on("close", () => decide(499, { error: "caller went away" }, true));
      child.stdout.on("data", (chunk) => {
        if (outcome) return;
        bytes += chunk.length;
        if (bytes > maxBytes) return decide(413, { error: `rendered page is larger than ${maxBytes} bytes` }, true);
        out.push(chunk);
      });
      child.stderr.on("data", (chunk) => {
        err = (err + chunk).slice(-2000);
      });
      child.on("error", (error) => {
        decide(500, { error: `Chromium did not start: ${error.message}` }, false);
        done(outcome);
      });
      child.on("close", (code, signal) => {
        if (code === 0) decide(200, { html: Buffer.concat(out).toString("utf8") }, false);
        else decide(500, { error: `Chromium failed (${signal ?? `exit ${code}`})` }, false);
        if (outcome.status !== 200) log(`render ${url}: ${outcome.status} ${outcome.body.error}${err ? ` | ${err.trim().split("\n").pop()}` : ""}`);
        done(outcome);
      });
    });
  }

  async function handle(req, res) {
    try {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (path !== "/render") return json(res, 404, { error: "not found" });
      if (req.method !== "POST") return json(res, 405, { error: "POST only" });
      const text = await readBody(req, RENDER_BODY_MAX);
      if (text === null) return json(res, 413, { error: `request body larger than ${RENDER_BODY_MAX} bytes` });
      let url;
      try {
        url = JSON.parse(text)?.url;
      } catch {}
      if (typeof url !== "string" || !url) return json(res, 400, { error: 'JSON body {"url": "..."} required' });
      if (busy) return json(res, 503, { error: "a render is already running; try again shortly" });
      busy = true;
      try {
        let checked;
        try {
          checked = await checkUrl(url);
        } catch (error) {
          return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        await before();
        const bin = await chrome();
        if (res.destroyed) return;
        await withChromium((dir) => runChromium(bin, dir, checked.url, res));
      } finally {
        current = null;
        busy = false;
      }
    } catch (error) {
      log(`render error: ${error instanceof Error ? error.message : error}`);
      json(res, 500, { error: "render failed" });
    }
  }

  return {
    handle,
    isBusy: () => busy,
    /** Shutdown: kill the running Chromium, if any. */
    stop: () => {
      if (current) kill(current);
    },
  };
}

const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const SOURCE_BASIS_NOTICE = "Made from the page source: header and scripted parts may differ.";

/**
 * The review page's one kept-text figure: `stats.rendered` (stored once by create-preview, or measured on the first
 * review-page open). No source figures. On source basis (`stats.basis` missing or not "rendered") the notice follows.
 */
export function keptTextFigure(stats) {
  const st = stats ?? {};
  const r = st.rendered;
  const notice = st.basis === "rendered" ? "" : `<p style="margin:0 0 12px;color:#555">${SOURCE_BASIS_NOTICE}</p>`;
  if (!r || !(r.liveWords > 0)) return `<p style="background:#fef3c7;padding:8px 12px;border-radius:6px">The rendered check could not be made. Do not pass this preview until it works: reload this page.</p>${notice}`;
  const bad = r.keptPct < 70;
  return `<p style="background:${bad ? "#fee2e2" : "#dcfce7"};padding:8px 12px;border-radius:6px;margin:0 0 12px"><strong>What a visitor sees:</strong> the proposal still shows <strong>${esc(r.keptPct)}%</strong> of the live page's text (${esc(r.liveWords)} words live, ${esc(r.removedWords)} missing, ${esc(r.addedWords)} new). ${bad ? "A lot of the live page is missing from the proposal. Do not pass it." : "Now compare the screenshots for layout, listings and images."}</p>${notice}`;
}
