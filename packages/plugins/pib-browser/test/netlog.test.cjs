'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseViewport, redactUrl, createNetLog } = require('../src/netlog.cjs');
const { createDispatcher } = require('../src/dispatch.cjs');
const { createFakeBrowser } = require('./fake-browser.cjs');
const { run } = require('../src/cli.cjs');
const { EXIT } = require('../src/exit-codes.cjs');

test('parseViewport accepts bounds and rejects the rest', () => {
  assert.deepEqual(parseViewport('390x844'), { width: 390, height: 844 });
  assert.deepEqual(parseViewport('320x320'), { width: 320, height: 320 });
  assert.deepEqual(parseViewport('3840x2160'), { width: 3840, height: 2160 });
  for (const bad of ['319x844', '390x319', '3841x900', '900x2161', '390X844', '390x', 'x844', '-390x844', '390x844x1', '0x0', '', null, undefined, 390]) {
    assert.equal(parseViewport(bad), null, String(bad));
  }
});

test('redactUrl hides query values, fragment, credentials and token-like paths', () => {
  const out = redactUrl('https://user:pw@files.example.com/a/b.png?X-Sig=abc123&token=s3cret&x=1#access_token=zzz');
  assert.equal(out, 'https://files.example.com/a/b.png?X-Sig=[redacted]&token=[redacted]&x=[redacted]');
  for (const leak of ['user', 'pw', 'abc123', 's3cret', 'zzz']) assert.ok(!out.includes(leak), leak);
  const jwt = 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4';
  assert.ok(!redactUrl(`https://h.test/x/${jwt}/y`).includes('eyJ'));
  assert.ok(!redactUrl('https://h.test/' + 'a1'.repeat(20)).includes('a1a1a1'));
  assert.equal(redactUrl('https://h.test/plain/path'), 'https://h.test/plain/path');
  assert.equal(redactUrl('not a url'), '[unparseable]');
  assert.ok(!redactUrl('data:text/plain;base64,SECRET').includes('SECRET'));
});

test('redactUrl is idempotent', () => {
  const once = redactUrl('https://h.test/p?sig=abc');
  assert.equal(redactUrl(once), once);
});

test('net log keeps only time, method, url, status and is bounded', () => {
  const log = createNetLog({ max: 3, now: () => new Date('2026-01-01T00:00:00Z') });
  for (let i = 0; i < 5; i++) log.add({ url: `https://h.test/${i}?sig=k${i}`, method: 'post', status: 200, headers: { cookie: 'c' }, body: 'b' });
  const e = log.entries();
  assert.equal(e.length, 3);
  assert.deepEqual(Object.keys(e[0]).sort(), ['method', 'status', 'time', 'url']);
  assert.equal(e[0].method, 'POST');
  assert.ok(!JSON.stringify(e).includes('k3'));
});

const mk = () => {
  const browser = createFakeBrowser({ 'https://business.facebook.com/latest/home': { text: 'Home' } });
  const { dispatch } = createDispatcher({
    authenticate: async () => ({ ok: true, agentId: 'a1', companyId: 'ca', issue: { id: 'i1', identifier: 'PAR-1234', companyId: 'ca' } }),
    browser,
    policy: { version: 1, agents: { a1: { identities: ['client:ca:meta'] } }, identities: { 'client:ca:meta': { origins: ['https://business.facebook.com'] } } },
    sites: { sites: { meta: { label: 'Meta', origins: ['https://business.facebook.com'], loggedIn: { url: 'https://business.facebook.com/latest/home', expect: 'Home' }, confirm: [], redact: [], destructive: { selectors: ['[data-action=delete]'], text: ['delete'] } } } },
    checkFill: () => ({ ok: true })
  });
  const call = (cmd, args) => dispatch({ cmd, token: 't', issue: 'PAR-1234', identity: 'client:ca:meta', args });
  return { browser, call };
};

test('dispatch: viewport validated on open and goto, applied', async () => {
  const { browser, call } = mk();
  assert.equal((await call('open', { viewport: '99x99' })).reason, 'viewport_invalid');
  assert.equal((await call('open', { viewport: '390x844' })).exit, EXIT.DONE);
  assert.deepEqual(browser.lastContext().openViewport(), { width: 390, height: 844 });
  assert.equal((await call('goto', { url: 'https://business.facebook.com/latest/home', viewport: '5000x5000' })).reason, 'viewport_invalid');
  assert.equal((await call('goto', { url: 'https://business.facebook.com/latest/home', viewport: '800x600' })).exit, EXIT.DONE);
  assert.ok(browser.lastContext().performed().some((p) => p.cmd === 'viewport' && p.vp.width === 800));
});

test('dispatch: net returns redacted entries, needs a session', async () => {
  const { call } = mk();
  assert.equal((await call('net', {})).reason, 'no_session');
  await call('open', {});
  const r = await call('net', {});
  assert.equal(r.exit, EXIT.DONE);
  assert.equal(r.data.entries[0].url, 'https://x.test/a?sig=[redacted]');
  assert.ok(!JSON.stringify(r).includes('SECRETSIG'));
});

test('dispatch: drag needs both ends, is gated like click', async () => {
  const { browser, call } = mk();
  await call('open', {});
  assert.equal((await call('drag', { from: '#a' })).reason, 'from_and_to_required');
  assert.equal((await call('drag', { from: '#a', to: '[data-action=delete]' })).exit, EXIT.NEEDS_APPROVAL);
  assert.equal((await call('drag', { from: '#a', to: '#b' })).exit, EXIT.DONE);
  assert.deepEqual(browser.lastContext().performed().filter((p) => p.cmd === 'drag'), [{ cmd: 'drag', from: '#a', to: '#b' }]);
});

test('cli: viewport, drag args and net evidence file', async () => {
  const sent = [];
  const out = { w: '', write(d) { this.w += d; } };
  const err = { w: '', write(d) { this.w += d; } };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pibnet-'));
  const env = { PAPERCLIP_API_KEY: 't', PIB_EVIDENCE_ROOT: root };
  const base = ['--identity', 'client:ca:meta', '--issue', 'PAR-1234'];
  const send = async (req) => { sent.push(req); return req.cmd === 'net'
    ? { exit: 0, ok: true, data: { entries: [{ time: 'T', method: 'GET', status: 200, url: 'https://h.test/p?sig=[redacted]' }] } }
    : { exit: 0, ok: true }; };
  const deps = { send, stdout: out, stderr: err };
  assert.equal(await run(['open', ...base, '--viewport', '390x844'], env, deps), 0);
  assert.equal(sent[0].args.viewport, '390x844');
  assert.equal(await run(['open', ...base, '--viewport', '10x10'], env, deps), 2);
  assert.equal(await run(['click', ...base, '--selector', '#a', '--viewport', '390x844'], env, deps), 2);
  assert.equal(await run(['drag', ...base, '--from', '#a'], env, deps), 2);
  assert.equal(await run(['drag', ...base, '--from', '#a', '--to', '#b', '--approval', 'PAR-9'], env, deps), 0);
  assert.deepEqual(sent.at(-1).args, { from: '#a', to: '#b', approval: 'PAR-9' });
  assert.equal(await run(['net', ...base, '--step', 'first'], env, deps), 0);
  const dir = path.join(root, 'PAR-1234');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^PAR-1234-first-.*\.json$/);
  assert.ok(out.w.includes('GET 200 https://h.test/p?sig=[redacted]'));
  fs.rmSync(root, { recursive: true, force: true });
});
