'use strict';
// Live service (PAR-14514 S2): a second listener that streams display :99 to a
// person in Cockpit, view only. Every stream must carry the core server's signed
// header (doc/plugins/PLUGIN_SPEC.md, "x-paperclip-local-ws-signature"): any
// local process can open this socket, only the server process can sign.
// Never logged: stream bytes, the request path, the signed header.
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { WebSocketServer, createWebSocketStream } = require('ws');

const SIGNATURE_HEADER = 'x-paperclip-local-ws-signature';
const MAX_AGE_MS = 30_000;
const MAX_FUTURE_MS = 5_000;
const MAX_VIEWS = 2;
const VIEW_TTL_MS = 20 * 60_000;
const PING_MS = 20_000;
const KILL_GRACE_MS = 2_000;

function parseMode(value, name) {
  if (!/^(0o)?[0-7]{3,4}$/i.test(value)) throw new Error(`${name} must be a valid octal string (e.g., 660)`);
  return parseInt(value.replace(/^0o/i, ''), 8);
}

function loadLiveConfig(env = process.env) {
  return {
    socketPath: env.PIB_BROWSER_LIVE_SOCKET || '/run/pib-browser/live.sock',
    socketMode: env.PIB_BROWSER_LIVE_SOCKET_MODE ? parseMode(env.PIB_BROWSER_LIVE_SOCKET_MODE, 'PIB_BROWSER_LIVE_SOCKET_MODE') : 0o660,
    pluginKey: env.PIB_BROWSER_LIVE_PLUGIN_KEY || 'partnersinbiz.cockpit',
    x11vnc: env.PIB_BROWSER_X11VNC || '/usr/bin/x11vnc',
    display: ':99',
    tmpDir: os.tmpdir(),
    childEnv: Object.fromEntries(['DISPLAY', 'XAUTHORITY'].filter((k) => env[k]).map((k) => [k, env[k]]))
  };
}

// The view command line. `-viewonly` is part of the constant: no caller can drop it.
function viewArgs(display) {
  return ['-display', display, '-inetd', '-viewonly', '-nopw', '-norc', '-q', '-noclipboard', '-noprimary'];
}

