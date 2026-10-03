// Public client approval service (served under /a/ on the preview domain, behind Caddy). Shows a client the social post a
// plugin-social "request-client-approval" froze for them and records their Approve / Request changes answer once.
// Its own systemd unit and its own database role: the role can read the snapshot and write only the answer columns, so a
// bug here cannot touch anything else. The plugin's 5-minute job `client-answers` applies the answer; nothing is posted here.
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import { approvalPage, hashToken, messagePage, parseDecision, SECURITY_HEADERS, TOKEN_RE } from "./render.mjs";

const require = createRequire("/home/paperclip/paperclip-runtime/current/node_modules/");
const { Pool } = require("pg");

const SCHEMA = "plugin_social_e70c4e79f2";
const PORT = Number(process.env.PORT ?? 3032);
const PREFIX = "/a";
const pool = new Pool({ connectionString: process.env.APPROVAL_DATABASE_URL, max: 3, connectionTimeoutMillis: 5000, statement_timeout: 8000 });
// An idle connection the database dropped must not crash the service (systemd would restart it, but a client would see an error first).
pool.on("error", (error) => console.error("approval pool error", error instanceof Error ? error.message : error));

const send = (res, status, body, type = "text/html; charset=utf-8") => {
  res.writeHead(status, { "Content-Type": type, ...SECURITY_HEADERS });
  res.end(body);
};

// A few answers a minute per address is plenty for a person; this stops guessing and floods.
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > 60;
}

// An answer has to come from a client's own device. One that arrives from this server itself (an agent that was handed the link
// and calls the public address, or this machine's own loopback) is not a client and is refused. Caddy sets X-Forwarded-For to the
// real peer address, so behind it this is the client's address. This is a speed bump, not a wall: a process on this server that
// calls the port directly with a made-up X-Forwarded-For is not stopped, which is why a policy where ONLY the client approves
// trusts whoever holds the link (the Social page says so when it is set).
const normalizeIp = (ip) => String(ip).trim().toLowerCase().replace(/^::ffff:/, "").replace(/%.*$/, "");
function serverAddresses() {
  const own = new Set(["127.0.0.1", "::1", "0.0.0.0", "::", ""]);
  for (const list of Object.values(os.networkInterfaces())) for (const entry of list ?? []) own.add(normalizeIp(entry.address));
  return own;
}
const fromThisServer = (ip) => serverAddresses().has(normalizeIp(ip));

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

const COLUMNS = "status, snapshot, answered_by_name, answered_at, expires_at < now() AS expired";

async function lookup(token) {
  const { rows } = await pool.query(`SELECT ${COLUMNS} FROM ${SCHEMA}.client_approvals WHERE token_hash = $1`, [hashToken(token)]);
  return rows[0] ?? null;
}

const snapshotOf = (row) => (typeof row.snapshot === "string" ? JSON.parse(row.snapshot) : row.snapshot ?? {});

const GONE = {
  expired: ["This link has expired", "Please ask us for a fresh link."],
  superseded: ["This link is no longer current", "The post was changed or has been dealt with since we sent this link. Please use the latest email we sent you, or reply to us."],
};

const server = http.createServer(async (req, res) => {
  try {
    const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim();
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === `${PREFIX}/health`) {
      // Healthy means the database answers too: the plugin checks this before it hands a client a link.
      await pool.query("SELECT 1");
      return send(res, 200, "ok", "text/plain");
    }
    if (limited(ip)) return send(res, 429, messagePage("Too many requests", "Please try again in a minute."));
    const m = new RegExp(`^${PREFIX}/([A-Za-z0-9_-]{43})(/decision)?$`).exec(url.pathname);
    if (!m || !TOKEN_RE.test(m[1])) return send(res, 404, messagePage("This link is not valid", "Please check the link in your email, or ask us for a new one."));
    const token = m[1];
    const row = await lookup(token);
    if (!row) return send(res, 404, messagePage("This link is not valid", "Please check the link in your email, or ask us for a new one."));
    const action = `${PREFIX}/${token}/decision`;

    if (req.method === "GET" && !m[2]) {
      if (row.status === "superseded") return send(res, 410, messagePage(...GONE.superseded));
      if (row.status === "expired" || (row.status === "pending" && row.expired)) return send(res, 410, messagePage(...GONE.expired));
      return send(res, 200, approvalPage(snapshotOf(row), { status: row.status, answeredBy: row.answered_by_name, answeredAt: row.answered_at, action }));
    }

    if (req.method === "POST" && m[2]) {
      if (fromThisServer(ip)) return send(res, 403, messagePage("Please answer from your own device", "This answer came from the server itself, not from a browser, so it was not recorded. Open the link in your own browser to answer."));
      if (row.status === "superseded") return send(res, 410, messagePage(...GONE.superseded));
      if (row.status === "expired" || (row.status === "pending" && row.expired)) return send(res, 410, messagePage(...GONE.expired));
      if (row.status !== "pending") return send(res, 409, approvalPage(snapshotOf(row), { status: row.status, answeredBy: row.answered_by_name, answeredAt: row.answered_at, action }));
      let body;
      try {
        body = await readForm(req);
      } catch {
        return send(res, 413, messagePage("That is too much text", "Please shorten your comments and try again."));
      }
      const form = parseDecision(body);
      if (!form.ok) return send(res, 422, approvalPage(snapshotOf(row), { status: row.status, error: form.error, values: form.values, action }));
      // Once: only a pending, unexpired link takes an answer. notified_at is cleared so the plugin's job picks it up.
      const done = await pool.query(
        `UPDATE ${SCHEMA}.client_approvals SET status = $2, answered_by_name = $3, answer_note = $4, answered_at = now(), notified_at = NULL
          WHERE token_hash = $1 AND status = 'pending' AND expires_at > now()`,
        [hashToken(token), form.decision, form.name, form.note],
      );
      if (!done.rowCount) return send(res, 409, messagePage("Already answered", "This post has already been answered, or the link has expired. Thank you."));
      return send(
        res,
        200,
        messagePage(
          form.decision === "approved" ? "Thank you, your approval is recorded" : "Thank you, we have your comments",
          form.decision === "approved" ? "We have recorded your approval and will take it from here." : "We will make the changes and send you a new link to check.",
          "ok",
        ),
      );
    }
    return send(res, 405, messagePage("Not allowed", "This address only shows and answers your approval link."));
  } catch (error) {
    console.error("approval error", error instanceof Error ? error.message : error);
    return send(res, 500, messagePage("Something went wrong", "Please try again in a few minutes."));
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`approval service on 127.0.0.1:${PORT}${PREFIX}`));
