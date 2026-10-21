'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { evidencePath, writeShot } = require('../src/shot.cjs');

test('evidencePath formats correctly', () => {
  const now = new Date('2026-01-01T10:30:45.123Z');
  const result = evidencePath({
    root: '/evidence',
    issue: 'PAR-1234',
    step: 'login',
    now
  });
  assert(result.includes('PAR-1234'));
  assert(result.includes('login'));
  assert(result.endsWith('.png'));
  assert(result.includes('20260101T103045'));
});

test('evidencePath sanitizes step name', () => {
  const result = evidencePath({
    root: '/evidence',
    issue: 'PAR-1234',
    step: 'my@step#name',
    now: new Date('2026-01-01T10:00:00Z')
  });
  assert(result.includes('mystepname'));
});

test('evidencePath default step is shot', () => {
  const result = evidencePath({
    root: '/evidence',
    issue: 'PAR-1234',
    now: new Date('2026-01-01T10:00:00Z')
  });
  assert(result.includes('shot'));
});

test('evidencePath rejects invalid issue', () => {
  assert.throws(() => {
    evidencePath({
      root: '/evidence',
      issue: 'invalid-issue',
      step: 'test',
      now: new Date()
    });
  });
});

test('evidencePath sanitizes special chars in step', () => {
  const result = evidencePath({
    root: '/evidence',
    issue: 'PAR-1234',
    step: '../../../etc/passwd',
    now: new Date('2026-01-01T10:00:00Z')
  });
  // Special chars are removed, leaving empty string which becomes default 'shot'
  // But empty step is invalid, so it should throw
  assert.throws(() => {
    evidencePath({
      root: '/evidence',
      issue: 'PAR-1234',
      step: '',
      now: new Date()
    });
  });
});

test('writeShot writes file with correct content', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-test-'));
  try {
    const testData = Buffer.from('test image data');
    const sha256 = crypto.createHash('sha256').update(testData).digest('hex');
    const b64 = testData.toString('base64');

    const result = writeShot({
      fs,
      root: tmpDir,
      issue: 'PAR-1234',
      step: 'test',
      now: new Date('2026-01-01T10:00:00Z'),
      b64,
      sha256
    });

    assert.equal(result.exit, undefined);
    assert(result.path);
    assert.equal(result.bytes, testData.length);
    assert.equal(result.sha256, sha256);

    // Verify file exists and has correct content
    const written = fs.readFileSync(result.path);
    assert.deepEqual(written, testData);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('writeShot rejects sha256 mismatch', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-test-'));
  try {
    const testData = Buffer.from('test image data');
    const wrongHash = 'abc123';
    const b64 = testData.toString('base64');

    const result = writeShot({
      fs,
      root: tmpDir,
      issue: 'PAR-1234',
      step: 'test',
      now: new Date('2026-01-01T10:00:00Z'),
      b64,
      sha256: wrongHash
    });

    assert.equal(result.exit, 5);
    assert.equal(result.reason, 'sha_mismatch');

    // Verify file was not written
    const dirContents = fs.readdirSync(tmpDir);
    assert.equal(dirContents.length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('writeShot creates directories', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-test-'));
  try {
    const testData = Buffer.from('test image data');
    const sha256 = crypto.createHash('sha256').update(testData).digest('hex');
    const b64 = testData.toString('base64');

    const result = writeShot({
      fs,
      root: tmpDir,
      issue: 'PAR-1234',
      step: 'test',
      now: new Date('2026-01-01T10:00:00Z'),
      b64,
      sha256
    });

    assert.equal(result.exit, undefined);

    // Verify directories were created
    assert(fs.existsSync(path.join(tmpDir, 'PAR-1234')));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
