'use strict';
// Live service (PAR-14514 S2, S4): a second listener that streams display :99 to a
// person in Cockpit: view only, or with keyboard and mouse under a take-over lease
// (one control stream at a time). Every stream must carry the core server's signed
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
const { parseIdentity } = require('./policy.cjs');
const { ISSUE_RE } = require('./auth.cjs');

const SIGNATURE_HEADER = 'x-paperclip-local-ws-signature';
const MAX_AGE_MS = 30_000;
const MAX_FUTURE_MS = 5_000;
const MAX_VIEWS = 2;
const VIEW_TTL_MS = 20 * 60_000;
const PING_MS = 20_000;
const KILL_GRACE_MS = 2_000;
const MAX_BODY = 16 * 1024;
const MAX_CLEAR = 500;

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

// The take-over command line: the same without `-viewonly`. Paste goes in, nothing is copied out (F30).
function controlArgs(display) {
  return ['-display', display, '-inetd', '-nopw', '-norc', '-q', '-noclipboard', '-noprimary'];
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

function readJson(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { resolve(null); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch (e) { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * opts: { config, apiBase, fetch, logger, agentIdentities, takeover, spawn, now,
 *         viewTtlMs, pingMs, killGraceMs } (the last four for tests).
 * takeover (S4): { lease, waiting, open(identity), release(identity) }. Without it `mode=control` gets 403.
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
  const takeover = opts.takeover || null;
  const lease = takeover?.lease || null;
  const views = new Set();
  const controls = new Set();
  let starting = 0;
  let closing = false;

  // A lease ended (any reason): its control streams close with it.
  if (lease) {
    lease.onEnd((l) => { for (const c of [...controls]) if (c.lease === l) end(c, 'lease_ended'); });
  }

  function waitingList(identity) {
    try { return takeover?.waiting ? takeover.waiting.list(identity) : []; } catch (e) { return []; }
  }

  function status() {
    return {
      viewers: views.size,
      agentSessions: opts.agentIdentities ? opts.agentIdentities() : [],
      lease: lease ? lease.status() : null,
      waiting: waitingList()
    };
  }

  // POST /release {identity} | {all:true[, identity]} (unsigned): see the README, "Take-over".
  async function onRelease(body) {
    if (!takeover) return [404, { ok: false, reason: 'not_available' }];
    const all = body?.all === true;
    let identity = body?.identity;
    if (identity !== undefined && !parseIdentity(identity)) return [400, { ok: false, reason: 'identity_invalid' }];
    const live = lease.current();
    if (all) {
      if (live) lease.end('released');
      for (const v of [...views, ...controls]) end(v, 'released');
      identity = identity ?? live?.identity ?? lease.status()?.identity;
      if (!identity) return [200, { ok: false, reason: 'no_take_over', waiting: [] }];
    } else if (!identity) {
      return [400, { ok: false, reason: 'identity_required' }];
    } else if (live && live.identity !== identity) {
      // Another identity's take-over is live: leave it, and do not open a check window over it.
      return [200, { ok: false, reason: 'take_over_other_identity', waiting: waitingList(identity) }];
    }
    const r = await takeover.release(identity);
    logger(`pib-browser live: released (${r.reason})`);
    return [200, { ok: r.ok === true, reason: r.reason, waiting: waitingList(identity) }];
  }

  // POST /waiting/clear {identity, issues} (unsigned).
  function onWaitingClear(body) {
    if (!takeover?.waiting) return [404, { ok: false, reason: 'not_available' }];
    const issues = body?.issues;
    if (!parseIdentity(body?.identity)) return [400, { ok: false, reason: 'identity_invalid' }];
    if (!Array.isArray(issues) || issues.length > MAX_CLEAR || !issues.every((i) => typeof i === 'string' && ISSUE_RE.test(i))) {
      return [400, { ok: false, reason: 'issues_invalid' }];
    }
    return [200, { ok: true, removed: takeover.waiting.clear(body.identity, issues) }];
  }

  const server = http.createServer((req, res) => {
    const pathname = (req.url || '').split('?')[0];
    if (req.method === 'GET' && pathname === '/status') return sendJson(res, 200, status());
    if (req.method === 'POST' && (pathname === '/release' || pathname === '/waiting/clear')) {
      readJson(req).then(async (body) => {
        if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, reason: 'bad_request' });
        const [code, out] = pathname === '/release' ? await onRelease(body) : onWaitingClear(body);
        sendJson(res, code, out);
      }).catch(() => { try { sendJson(res, 500, { ok: false, reason: 'internal' }); } catch (e) {} });
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
    if (mode === 'control') return onControl(req, socket, head, url, v.userId);
    if (mode !== 'view' || [...url.searchParams.keys()].length !== 1) return reject(socket, 400);
    if (closing) { logger('pib-browser live: stream refused (viewer_limit)'); return reject(socket, 503); }
    // At the cap: end the oldest open view (a Set keeps insertion order) and wait for its x11vnc to exit, so the
    // cap on concurrent x11vnc processes holds. Refuse only when no open view can be ended (all slots still starting).
    while (views.size + starting >= MAX_VIEWS) {
      const oldest = views.values().next().value;
      if (!oldest) { logger('pib-browser live: stream refused (viewer_limit)'); return reject(socket, 429); }
      end(oldest, 'replaced');
      await oldest.killed;
      if (closing) return reject(socket, 503);
    }
    starting++;
    return openStream(req, socket, head, { kind: 'view', args: viewArgs(config.display), set: views, onStarted: () => { starting--; } });
  }

  // GET /stream?mode=control&identity=<id>: starts a lease for the signed person when none exists (and opens
  // the hand-off window), re-attaches the lease's own person on the same identity, refuses anyone else (409).
  async function onControl(req, socket, head, url, userId) {
    if (!takeover) { logger('pib-browser live: stream refused (control_not_available)'); return reject(socket, 403); }
    const identity = url.searchParams.get('identity');
    if (!parseIdentity(identity) || [...url.searchParams.keys()].length !== 2) return reject(socket, 400);
    let l = lease.current();
    if (l && (l.userId !== userId || l.identity !== identity)) { logger('pib-browser live: stream refused (lease_held)'); return reject(socket, 409); }
    // A release's session check is running on the profile: no new take-over until it is done.
    if (!l && lease.busy()) { logger('pib-browser live: stream refused (release_running)'); return reject(socket, 409); }
    const fresh = !l;
    if (fresh) l = lease.start(identity, userId);
    const detach = lease.attach(l);
    if (fresh) {
      let r;
      try { r = await takeover.open(identity); } catch (e) { r = { ok: false }; }
      if (!r?.ok && r?.reason !== 'handoff_already_open') {
        detach();
        lease.end('window_failed', { identity });
        logger('pib-browser live: stream refused (window_failed)');
        return reject(socket, 502);
      }
    }
    if (lease.current() !== l || closing) { detach(); return reject(socket, 409); }
    return openStream(req, socket, head, { kind: 'control', args: controlArgs(config.display), set: controls, lease: l, detach });
  }

  async function openStream(req, socket, head, { kind, args, set, lease: l = null, detach = () => {}, onStarted = () => {} }) {
    let ends;
    try { ends = await handover(config.tmpDir); } catch (e) { onStarted(); detach(); return reject(socket, 502); }
    let child;
    try {
      // Only DISPLAY and XAUTHORITY reach the child, nothing else from the daemon's env.
      child = spawn(config.x11vnc, args, {
        stdio: [ends.childEnd, 'ignore', 'ignore'],
        env: { PATH: '/usr/bin:/bin', ...config.childEnv }
      });
    } catch (e) {
      ends.parentEnd.destroy();
      detach();
      return reject(socket, 502);
    } finally {
      ends.childEnd.destroy();
      onStarted();
    }
    const view = { kind, child, conn: ends.parentEnd, socket, ws: null, timers: [], closed: false, lease: l, detach };
    set.add(view);
    // One control stream at a time: the newest (a reconnect) replaces any other.
    if (kind === 'control') for (const c of [...controls]) if (c !== view) end(c, 'replaced');
    // The lease ended while x11vnc was starting.
    if (l && lease.current() !== l) return end(view, 'lease_ended');
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
      logger(kind === 'control' ? 'pib-browser live: control opened' : `pib-browser live: view opened (viewers ${views.size})`);
    });
  }

  function end(view, reason, code = 1001) {
    if (view.closed) return;
    view.closed = true;
    views.delete(view);
    controls.delete(view);
    view.detach?.();
    for (const t of view.timers) { clearInterval(t); clearTimeout(t); }
    view.killed = killChild(view.child, killGraceMs);
    view.conn.destroy();
    if (view.ws) {
      try { view.ws.close(code); } catch (e) {}
      setTimeout(() => { try { view.ws.terminate(); } catch (e) {} }, 1000).unref();
    } else {
      view.socket.destroy();
    }
    logger(view.kind === 'control' ? `pib-browser live: control closed (${reason})` : `pib-browser live: view closed (${reason}, viewers ${views.size})`);
  }

  // Daemon shutdown: refuse new streams, close every view, wait for the children.
  async function close() {
    closing = true;
    const open = [...views, ...controls];
    for (const view of open) end(view, 'shutdown');
    if (lease) lease.end('shutdown');
    const closed = new Promise((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await Promise.all(open.map((view) => view.killed));
  }

  return { server, close, status, views, controls };
}

module.exports = {
  SIGNATURE_HEADER, MAX_VIEWS, loadLiveConfig, viewArgs, controlArgs, createKeyStore, createVerifier, handover, createLiveService
};
