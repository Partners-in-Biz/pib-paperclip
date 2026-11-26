'use strict';
// Live service (PAR-14514 S2, Verification S2). A fake x11vnc records its
// arguments; a test key pair stands in for the core server's signing key.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const { listen } = require('../src/daemon.cjs');
const { createLiveService, loadLiveConfig, viewArgs, controlArgs, handover, SIGNATURE_HEADER } = require('../src/live.cjs');
const { EXIT } = require('../src/exit-codes.cjs');
const { createDispatcher } = require('../src/dispatch.cjs');
const { createHandoff } = require('../src/handoff.cjs');
const { createLease } = require('../src/lease.cjs');
const { createWaitingList } = require('../src/waiting.cjs');

const PLUGIN_KEY = 'partnersinbiz.cockpit';
const VIEW = '/stream?mode=view';

// The core server's signer (server/src/services/plugin-local-ws.ts), with a test key.
function sign(privateKey, fields) {
  const st = { v: 1, pluginKey: PLUGIN_KEY, userId: 'user-1', ts: Date.now(), nonce: crypto.randomBytes(16).toString('base64url'), ...fields };
  const body = Buffer.from(JSON.stringify(st)).toString('base64url');
  return `${body}.${crypto.sign(null, Buffer.from(body), privateKey).toString('base64url')}`;
}

// The fake writes a JSON record (argv, env, signals) and holds fd 0 open until a
// signal. `ignoreTerm` makes it survive SIGTERM so only SIGKILL ends it.
function writeFakeX11vnc(dir, { ignoreTerm = false } = {}) {
  const bin = path.join(dir, 'x11vnc');
  const log = path.join(dir, 'x11vnc.log');
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs'); const net = require('node:net');
const rec = (o) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, ...o }) + '\\n');
// The handler goes in before the first record, so a test that saw the record can rely on it.
process.on('SIGTERM', () => { rec({ signal: 'SIGTERM' }); ${ignoreTerm ? '' : 'process.exit(0);'} });
rec({ argv: process.argv.slice(2), env: process.env });
const s = new net.Socket({ fd: 0, readable: true, writable: true });
s.on('error', () => {});
s.write('RFB 003.008\\n');
s.on('data', (d) => s.write(d));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  return { bin, records: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

async function waitFor(fn, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return false;
}

function within(promise, ms, what) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timed out: ${what}`)), ms); })]).finally(() => clearTimeout(t));
}

async function setup(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pib-live-test-'));
  const fake = writeFakeX11vnc(dir, opts);
  let served = crypto.generateKeyPairSync('ed25519');
  const fetches = [];
  const fetch = async (url) => {
    fetches.push(url);
    return { ok: true, json: async () => ({ algorithm: 'Ed25519', header: SIGNATURE_HEADER, publicKey: served.publicKey.export({ type: 'spki', format: 'pem' }).toString() }) };
  };
  const config = {
    ...loadLiveConfig({ PIB_BROWSER_LIVE_SOCKET: path.join(dir, 'live.sock'), PIB_BROWSER_X11VNC: fake.bin, DISPLAY: ':99', XAUTHORITY: '/run/test/Xauthority', PIB_BROWSER_API_SECRET_PROBE: 'must-not-reach-child' }),
    tmpDir: dir
  };
  const logs = [];
  const live = createLiveService({
    config, apiBase: 'http://127.0.0.1:3100', fetch, logger: (l) => logs.push(l),
    agentIdentities: () => ['client:ca:example'], killGraceMs: 300, ...opts.live
  });
  await listen(live.server, config.socketPath, 0o660);
  t.after(async () => { await live.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const connect = (reqPath = VIEW, header = sign(served.privateKey, { socket: config.socketPath, path: reqPath })) => new Promise((resolve) => {
    const ws = new WebSocket(`ws+unix://${config.socketPath}:${reqPath}`, header === null ? {} : { headers: { [SIGNATURE_HEADER]: header } });
    const got = [];
    ws.on('message', (d) => got.push(Buffer.from(d).toString()));
    ws.on('open', () => resolve({ ws, got, header }));
    ws.on('unexpected-response', (req, res) => resolve({ status: res.statusCode, header }));
    ws.on('error', () => resolve({ error: true, header }));
  });
  return {
    dir, config, live, logs, fetches, fake, connect,
    key: () => served,
    restartServer: () => { served = crypto.generateKeyPairSync('ed25519'); },
    signWith: (k, fields = {}) => sign(k.privateKey, { socket: config.socketPath, path: VIEW, ...fields })
  };
}