// The server's public key, from the address already trusted for agent checks.
// Fetched once at first use and once more whenever a signature does not verify
// (a server restart makes a new key). Concurrent fetches share one request.
function createKeyStore({ apiBase, fetch }) {
  let key = null;
  let inflight = null;
  function load() {
    if (inflight) return inflight;
    const p = (async () => {
      try {
        const res = await fetch(`${apiBase}/api/plugins/local-ws-key`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return key;
        const body = await res.json();
        if (body?.algorithm !== 'Ed25519' || typeof body.publicKey !== 'string') return key;
        const k = crypto.createPublicKey(body.publicKey);
        if (k.asymmetricKeyType !== 'ed25519') return key;
        key = k;
      } catch (e) { /* keep the old key; the stream is refused */ }
      return key;
    })();
    inflight = p;
    p.finally(() => { if (inflight === p) inflight = null; });
    return p;
  }
  return { load, current: () => key };
}

function createVerifier({ config, keys, now = () => Date.now() }) {
  const seen = new Map(); // nonce -> forget after
  const check = (k, body, sig) => {
    try { return !!k && crypto.verify(null, Buffer.from(body), k, sig); } catch (e) { return false; }
  };
  return async function verify(req) {
    const value = req.headers[SIGNATURE_HEADER];
    if (typeof value !== 'string') return { ok: false, reason: 'unsigned' };
    const m = /^([A-Za-z0-9_-]{1,2048})\.([A-Za-z0-9_-]{86})$/.exec(value);
    if (!m) return { ok: false, reason: 'bad_signature' };
    const [, body, sigText] = m;
    const sig = Buffer.from(sigText, 'base64url');
    if (!check(keys.current() || await keys.load(), body, sig) && !check(await keys.load(), body, sig)) {
      return { ok: false, reason: 'bad_signature' };
    }
    let st;
    try { st = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (e) { return { ok: false, reason: 'bad_statement' }; }
    if (!st || st.v !== 1 || typeof st.userId !== 'string' || !st.userId) return { ok: false, reason: 'bad_statement' };
    if (st.pluginKey !== config.pluginKey || st.socket !== config.socketPath) return { ok: false, reason: 'wrong_target' };
    if (st.path !== req.url) return { ok: false, reason: 'wrong_path' };
    const t = now();
    if (!Number.isFinite(st.ts) || t - st.ts >= MAX_AGE_MS || st.ts - t > MAX_FUTURE_MS) return { ok: false, reason: 'stale' };
    for (const [n, until] of seen) if (until <= t) seen.delete(n);
    if (typeof st.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(st.nonce) || seen.has(st.nonce)) {
      return { ok: false, reason: 'replayed' };
    }
    seen.set(st.nonce, t + MAX_AGE_MS + MAX_FUTURE_MS);
    return { ok: true, userId: st.userId };
  };
}

// One connection from a private listener: a fresh 0700 folder in the private
// temp folder, closed after exactly one accept, deleted before we return.
async function handover(tmpDir) {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'pib-live-'));
  const sockPath = path.join(dir, 'h.sock');
  const listener = net.createServer();
  listener.maxConnections = 1;
  try {
    return await new Promise((resolve, reject) => {
      let childEnd = null;
      let parentEnd = null;
      const done = () => { if (childEnd && parentEnd) resolve({ childEnd, parentEnd }); };
      listener.on('error', reject);
      listener.on('connection', (s) => {
        if (childEnd) { s.destroy(); return; }
        childEnd = s;
        listener.close();
        done();
      });
      listener.listen(sockPath, () => {
        try { fs.chmodSync(sockPath, 0o600); } catch (e) {}
        const c = net.connect(sockPath);
        c.on('error', reject);
        c.on('connect', () => { parentEnd = c; done(); });
      });
    });
  } finally {
    listener.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
}

function killChild(child, graceMs) {
  return new Promise((resolve) => {
    // No pid: the spawn failed and there is nothing to wait for.
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return resolve();
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, graceMs);
    child.once('exit', () => { clearTimeout(t); resolve(); });
    try { child.kill('SIGTERM'); } catch (e) {}
  });
}

function reject(socket, status) {
  try {
    socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
    setTimeout(() => socket.destroy(), 1000).unref();
  } catch (e) {
    socket.destroy();
  }
}

/**
 * opts: { config, apiBase, fetch, logger, agentIdentities, spawn, now,
 *         viewTtlMs, pingMs, killGraceMs } (the last four for tests).
 */
