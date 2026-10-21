'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { EXIT } = require('../src/exit-codes.cjs');
const { createDispatcher } = require('../src/dispatch.cjs');
const { createApprovalStore, verifyApproval } = require('../src/approval.cjs');
const { buildVerifyApproval } = require('../src/daemon.cjs');
const { createFakeBrowser } = require('./fake-browser.cjs');

test('createDispatcher WITHOUT checkFill: fill on password field => exit 7 (default rules active)', async () => {
  const { dispatch } = createDispatcher({
    authenticate: async () => ({
      ok: true, agentId: 'a1', companyId: 'ca', issue: { id: 'i1', identifier: 'PAR-1234', companyId: 'ca' }
    }),
    browser: createFakeBrowser({
      'https://example.com/home': {
        text: 'Home Dashboard',
        fields: { 'input#pwd': { type: 'password', autocomplete: 'current-password' } }
      }
    }),
    policy: {
      version: 1, agents: { 'a1': { identities: ['client:ca:example'] } },
      identities: { 'client:ca:example': { origins: ['https://example.com'] } }
    },
    sites: { sites: { example: {
      label: 'Example', origins: ['https://example.com'],
      loggedIn: { url: 'https://example.com/home', expect: 'Home' },
      confirm: [], redact: [], destructive: { selectors: [], text: [] }
    }}},
    clock: () => new Date('2026-01-01T10:00:00Z'),
    evidenceDir: '/tmp/evidence'
    // Note: NO checkFill provided
  });

  const openResult = await dispatch({ cmd: 'open', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:example' });
  assert.equal(openResult.exit, EXIT.DONE, `open failed: ${JSON.stringify(openResult)}`);

  const r = await dispatch({
    cmd: 'fill',
    token: 'valid',
    issue: 'PAR-1234',
    identity: 'client:ca:example',
    args: { selector: 'input#pwd', value: 'secret123' }
  });
  assert.equal(r.exit, EXIT.REFUSED_BY_POLICY, 'should use default fill-rules');
  assert.equal(r.ok, false);
  assert(r.reason.includes('password') || r.reason === 'password_field_refused');
});

test('checkFill that throws => exit 7, field not filled', async () => {
  const checkFill = () => { throw new Error('checkFill exploded'); };

  const { dispatch } = createDispatcher({
    authenticate: async () => ({
      ok: true, agentId: 'a1', companyId: 'ca', issue: { id: 'i1', identifier: 'PAR-1234', companyId: 'ca' }
    }),
    browser: createFakeBrowser({
      'https://example.com/home': {
        text: 'Home Dashboard',
        fields: { 'input#email': { type: 'text' } }
      }
    }),
    policy: {
      version: 1, agents: { 'a1': { identities: ['client:ca:example'] } },
      identities: { 'client:ca:example': { origins: ['https://example.com'] } }
    },
    sites: { sites: { example: {
      label: 'Example', origins: ['https://example.com'],
      loggedIn: { url: 'https://example.com/home', expect: 'Home' },
      confirm: [], redact: [], destructive: { selectors: [], text: [] }
    }}},
    clock: () => new Date('2026-01-01T10:00:00Z'),
    evidenceDir: '/tmp/evidence',
    checkFill
  });

  const openResult = await dispatch({ cmd: 'open', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:example' });
  assert.equal(openResult.exit, EXIT.DONE, `open failed: ${JSON.stringify(openResult)}`);

  const r = await dispatch({
    cmd: 'fill',
    token: 'valid',
    issue: 'PAR-1234',
    identity: 'client:ca:example',
    args: { selector: 'input#email', value: 'test@example.com' }
  });
  assert.equal(r.exit, EXIT.REFUSED_BY_POLICY);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'fill_check_failed');
});

test('checkFill returns undefined => exit 7', async () => {
  const checkFill = () => undefined;

  const { dispatch } = createDispatcher({
    authenticate: async () => ({
      ok: true, agentId: 'a1', companyId: 'ca', issue: { id: 'i1', identifier: 'PAR-1234', companyId: 'ca' }
    }),
    browser: createFakeBrowser({
      'https://example.com/home': {
        text: 'Home Dashboard',
        fields: { 'input#email': { type: 'text' } }
      }
    }),
    policy: {
      version: 1, agents: { 'a1': { identities: ['client:ca:example'] } },
      identities: { 'client:ca:example': { origins: ['https://example.com'] } }
    },
    sites: { sites: { example: {
      label: 'Example', origins: ['https://example.com'],
      loggedIn: { url: 'https://example.com/home', expect: 'Home' },
      confirm: [], redact: [], destructive: { selectors: [], text: [] }
    }}},
    clock: () => new Date('2026-01-01T10:00:00Z'),
    evidenceDir: '/tmp/evidence',
    checkFill
  });

  const openResult = await dispatch({ cmd: 'open', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:example' });
  assert.equal(openResult.exit, EXIT.DONE, `open failed: ${JSON.stringify(openResult)}`);

  const r = await dispatch({
    cmd: 'fill',
    token: 'valid',
    issue: 'PAR-1234',
    identity: 'client:ca:example',
    args: { selector: 'input#email', value: 'test@example.com' }
  });
  assert.equal(r.exit, EXIT.REFUSED_BY_POLICY);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'fill_check_failed');
});

test('verifyApproval throws => exit 8 and click not performed', async () => {
  const verifyApproval = async () => { throw new Error('approval service exploded'); };

  const { dispatch } = createDispatcher({
    authenticate: async () => ({
      ok: true, agentId: 'a1', companyId: 'ca', issue: { id: 'i1', identifier: 'PAR-1234', companyId: 'ca' }
    }),
    browser: createFakeBrowser({
      'https://business.facebook.com/latest/home': { text: 'Home Dashboard' }
    }),
    policy: {
      version: 1, agents: { 'a1': { identities: ['client:ca:meta'] } },
      identities: { 'client:ca:meta': { origins: ['https://business.facebook.com'] } }
    },
    sites: { sites: { meta: {
      label: 'Meta', origins: ['https://business.facebook.com'],
      loggedIn: { url: 'https://business.facebook.com/latest/home', expect: 'Home' },
      confirm: [], redact: [], destructive: { selectors: ['[data-action=delete]'], text: ['delete'] }
    }}},
    clock: () => new Date('2026-01-01T10:00:00Z'),
    evidenceDir: '/tmp/evidence',
    verifyApproval
  });

  await dispatch({ cmd: 'open', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta' });
  const r = await dispatch({
    cmd: 'click',
    token: 'valid',
    issue: 'PAR-1234',
    identity: 'client:ca:meta',
    args: { selector: '[data-action=delete]', text: 'delete', approval: 'PAR-5678' }
  });
  assert.equal(r.exit, EXIT.NEEDS_APPROVAL);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'approval_check_failed');
});

test('buildVerifyApproval with old approval (25h) => approval_stale', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pib-test-'));
  try {
    const store = createApprovalStore({ stateDir: tmpDir, fs, path });

    const completedAt = Date.now() - (25 * 3600 * 1000); // 25 hours ago
    const clock = { now: () => Date.now() };

    const fakeFetch = async (url) => {
      if (url.includes('/api/issues/PAR-5678')) {
        return {
          ok: true,
          json: async () => ({
            id: 'i1',
            identifier: 'PAR-5678',
            companyId: 'ca',
            status: 'done',
            completedAt: new Date(completedAt).toISOString()
          })
        };
      }
      if (url.includes('/api/issues/PAR-5678/activity')) {
        return {
          ok: true,
          json: async () => ({
            activity: [{
              action: 'issue.updated',
              actorType: 'user',
              createdAt: new Date(completedAt).toISOString(),
              details: { status: 'done' }
            }]
          })
        };
      }
      if (url.includes('/api/issues/PAR-5678/comments')) {
        return { ok: false };
      }
      return { ok: false };
    };

    const verifyApprovalFn = buildVerifyApproval({
      apiBase: 'http://test',
      store,
      clock,
      fetch: fakeFetch
    });

    const result = await verifyApprovalFn(
      { approval: 'PAR-5678', identity: 'client:ca:example', action: 'test', companyId: 'ca' },
      { token: 'test-token' }
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'approval_stale');
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('buildVerifyApproval with valid approval => ok:true once, then approval_already_used', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pib-test-'));
  try {
    const store = createApprovalStore({ stateDir: tmpDir, fs, path });

    const now = Date.now();
    const clock = { now: () => now };

    const responses = {
      'http://test/api/issues/PAR-5678': { ok: true, data: { id: 'i1', status: 'done', companyId: 'ca', completedAt: new Date(now - 1000).toISOString(), description: 'approval for myid:myaction' } },
      'http://test/api/issues/PAR-5678/activity': { ok: true, data: [{ id: 'a1', action: 'issue.updated', createdAt: new Date(now - 1000).toISOString(), actorType: 'user', details: { changes: { status: { from: 'open', to: 'done' } } } }] },
      'http://test/api/issues/PAR-5678/comments': { ok: true, data: [] }
    };

    const fakeFetch = async (url) => {
      const resp = responses[url];
      if (!resp) throw new Error(`No mock for ${url}`);
      return {
        ok: resp.ok,
        json: async () => resp.data
      };
    };

    const verifyApprovalFn = buildVerifyApproval({
      apiBase: 'http://test',
      store,
      clock,
      fetch: fakeFetch
    });

    const result1 = await verifyApprovalFn(
      { approval: 'PAR-5678', identity: 'myid', action: 'myaction', companyId: 'ca' },
      { token: 'test-token' }
    );
    assert.equal(result1.ok, true, `Expected ok:true but got reason: ${result1.reason}`);

    const result2 = await verifyApprovalFn(
      { approval: 'PAR-5678', identity: 'myid', action: 'myaction', companyId: 'ca' },
      { token: 'test-token' }
    );
    assert.equal(result2.ok, false);
    assert.equal(result2.reason, 'approval_already_used');
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('verifyApproval with clock = plain function => approval_lookup_failed', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pib-test-'));
  try {
    const store = createApprovalStore({ stateDir: tmpDir, fs, path });

    const completedAt = Date.now() - (1 * 3600 * 1000);
    const clock = () => Date.now(); // Plain function, not { now: ... }

    const fakeFetch = async () => ({ ok: true, json: async () => ({
      id: 'i1', identifier: 'PAR-5678', companyId: 'ca', status: 'done',
      completedAt: new Date(completedAt).toISOString()
    })});

    const result = await verifyApproval(
      { approval: 'PAR-5678', identity: 'client:ca:example', action: 'test', companyId: 'ca' },
      { token: 'test-token', fetch: fakeFetch, apiBase: 'http://test', clock, store }
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'approval_lookup_failed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('verifyApproval with clock = {} => approval_lookup_failed', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pib-test-'));
  try {
    const store = createApprovalStore({ stateDir: tmpDir, fs, path });

    const completedAt = Date.now() - (1 * 3600 * 1000);
    const clock = {}; // Empty object, no now() method

    const fakeFetch = async () => ({ ok: true, json: async () => ({
      id: 'i1', identifier: 'PAR-5678', companyId: 'ca', status: 'done',
      completedAt: new Date(completedAt).toISOString()
    })});

    const result = await verifyApproval(
      { approval: 'PAR-5678', identity: 'client:ca:example', action: 'test', companyId: 'ca' },
      { token: 'test-token', fetch: fakeFetch, apiBase: 'http://test', clock, store }
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'approval_lookup_failed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('verifyApproval with NaN age (invalid completedAt) => fails', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pib-test-'));
  try {
    const store = createApprovalStore({ stateDir: tmpDir, fs, path });
    const clock = { now: () => Date.now() };

    const fakeFetch = async (url) => {
      if (url.includes('/api/issues/PAR-5678')) {
        return {
          ok: true,
          json: async () => ({
            id: 'i1',
            identifier: 'PAR-5678',
            companyId: 'ca',
            status: 'done',
            completedAt: 'not-a-date'
          })
        };
      }
      return { ok: false };
    };

    const result = await verifyApproval(
      { approval: 'PAR-5678', identity: 'client:ca:example', action: 'test', companyId: 'ca' },
      { token: 'test-token', fetch: fakeFetch, apiBase: 'http://test', clock, store }
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'approval_not_done');
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

module.exports = {};