test('view stream: x11vnc gets the view command line, -viewonly, only DISPLAY and XAUTHORITY', async (t) => {
  const s = await setup(t);
  const c = await s.connect();
  assert.ok(c.ws, `stream refused: ${c.status}`);
  assert.ok(await waitFor(() => c.got.join('').includes('RFB 003.008')), 'bytes from x11vnc reach the viewer');
  c.ws.send(Buffer.from('hello'));
  assert.ok(await waitFor(() => c.got.join('').includes('hello')), 'viewer bytes reach x11vnc');
  const [rec] = s.fake.records();
  assert.deepEqual(rec.argv, ['-display', ':99', '-inetd', '-viewonly', '-nopw', '-norc', '-q', '-noclipboard', '-noprimary']);
  assert.deepEqual(rec.argv, viewArgs(':99'));
  assert.equal(rec.env.DISPLAY, ':99');
  assert.equal(rec.env.XAUTHORITY, '/run/test/Xauthority');
  assert.equal(rec.env.PIB_BROWSER_API_SECRET_PROBE, undefined);
  // The hand-over folder is gone once x11vnc runs.
  assert.deepEqual(fs.readdirSync(s.dir).filter((f) => f.startsWith('pib-live-')), []);
  c.ws.close();
});

test('every refusal: unsigned, wrong key, stale, reused nonce, other path, other socket or plugin', async (t) => {
  const s = await setup(t);
  const stranger = crypto.generateKeyPairSync('ed25519');
  assert.equal((await s.connect(VIEW, null)).status, 401, 'unsigned');
  assert.equal((await s.connect(VIEW, 'garbage.value')).status, 401, 'malformed');
  assert.equal((await s.connect(VIEW, s.signWith(stranger))).status, 401, 'wrong key');
  assert.equal((await s.connect(VIEW, s.signWith(s.key(), { ts: Date.now() - 30_000 }))).status, 401, 'stale');
  assert.equal((await s.connect(VIEW, s.signWith(s.key(), { ts: Date.now() + 60_000 }))).status, 401, 'future');
  assert.equal((await s.connect('/stream?mode=view&x=1', s.signWith(s.key()))).status, 401, 'path differs from the signed one');
  assert.equal((await s.connect(VIEW, s.signWith(s.key(), { socket: '/run/pib-browser/sock' }))).status, 401, 'other socket');
  assert.equal((await s.connect(VIEW, s.signWith(s.key(), { pluginKey: 'acme.other' }))).status, 401, 'other plugin');
  const once = s.signWith(s.key());
  const first = await s.connect(VIEW, once);
  assert.ok(first.ws, 'first use accepted');
  assert.equal((await s.connect(VIEW, once)).status, 401, 'reused nonce');
  assert.ok(await waitFor(() => s.fake.records().length > 0));
  first.ws.close();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.fake.records().filter((r) => r.argv).length, 1, 'no x11vnc for any refusal');
});

test('without the take-over service, mode=control is refused, signed or not; unknown mode refused', async (t) => {
  const s = await setup(t);
  const ctl = '/stream?mode=control&identity=client%3Aca%3Aexample';
  assert.equal((await s.connect(ctl, s.signWith(s.key(), { path: ctl }))).status, 403);
  assert.equal((await s.connect(ctl, null)).status, 401);
  const odd = '/stream?mode=edit';
  assert.equal((await s.connect(odd, s.signWith(s.key(), { path: odd }))).status, 400);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.fake.records().length, 0);
});

test('public key is fetched again after a server restart', async (t) => {
  const s = await setup(t);
  const a = await s.connect();
  assert.ok(a.ws);
  assert.equal(s.fetches.length, 1);
  s.restartServer();
  const b = await s.connect(VIEW, s.signWith(s.key()));
  assert.ok(b.ws, `refused after restart: ${b.status}`);
  assert.equal(s.fetches.length, 2);
  assert.equal(s.fetches[1], 'http://127.0.0.1:3100/api/plugins/local-ws-key');
  a.ws.close(); b.ws.close();
});