function createLiveService(opts) {
  const { config } = opts;
  const logger = opts.logger || ((line) => console.log(line));
  const spawn = opts.spawn || childProcess.spawn;
  const viewTtlMs = opts.viewTtlMs ?? VIEW_TTL_MS;
  const pingMs = opts.pingMs ?? PING_MS;
  const killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS;
  const keys = createKeyStore({ apiBase: opts.apiBase, fetch: opts.fetch || globalThis.fetch });
  const verify = createVerifier({ config, keys, now: opts.now });
  const wss = new WebSocketServer({ noServer: true, clientTracking: false, perMessageDeflate: false, maxPayload: 1 << 20 });
  const views = new Set();
  let starting = 0;
  let closing = false;

  function status() {
    return {
      viewers: views.size,
      agentSessions: opts.agentIdentities ? opts.agentIdentities() : [],
      lease: null,
      waiting: []
    };
  }

  const server = http.createServer((req, res) => {
    const pathname = (req.url || '').split('?')[0];
    if (req.method === 'GET' && pathname === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(status()));
      return;
    }
    res.writeHead(pathname === '/stream' ? 426 : 404, { 'Content-Length': 0, Connection: 'close' });
    res.end();
  });
  server.on('clientError', (err, socket) => socket.destroy());
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    onUpgrade(req, socket, head).catch(() => reject(socket, 500));
  });

  async function onUpgrade(req, socket, head) {
    if (closing) return reject(socket, 503);
    let url;
    try { url = new URL(req.url, 'http://live'); } catch (e) { return reject(socket, 400); }
    if (req.method !== 'GET' || url.pathname !== '/stream') return reject(socket, 404);
    const v = await verify(req);
    if (!v.ok) { logger(`pib-browser live: stream refused (${v.reason})`); return reject(socket, 401); }
    const mode = url.searchParams.get('mode');
    if (mode === 'control') { logger('pib-browser live: stream refused (control_not_available)'); return reject(socket, 403); }
    if (mode !== 'view' || [...url.searchParams.keys()].length !== 1) return reject(socket, 400);
    if (closing || views.size + starting >= MAX_VIEWS) { logger('pib-browser live: stream refused (viewer_limit)'); return reject(socket, 429); }
    starting++;
    let ends;
    try { ends = await handover(config.tmpDir); } catch (e) { starting--; return reject(socket, 502); }
    let child;
    try {
      // Only DISPLAY and XAUTHORITY reach the child, nothing else from the daemon's env.
      child = spawn(config.x11vnc, viewArgs(config.display), {
        stdio: [ends.childEnd, 'ignore', 'ignore'],
        env: { PATH: '/usr/bin:/bin', ...config.childEnv }
      });
    } catch (e) {
      ends.parentEnd.destroy();
      return reject(socket, 502);
    } finally {
      ends.childEnd.destroy();
      starting--;
    }
    const view = { child, conn: ends.parentEnd, socket, ws: null, timers: [], closed: false };
    views.add(view);
    child.once('error', () => end(view, 'spawn_failed'));
    child.once('exit', () => end(view, 'vnc_exit'));
    view.conn.on('error', () => end(view, 'vnc_error'));
    view.conn.on('close', () => end(view, 'vnc_closed'));
    // A refused handshake (bad WebSocket headers) closes the socket without calling back.
    socket.once('close', () => end(view, 'viewer_closed'));
    if (view.closed || socket.destroyed) return end(view, 'viewer_closed');
    wss.handleUpgrade(req, socket, head, (ws) => {
      view.ws = ws;
      if (view.closed) { ws.terminate(); return; }
      const duplex = createWebSocketStream(ws);
      duplex.on('error', () => end(view, 'stream_error'));
      ws.on('close', () => end(view, 'viewer_closed'));
      view.conn.pipe(duplex).pipe(view.conn);
      view.timers.push(setInterval(() => { try { ws.ping(); } catch (e) {} }, pingMs));
      view.timers.push(setTimeout(() => end(view, 'time_limit', 1000), viewTtlMs));
      logger(`pib-browser live: view opened (viewers ${views.size})`);
    });
  }

  function end(view, reason, code = 1001) {
    if (view.closed) return;
    view.closed = true;
    views.delete(view);
    for (const t of view.timers) { clearInterval(t); clearTimeout(t); }
    view.killed = killChild(view.child, killGraceMs);
    view.conn.destroy();
    if (view.ws) {
      try { view.ws.close(code); } catch (e) {}
      setTimeout(() => { try { view.ws.terminate(); } catch (e) {} }, 1000).unref();
    } else {
      view.socket.destroy();
    }
    logger(`pib-browser live: view closed (${reason}, viewers ${views.size})`);
  }

  // Daemon shutdown: refuse new streams, close every view, wait for the children.
  async function close() {
    closing = true;
    const open = [...views];
    for (const view of open) end(view, 'shutdown');
    const closed = new Promise((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await Promise.all(open.map((view) => view.killed));
  }

  return { server, close, status, views };
}

module.exports = {
  SIGNATURE_HEADER, MAX_VIEWS, loadLiveConfig, viewArgs, createKeyStore, createVerifier, handover, createLiveService
};
