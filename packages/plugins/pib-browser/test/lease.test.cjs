'use strict';
// Lease and waiting list units (PAR-14514 S4).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLease, MAX_MS, GRACE_MS } = require('../src/lease.cjs');
const { createWaitingList, KEEP_MS } = require('../src/waiting.cjs');

test('limits: 20 minutes, 60 s grace, 7 days', () => {
  assert.equal(MAX_MS, 20 * 60_000);
  assert.equal(GRACE_MS, 60_000);
  assert.equal(KEEP_MS, 7 * 24 * 3600_000);
});

test('one lease at a time; ending runs listeners once; ended stays "not confirmed" until confirm', () => {
  const lease = createLease();
  const ends = [];
  lease.onEnd((l, reason) => ends.push([l.identity, reason]));
  const l = lease.start('pib:a', 'u1');
  assert.ok(l);
  assert.equal(lease.start('pib:b', 'u2'), null);
  assert.equal(lease.end('x', { identity: 'pib:b' }), false, 'another identity is not ended');
  assert.equal(lease.end('released'), true);
  assert.equal(lease.end('released'), false);
  assert.deepEqual(ends, [['pib:a', 'released']]);
  assert.deepEqual({ ...lease.status(), endedAt: 0 }, { state: 'ended', confirmed: false, identity: 'pib:a', userId: 'u1', reason: 'released', endedAt: 0 });
  lease.confirm('pib:a');
  assert.equal(lease.status(), null);
});

test('grace: detach starts the 60 s clock, attach stops it; an old stream never touches a new lease', async () => {
  const lease = createLease({ graceMs: 80 });
  const a = lease.start('pib:a', 'u1');
  const detach = lease.attach(a);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(lease.status().state, 'live');
  assert.equal(lease.status().controlConnected, true);
  detach(); detach();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(lease.status().reason, 'no_control_stream');
  const b = lease.start('pib:a', 'u1');
  const d2 = lease.attach(b);
  detach();
  lease.attach(a)();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(lease.status().state, 'live');
  d2();
  lease.end('released');
});

test('waiting list: one entry per identity and issue, 7 days, file mode 0600, unreadable file is empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pib-wait-'));
  try {
    const file = path.join(dir, 'waiting.json');
    let t = Date.parse('2026-11-25T10:00:00Z');
    const w = createWaitingList({ file, now: () => t });
    assert.deepEqual(w.list(), []);
    w.record('pib:a', 'PAR-1', 'session_expired');
    t += 1000;
    w.record('pib:a', 'PAR-1', 'handoff_open');
    w.record('pib:b', 'PAR-1', 'handoff_open');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(w.list('pib:a').map((e) => [e.issue, e.reason]), [['PAR-1', 'handoff_open']]);
    assert.equal(w.list().length, 2);
    t += KEEP_MS - 1;
    assert.equal(w.list().length, 2, 'just under 7 days old');
    t += 1;
    assert.equal(w.list().length, 0, 'older than 7 days');
    fs.writeFileSync(file, '{not json');
    assert.deepEqual(w.list(), []);
    w.record('pib:a', 'PAR-2', 'session_expired');
    assert.equal(w.clear('pib:a', ['PAR-2', 'PAR-9']), 1);
    assert.deepEqual(w.list(), []);
    const logs = [];
    const broken = createWaitingList({ file: path.join(dir, 'missing', 'w.json'), logger: (l) => logs.push(l) });
    broken.record('pib:a', 'PAR-1', 'session_expired');
    assert.deepEqual(logs, ['pib-browser: waiting list not written: ENOENT']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