test('x11vnc is killed when the viewer closes', async (t) => {
  const s = await setup(t);
  const c = await s.connect();
  assert.ok(await waitFor(() => s.fake.records().length > 0));
  const { pid } = s.fake.records()[0];
  c.ws.close();
  assert.ok(await waitFor(() => !alive(pid)), 'x11vnc still running');
  assert.ok(s.fake.records().some((r) => r.signal === 'SIGTERM'));
  assert.equal(s.live.status().viewers, 0);
});

test('SIGKILL follows when x11vnc ignores SIGTERM; shutdown kills every child', async (t) => {
  const s = await setup(t, { ignoreTerm: true });
  const a = await s.connect();
  const b = await s.connect(VIEW, s.signWith(s.key()));
  assert.ok(a.ws && b.ws);
  assert.ok(await waitFor(() => s.fake.records().filter((r) => r.argv).length === 2));
  const pids = s.fake.records().filter((r) => r.argv).map((r) => r.pid);
  const closedA = new Promise((r) => a.ws.on('close', r));
  await within(s.live.close(), 2000, 'shutdown waits for SIGKILL');
  assert.ok(pids.every((p) => !alive(p)), 'a child outlived shutdown');
  await closedA;
  assert.equal(fs.existsSync(s.config.socketPath), false, 'socket removed');
});

test('third viewer refused; a slot frees when a viewer leaves', async (t) => {
  const s = await setup(t);
  const a = await s.connect();
  const b = await s.connect(VIEW, s.signWith(s.key()));
  assert.ok(a.ws && b.ws);
  assert.equal((await s.connect(VIEW, s.signWith(s.key()))).status, 429);
  assert.equal(s.live.status().viewers, 2);
  a.ws.close();
  assert.ok(await waitFor(() => s.live.status().viewers === 1));
  const c = await s.connect(VIEW, s.signWith(s.key()));
  assert.ok(c.ws);
  b.ws.close(); c.ws.close();
});

test('a ping is sent on every stream; the stream closes at its time limit', async (t) => {
  const s = await setup(t, { live: { pingMs: 50, viewTtlMs: 400 } });
  const c = await s.connect();
  await within(new Promise((r) => c.ws.once('ping', r)), 300, 'ping');
  const closed = await new Promise((r) => c.ws.on('close', (code) => r(code)));
  assert.equal(closed, 1000);
  const { pid } = s.fake.records()[0];
  assert.ok(await waitFor(() => !alive(pid)));
});

test('GET /status: viewers and agent sessions, lease and waiting list empty', async (t) => {
  const s = await setup(t);
  const c = await s.connect();
  const body = await new Promise((resolve, reject) => {
    http.get({ socketPath: s.config.socketPath, path: '/status' }, (res) => {
      let d = ''; res.on('data', (x) => { d += x; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d) }));
    }).on('error', reject);
  });
  assert.equal(body.status, 200);
  assert.deepEqual(body.json, { viewers: 1, agentSessions: ['client:ca:example'], sessions: [], lease: null, waiting: [] });
  c.ws.close();
});

test('the log never holds the path, the signed header or stream bytes', async (t) => {
  const s = await setup(t);
  const headers = [];
  const ok = await s.connect(); headers.push(ok.header);
  ok.ws.send(Buffer.from('typed-marker-7731'));
  await waitFor(() => ok.got.join('').includes('typed-marker-7731'));
  const bad = await s.connect(VIEW, s.signWith(crypto.generateKeyPairSync('ed25519'))); headers.push(bad.header);
  const ctl = '/stream?mode=control&identity=x';
  headers.push((await s.connect(ctl, s.signWith(s.key(), { path: ctl }))).header);
  ok.ws.close();
  await waitFor(() => s.logs.some((l) => l.includes('view closed')));
  const log = s.logs.join('\n');
  assert.ok(s.logs.length >= 4, log);
  for (const needle of ['/stream', 'mode=', 'identity=', 'RFB', 'typed-marker-7731', 'user-1', ...headers, ...headers.map((h) => h.split('.')[1])]) {
    assert.ok(!log.includes(needle), `log contains ${needle}`);
  }
});

