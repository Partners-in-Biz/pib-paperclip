'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { probeAll, validateStatus } = require('../src/probe.cjs');

test('validateStatus accepts valid fixture', async () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/browser-status.json'), 'utf8'));
  assert.ok(validateStatus(fixture));
});

test('validateStatus rejects missing checkedAt', async () => {
  assert.ok(!validateStatus({ identities: {} }));
});

test('validateStatus rejects non-string checkedAt', async () => {
  assert.ok(!validateStatus({ checkedAt: 123, identities: {} }));
});

test('validateStatus rejects missing identities', async () => {
  assert.ok(!validateStatus({ checkedAt: new Date().toISOString() }));
});

test('validateStatus rejects non-object identities', async () => {
  assert.ok(!validateStatus({ checkedAt: new Date().toISOString(), identities: [] }));
});

test('validateStatus rejects identity without ok', async () => {
  assert.ok(!validateStatus({ checkedAt: new Date().toISOString(), identities: { 'pib:meta': { reason: '' } } }));
});

test('validateStatus rejects identity without reason', async () => {
  assert.ok(!validateStatus({ checkedAt: new Date().toISOString(), identities: { 'pib:meta': { ok: true } } }));
});

test('validateStatus rejects non-boolean ok', async () => {
  assert.ok(!validateStatus({ checkedAt: new Date().toISOString(), identities: { 'pib:meta': { ok: 'yes', reason: '' } } }));
});

test('validateStatus rejects non-string reason', async () => {
  assert.ok(!validateStatus({ checkedAt: new Date().toISOString(), identities: { 'pib:meta': { ok: true, reason: 123 } } }));
});

test('probeAll writes file matching fixture schema', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-test-'));
  const outPath = path.join(tmpDir, 'status.json');

  const identities = ['pib:meta', 'client:ca:google-ads'];
  const check = async (id) => {
    if (id === 'pib:meta') return { exit: 0, reason: '' };
    return { exit: 6, reason: 'session_expired' };
  };

  const result = await probeAll({ identities, check, outPath });
  assert.equal(result.exit, 0);
  assert.ok(fs.existsSync(outPath));

  const content = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.ok(validateStatus(content));
  assert.ok(content.identities['pib:meta'].ok);
  assert.ok(!content.identities['client:ca:google-ads'].ok);
  assert.equal(content.identities['client:ca:google-ads'].reason, 'session_expired');

  fs.rmSync(tmpDir, { recursive: true });
});

test('probeAll returns error if no identities', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-test-'));
  const outPath = path.join(tmpDir, 'status.json');

  const result = await probeAll({ identities: [], check: async () => ({}), outPath });
  assert.equal(result.exit, 4);
  assert.ok(!fs.existsSync(outPath));

  fs.rmSync(tmpDir, { recursive: true });
});

test('probeAll handles check errors as no_browser', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-test-'));
  const outPath = path.join(tmpDir, 'status.json');

  const identities = ['pib:meta'];
  const check = async () => {
    throw new Error('connection failed');
  };

  const result = await probeAll({ identities, check, outPath });
  assert.equal(result.exit, 0);

  const content = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.ok(validateStatus(content));

  fs.rmSync(tmpDir, { recursive: true });
});

test('probeAll performs atomic write with tmp file', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-test-'));
  const outPath = path.join(tmpDir, 'status.json');

  const identities = ['pib:meta'];
  const check = async () => ({ exit: 0, reason: '' });

  const result = await probeAll({ identities, check, outPath });
  assert.equal(result.exit, 0);

  // Check that no .tmp- files exist
  const files = fs.readdirSync(tmpDir);
  assert.ok(!files.some(f => f.includes('.tmp-')));

  fs.rmSync(tmpDir, { recursive: true });
});

test('probeAll replaces existing file', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-test-'));
  const outPath = path.join(tmpDir, 'status.json');

  // Write initial file
  const oldContent = { old: 'data' };
  fs.writeFileSync(outPath, JSON.stringify(oldContent));

  const identities = ['pib:meta'];
  const check = async () => ({ exit: 0, reason: '' });

  const result = await probeAll({ identities, check, outPath });
  assert.equal(result.exit, 0);

  const content = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.ok(validateStatus(content));
  assert.ok(!content.old);

  fs.rmSync(tmpDir, { recursive: true });
});

test('probeAll handles mkdir failure gracefully', async () => {
  const mockFs = {
    mkdirSync: () => { throw new Error('permission denied'); },
    writeFileSync: () => {},
    renameSync: () => {},
    unlinkSync: () => {},
    existsSync: () => false
  };

  const result = await probeAll({
    identities: ['pib:meta'],
    check: async () => ({ exit: 0, reason: '' }),
    outPath: '/invalid/path/status.json',
    fs: mockFs
  });

  assert.equal(result.exit, 5);
  assert.equal(result.reason, 'write_failed');
});

test('probeAll redacts secrets from reasons', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-test-'));
  const outPath = path.join(tmpDir, 'status.json');

  const identities = ['pib:meta'];
  const check = async () => ({
    exit: 7,
    reason: 'authorization: Bearer secret_token_123456'
  });

  const result = await probeAll({ identities, check, outPath });
  assert.equal(result.exit, 0);

  const content = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.ok(!content.identities['pib:meta'].reason.includes('secret'));
  assert.ok(!content.identities['pib:meta'].reason.includes('Bearer'));

  fs.rmSync(tmpDir, { recursive: true });
});
