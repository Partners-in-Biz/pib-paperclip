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
const { createLiveService, loadLiveConfig, viewArgs, handover, SIGNATURE_HEADER } = require('../src/live.cjs');

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
rec({ argv: process.argv.slice(2), env: process.env });
const s = new net.Socket({ fd: 0, readable: true, writable: true });
s.on('error', () => {});
s.write('RFB 003.008\\n');
s.on('data', (d) => s.write(d));
process.on('SIGTERM', () => { rec({ signal: 'SIGTERM' }); ${ignoreTerm ? '' : 'process.exit(0);'} });
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

test('mode=control is refused, signed or not; unknown mode refused', async (t) => {
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
  await s.live.close();
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
  const pinged = new Promise((r) => c.ws.once('ping', r));
  await pinged;
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
  assert.deepEqual(body.json, { viewers: 1, agentSessions: ['client:ca:example'], lease: null, waiting: [] });
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