test('handover: one accept, 0700 folder, deleted afterwards', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pib-live-ho-'));
  const seen = [];
  const orig = fs.mkdtempSync;
  fs.mkdtempSync = (p) => { const d = orig(p); seen.push(fs.statSync(d).mode & 0o777); return d; };
  try {
    const { childEnd, parentEnd } = await handover(dir);
    assert.deepEqual(seen, [0o700]);
    assert.deepEqual(fs.readdirSync(dir), []);
    childEnd.destroy(); parentEnd.destroy();
  } finally {
    fs.mkdtempSync = orig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the live socket is mode 0660 at the configured path; the default path is /run/pib-browser/live.sock', async (t) => {
  const s = await setup(t);
  assert.equal(fs.statSync(s.config.socketPath).mode & 0o777, 0o660);
  assert.equal(loadLiveConfig({}).socketPath, '/run/pib-browser/live.sock');
  assert.equal(loadLiveConfig({}).socketMode, 0o660);
  assert.throws(() => loadLiveConfig({ PIB_BROWSER_LIVE_SOCKET_MODE: '999' }), /PIB_BROWSER_LIVE_SOCKET_MODE/);
});

// ---- Take-over (PAR-14514 S4, Verification S4 daemon tests) ----
// The real lease, dispatcher, hand-off windows and waiting list, with a fake Chromium whose page text the test
// sets ("Sign in" = logged out, "New task" = logged in) and the fake x11vnc above.

const ID = 'pib:paperclip';
const OTHER = 'client:ca:meta';
const DASH = 'https://paperclip.partnersinbiz.online/PAR/dashboard';
const SITES = { sites: {
  paperclip: { label: 'Paperclip', origins: ['https://paperclip.partnersinbiz.online'], loggedIn: { url: DASH, expect: 'New task' }, confirm: [], redact: [], destructive: { selectors: [], text: [] } },
  meta: { label: 'Meta', origins: ['https://business.facebook.com'], loggedIn: { url: 'https://business.facebook.com/latest/home', expect: 'Home' }, confirm: [], redact: [], destructive: { selectors: [], text: [] } }
} };
const POLICY = { version: 1, agents: { a1: { identities: [ID, OTHER] } }, identities: { [OTHER]: { origins: ['https://business.facebook.com'] } } };
const ctlPath = (identity = ID) => `/stream?mode=control&identity=${encodeURIComponent(identity)}`;

function fakeChromium() {
  const state = { text: { [ID]: 'Sign in', [OTHER]: 'Home' }, contexts: [], events: [], closeDelayMs: 0 };
  const closedErr = () => Object.assign(new Error('Target page, context or browser has been closed'), { name: 'TargetClosedError' });
  return {
    state,
    windows: () => state.contexts.filter((c) => c.handoff),
    newContext({ identity }) {
      const ctx = {
        identity, closed: false, url: null,
        goto: async (u) => { ctx.url = u; },
        hasText: async (t) => {
          if (ctx.closed || ctx.gone) throw closedErr();
          return (state.text[identity] || '').includes(t);
        },
        violations: () => [], url: () => ctx.url, describe: async () => ({ type: 'text' }),
        close: async () => {
          if (state.closeDelayMs) await new Promise((r) => setTimeout(r, state.closeDelayMs));
          ctx.closed = true;
          state.events.push(['closed', ctx]);
        }
      };
      state.contexts.push(ctx);
      state.events.push(['new', ctx]);
      return ctx;
    }
  };
}

async function takeoverSetup(t, { maxMs = 60_000, graceMs = 60_000 } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pib-takeover-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const logs = [];
  const errors = [];
  const browser = fakeChromium();
  const build = () => {
    const lease = createLease({ maxMs, graceMs, logger: (l) => logs.push(l) });
    const waiting = createWaitingList({ file: path.join(stateDir, 'waiting.json'), logger: (l) => logs.push(l) });
    const d = createDispatcher({
      authenticate: async () => ({ ok: true, agentId: 'a1', companyId: 'ca' }),
      browser, policy: POLICY, sites: SITES, lease, waiting,
      // No root flag directory: only the lease can make a hand-off active.
      handoff: createHandoff({ dir: path.join(stateDir, 'no-flags'), lease }),
      handoffPollMs: 20,
      errorLog: { record: (e) => errors.push(JSON.stringify(e)) }
    });
    return { lease, waiting, d, takeover: { lease, waiting, open: (id) => d.handoffs.start(id), release: d.release } };
  };
  const first = build();
  const s = await setup(t, { live: { takeover: first.takeover, logger: (l) => logs.push(l) } });
  s.logs = logs;
  const control = (identity = ID, user = 'user-1') => s.connect(ctlPath(identity), s.signWith(s.key(), { path: ctlPath(identity), userId: user }));
  const request = (method, p, body) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: s.config.socketPath, path: p, method, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let d = ''; res.on('data', (x) => { d += x; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d) }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const agent = (identity = ID, issue = 'PAR-1') => first.d.dispatch({ cmd: 'open', token: 't', issue, identity });
  const x11 = () => s.fake.records().filter((r) => r.argv);
  // Lock, window and streams all ended clean.
  const assertClean = async (c) => {
    assert.ok(await waitFor(() => first.lease.status()?.state !== 'live'), 'lease still live');
    assert.ok(await waitFor(() => !first.d.handoffs.isOpen(ID)), 'hand-off window still open');
    assert.ok(browser.windows().every((w) => w.closed), 'a window context was not closed (profile not written)');
    if (c) assert.ok(await waitFor(() => c.ws.readyState === WebSocket.CLOSED), 'control stream still open');
    assert.equal(s.live.controls.size, 0);
    assert.ok(await waitFor(() => x11().every((r) => !alive(r.pid))), 'x11vnc still running');
    const r = await agent(OTHER);
    assert.equal(r.exit, EXIT.DONE, `agent still refused: ${r.reason}`);
  };
  // Mark the hand-off windows (the session check's context is not one).
  const origStart = first.d.handoffs.start;
  first.takeover.open = async (id) => {
    const r = await origStart(id);
    const w = browser.state.contexts.at(-1);
    if (w) w.handoff = true;
    return r;
  };
  return { ...s, ...first, build, browser, control, request, agent, x11, assertClean, errors, stateDir };
}

test('take-over: a signed control stream starts a lease for its person and opens the window; x11vnc without -viewonly', async (t) => {
  const s = await takeoverSetup(t);
  const c = await s.control();
  assert.ok(c.ws, `refused: ${c.status}`);
  assert.ok(await waitFor(() => s.x11().length === 1));
  assert.deepEqual(s.x11()[0].argv, controlArgs(':99'));
  assert.ok(!s.x11()[0].argv.includes('-viewonly'));
  const st = s.lease.status();
  assert.equal(st.state, 'live');
  assert.equal(st.identity, ID);
  assert.equal(st.userId, 'user-1');
  assert.ok(st.secondsLeft > 0 && st.secondsLeft <= 60);
  assert.equal(s.d.handoffs.isOpen(ID), true);
  assert.equal(s.browser.windows()[0].url, DASH);
  const status = await s.request('GET', '/status');
  assert.equal(status.json.lease.state, 'live');
  assert.equal(status.json.lease.identity, ID);
  c.ws.close();
});

test('take-over: the 2 s watch loop keeps the window open while the lease is live (no root flag)', async (t) => {
  const s = await takeoverSetup(t);
  const c = await s.control();
  assert.ok(c.ws);
  await new Promise((r) => setTimeout(r, 300)); // about 15 polls at 20 ms
  assert.equal(s.d.handoffs.isOpen(ID), true);
  assert.equal(s.browser.windows()[0].closed, false);
  c.ws.close();
});

test('take-over: every agent command gets handoff_open, same and other identity, and is put on the waiting list', async (t) => {
  const s = await takeoverSetup(t);
  const c = await s.control();
  assert.ok(c.ws);
  for (const [identity, issue] of [[ID, 'PAR-11'], [OTHER, 'PAR-12']]) {
    const r = await s.agent(identity, issue);
    assert.equal(r.exit, EXIT.NO_BROWSER);
    assert.equal(r.reason, 'handoff_open');
  }
  const r = await s.d.dispatch({ cmd: 'text', token: 't', issue: 'PAR-13', identity: OTHER, args: { selector: 'h1' } });
  assert.equal(r.reason, 'handoff_open');
  const status = await s.request('GET', '/status');
  assert.deepEqual(status.json.waiting.map((w) => [w.identity, w.issue, w.reason]).sort(),
    [[OTHER, 'PAR-12', 'handoff_open'], [OTHER, 'PAR-13', 'handoff_open'], [ID, 'PAR-11', 'handoff_open']].sort());
  c.ws.close();
});

test('take-over: a second person is refused (409); the same person on another identity too', async (t) => {
  const s = await takeoverSetup(t);
  const c = await s.control();
  assert.ok(c.ws);
  assert.equal((await s.control(ID, 'user-2')).status, 409);
  assert.equal((await s.control(OTHER, 'user-1')).status, 409);
  assert.equal(s.lease.status().userId, 'user-1');
  assert.ok(await waitFor(() => s.x11().length === 1));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.x11().length, 1, 'no x11vnc for a refused stream');
  assert.equal(c.ws.readyState, WebSocket.OPEN, 'the holder keeps the screen');
  c.ws.close();
});

test('take-over: the same person re-attaches (reconnect); one control stream at a time', async (t) => {
  const s = await takeoverSetup(t);
  const a = await s.control();
  assert.ok(a.ws);
  const b = await s.control();
  assert.ok(b.ws, `re-attach refused: ${b.status}`);
  assert.ok(await waitFor(() => a.ws.readyState === WebSocket.CLOSED), 'the old stream is replaced');
  assert.equal(s.live.controls.size, 1);
  assert.equal(s.browser.windows().length, 1, 'no second window');
  assert.equal(s.lease.status().state, 'live');
  b.ws.close();
});

test('lease ends: 20-minute limit', async (t) => {
  const s = await takeoverSetup(t, { maxMs: 300 });
  const c = await s.control();
  assert.ok(c.ws);
  await s.assertClean(c);
  assert.equal(s.lease.status().reason, 'time_limit');
  assert.equal(s.lease.status().confirmed, false);
});

test('lease ends: 60 s with no control stream; a reconnect inside the grace keeps it', async (t) => {
  const s = await takeoverSetup(t, { graceMs: 300 });
  const a = await s.control();
  a.ws.close();
  await new Promise((r) => setTimeout(r, 100));
  const b = await s.control();
  assert.ok(b.ws, 'reconnect inside the grace');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(s.lease.status().state, 'live', 'an attached stream keeps the lease');
  b.ws.close();
  await s.assertClean();
  assert.equal(s.lease.status().reason, 'no_control_stream');
});

test('lease ends: login seen; release afterwards answers ok, twice the same', async (t) => {
  const s = await takeoverSetup(t);
  const c = await s.control();
  await s.agent(ID, 'PAR-21');
  s.browser.state.text[ID] = 'New task';
  await s.assertClean(c);
  assert.equal(s.lease.status().reason, 'logged_in');
  assert.equal(s.lease.status().state, 'ended');
  const one = await s.request('POST', '/release', { identity: ID });
  const two = await s.request('POST', '/release', { identity: ID });
  assert.deepEqual(one.json, { ok: true, reason: 'logged_in', waiting: one.json.waiting });
  assert.deepEqual(two.json, one.json);
  assert.deepEqual(one.json.waiting.map((w) => w.issue), ['PAR-21']);
  assert.equal((await s.request('GET', '/status')).json.lease, null, 'confirmed after release');
});

test('lease ends: the person closes the window', async (t) => {
  const s = await takeoverSetup(t);
  const c = await s.control();
  assert.ok(c.ws);
  s.browser.windows()[0].gone = true; // the person closed the window
  await s.assertClean(c);
  assert.equal(s.lease.status().reason, 'window_closed');
});

test('lease ends: release (Done) closes the window first, then checks the session', async (t) => {
  const s = await takeoverSetup(t);
  const c = await s.control();
  // The person logs in; the release comes before the next poll sees it. Writing the profile takes a moment.
  s.browser.state.closeDelayMs = 50;
  s.browser.state.text[ID] = 'New task';
  const r = await s.request('POST', '/release', { identity: ID });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.reason, 'logged_in');
  const [win, check] = [s.browser.windows()[0], s.browser.state.contexts.at(-1)];
  assert.notEqual(win, check, 'the check uses its own context');
  assert.equal(win.closed, true);
  assert.equal(check.closed, true);
  const at = (kind, ctx) => s.browser.state.events.findIndex(([k, c]) => k === kind && c === ctx);
  assert.ok(at('closed', win) < at('new', check), 'the window\'s profile is closed before the check opens it');
  await s.assertClean(c);
});

test('lease ends: Stop (release while still logged out) answers session_expired, safe twice', async (t) => {
  const s = await takeoverSetup(t);
  const c = await s.control();
  await s.agent(OTHER, 'PAR-31');
  const one = await s.request('POST', '/release', { identity: ID });
  assert.equal(one.json.ok, false);
  assert.equal(one.json.reason, 'session_expired');
  await s.assertClean(c);
  const two = await s.request('POST', '/release', { identity: ID });
  assert.deepEqual(two.json, one.json);
});

test('lease ends: release {all:true} also closes every view stream', async (t) => {
  const s = await takeoverSetup(t);
  const v = await s.connect();
  const c = await s.control();
  assert.ok(v.ws && c.ws);
  const r = await s.request('POST', '/release', { all: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.reason, 'session_expired');
  assert.ok(await waitFor(() => v.ws.readyState === WebSocket.CLOSED), 'view stream still open');
  assert.equal(s.live.views.size, 0);
  await s.assertClean(c);
  // Nothing live and nothing pending: still a clean answer.
  const again = await s.request('POST', '/release', { all: true });
  assert.deepEqual(again.json, { ok: false, reason: 'no_take_over', waiting: [] });
});

test('lease ends: daemon restart (lease gone, window and streams closed, agents unblocked, waiting list kept)', async (t) => {
  const s = await takeoverSetup(t);
  const c = await s.control();
  await s.agent(ID, 'PAR-41');
  await s.live.close();
  assert.ok(await waitFor(() => c.ws.readyState === WebSocket.CLOSED));
  assert.ok(await waitFor(() => s.x11().every((r) => !alive(r.pid))));
  assert.ok(await waitFor(() => s.browser.windows().every((w) => w.closed)));
  // The new process: nothing of the lease survives; the waiting list does.
  const next = s.build();
  assert.equal(next.lease.status(), null);
  assert.equal(next.d.handoffs.isOpen(ID), false);
  s.browser.state.text[ID] = 'New task';
  assert.equal((await next.d.dispatch({ cmd: 'open', token: 't', issue: 'PAR-42', identity: ID })).exit, EXIT.DONE);
  assert.deepEqual(next.waiting.list(ID).map((w) => w.issue), ['PAR-41']);
});

test('release refuses bad input; a live take-over on another identity is left alone', async (t) => {
  const s = await takeoverSetup(t);
  assert.equal((await s.request('POST', '/release', {})).status, 400);
  assert.equal((await s.request('POST', '/release', { identity: '../x' })).status, 400);
  const c = await s.control();
  const r = await s.request('POST', '/release', { identity: OTHER });
  assert.equal(r.json.reason, 'take_over_other_identity');
  assert.equal(s.lease.status().state, 'live');
  assert.equal(c.ws.readyState, WebSocket.OPEN);
  c.ws.close();
});

test('POST /waiting/clear removes the named entries only', async (t) => {
  const s = await takeoverSetup(t);
  const c = await s.control();
  await s.agent(ID, 'PAR-51');
  await s.agent(ID, 'PAR-52');
  await s.agent(OTHER, 'PAR-51');
  const r = await s.request('POST', '/waiting/clear', { identity: ID, issues: ['PAR-51'] });
  assert.deepEqual(r.json, { ok: true, removed: 1 });
  const left = (await s.request('GET', '/status')).json.waiting.map((w) => `${w.identity} ${w.issue}`).sort();
  assert.deepEqual(left, [`${OTHER} PAR-51`, `${ID} PAR-52`].sort());
  assert.equal((await s.request('POST', '/waiting/clear', { identity: ID, issues: ['not an issue'] })).status, 400);
  assert.equal((await s.request('POST', '/waiting/clear', { identity: 'x', issues: [] })).status, 400);
  c.ws.close();
});

test('a marker typed over a control stream appears in no daemon log', async (t) => {
  const s = await takeoverSetup(t);
  const c = await s.control();
  const marker = 'typed-takeover-marker-5512';
  c.ws.send(Buffer.from(marker));
  assert.ok(await waitFor(() => c.got.join('').includes(marker)), 'bytes reach x11vnc');
  await s.request('POST', '/release', { identity: ID });
  await waitFor(() => s.logs.some((l) => l.includes('control closed')));
  const log = [...s.logs, ...s.errors].join('\n');
  assert.ok(s.logs.some((l) => l.includes('take-over started')), log);
  for (const needle of [marker, '/stream', 'identity=', 'user-1', c.header, c.header.split('.')[1]]) {
    assert.ok(!log.includes(needle), `log contains ${needle}`);
  }
});
