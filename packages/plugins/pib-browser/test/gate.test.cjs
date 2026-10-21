'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EXIT } = require('../src/exit-codes.cjs');
const { createDispatcher, COMMANDS } = require('../src/dispatch.cjs');
const { createFakeBrowser } = require('./fake-browser.cjs');

test('COMMANDS contains exactly 7 verbs', () => {
  assert.deepEqual(COMMANDS, ['open', 'goto', 'click', 'fill', 'text', 'shot', 'close']);
  assert(!COMMANDS.includes('handoff'), 'no handoff command');
  assert(!COMMANDS.includes('cookies'), 'no cookies command');
  assert(!COMMANDS.includes('storage'), 'no storage command');
  assert(!COMMANDS.includes('evaluate'), 'no evaluate command');
});

test('destructive click without approval => exit 8', async () => {
  const { dispatch } = createDispatcher({
    authenticate: async () => ({
      ok: true, agentId: 'a1', companyId: 'ca', issue: { id: 'i1', identifier: 'PAR-1234', companyId: 'ca' }
    }),
    browser: createFakeBrowser({ 'https://business.facebook.com/latest/home': { text: 'Home Dashboard' } }),
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
    evidenceDir: '/tmp/evidence'
  });

  await dispatch({ cmd: 'open', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta' });
  const r = await dispatch({
    cmd: 'click',
    token: 'valid',
    issue: 'PAR-1234',
    identity: 'client:ca:meta',
    args: { selector: '[data-action=delete]', text: 'delete' }
  });
  assert.equal(r.exit, EXIT.NEEDS_APPROVAL);
  assert.equal(r.ok, false);
});

test('destructive click with valid approval => proceeds, consumed on use', async () => {
  let verifyCallCount = 0;
  const verifyApproval = async (params, { token }) => {
    verifyCallCount++;
    assert.equal(typeof token, 'string', 'token passed');
    assert.deepEqual(params.action, ['[data-action=delete]', 'delete']);
    assert.equal(params.identity, 'client:ca:meta');
    assert.equal(params.companyId, 'ca');
    return verifyCallCount === 1 ? { ok: true } : { ok: false, exit: 8, reason: 'approval_consumed' };
  };

  const { dispatch } = createDispatcher({
    authenticate: async () => ({
      ok: true, agentId: 'a1', companyId: 'ca', issue: { id: 'i1', identifier: 'PAR-1234', companyId: 'ca' }
    }),
    browser: createFakeBrowser({ 'https://business.facebook.com/latest/home': { text: 'Home Dashboard' } }),
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
  const r1 = await dispatch({
    cmd: 'click',
    token: 'valid',
    issue: 'PAR-1234',
    identity: 'client:ca:meta',
    args: { selector: '[data-action=delete]', text: 'delete', approval: 'tok1' }
  });
  assert.equal(r1.exit, EXIT.DONE);
  assert.equal(verifyCallCount, 1);

  const r2 = await dispatch({
    cmd: 'click',
    token: 'valid',
    issue: 'PAR-1234',
    identity: 'client:ca:meta',
    args: { selector: '[data-action=delete]', text: 'delete', approval: 'tok1' }
  });
  assert.equal(r2.exit, 8);
  assert.equal(verifyCallCount, 2);
});

test('non-destructive click never calls verifyApproval', async () => {
  let verifyCallCount = 0;
  const verifyApproval = async () => {
    verifyCallCount++;
    return { ok: true };
  };

  const { dispatch } = createDispatcher({
    authenticate: async () => ({
      ok: true, agentId: 'a1', companyId: 'ca', issue: { id: 'i1', identifier: 'PAR-1234', companyId: 'ca' }
    }),
    browser: createFakeBrowser({ 'https://business.facebook.com/latest/home': { text: 'Home Dashboard' } }),
    policy: {
      version: 1, agents: { 'a1': { identities: ['client:ca:meta'] } },
      identities: { 'client:ca:meta': { origins: ['https://business.facebook.com'] } }
    },
    sites: { sites: { meta: {
      label: 'Meta', origins: ['https://business.facebook.com'],
      loggedIn: { url: 'https://business.facebook.com/latest/home', expect: 'Home' },
      confirm: [], redact: [], destructive: { selectors: ['[data-action=delete]'], text: [] }
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
    args: { selector: 'button#normal' }
  });
  assert.equal(r.exit, EXIT.DONE);
  assert.equal(verifyCallCount, 0);
});

test('fill on password field => exit 7 and no echo', async () => {
  const CANARY = 'CANARY_PASSWORD_12345';
  const checkFill = ({ field }) => {
    if (field?.type === 'password') return { ok: false, reason: 'password_field' };
    return { ok: true };
  };

  const { dispatch } = createDispatcher({
    authenticate: async () => ({
      ok: true, agentId: 'a1', companyId: 'ca', issue: { id: 'i1', identifier: 'PAR-1234', companyId: 'ca' }
    }),
    browser: createFakeBrowser({
      'https://business.facebook.com/latest/home': {
        text: 'Home Dashboard',
        fields: { 'input#pwd': { type: 'password', autocomplete: 'current-password' } }
      }
    }),
    policy: {
      version: 1, agents: { 'a1': { identities: ['client:ca:meta'] } },
      identities: { 'client:ca:meta': { origins: ['https://business.facebook.com'] } }
    },
    sites: { sites: { meta: {
      label: 'Meta', origins: ['https://business.facebook.com'],
      loggedIn: { url: 'https://business.facebook.com/latest/home', expect: 'Home' },
      confirm: [], redact: [], destructive: { selectors: [], text: [] }
    }}},
    clock: () => new Date('2026-01-01T10:00:00Z'),
    evidenceDir: '/tmp/evidence',
    checkFill
  });

  await dispatch({ cmd: 'open', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta' });
  const r = await dispatch({
    cmd: 'fill',
    token: 'valid',
    issue: 'PAR-1234',
    identity: 'client:ca:meta',
    args: { selector: 'input#pwd', value: CANARY }
  });
  assert.equal(r.exit, EXIT.REFUSED_BY_POLICY);
  assert.equal(r.ok, false);
  assert(!JSON.stringify(r).includes(CANARY));
});

test('fill on loggedIn.url page => exit 7', async () => {
  const checkFill = ({ pageUrl, site }) => {
    if (pageUrl === site.loggedIn.url) return { ok: false, reason: 'protected_page' };
    return { ok: true };
  };

  const { dispatch } = createDispatcher({
    authenticate: async () => ({
      ok: true, agentId: 'a1', companyId: 'ca', issue: { id: 'i1', identifier: 'PAR-1234', companyId: 'ca' }
    }),
    browser: createFakeBrowser({ 'https://business.facebook.com/latest/home': { text: 'Home Dashboard', fields: {} } }),
    policy: {
      version: 1, agents: { 'a1': { identities: ['client:ca:meta'] } },
      identities: { 'client:ca:meta': { origins: ['https://business.facebook.com'] } }
    },
    sites: { sites: { meta: {
      label: 'Meta', origins: ['https://business.facebook.com'],
      loggedIn: { url: 'https://business.facebook.com/latest/home', expect: 'Home' },
      confirm: [], redact: [], destructive: { selectors: [], text: [] }
    }}},
    clock: () => new Date('2026-01-01T10:00:00Z'),
    evidenceDir: '/tmp/evidence',
    checkFill
  });

  await dispatch({ cmd: 'open', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta' });
  const r = await dispatch({
    cmd: 'fill',
    token: 'valid',
    issue: 'PAR-1234',
    identity: 'client:ca:meta',
    args: { selector: 'input#email', value: 'test@example.com' }
  });
  assert.equal(r.exit, EXIT.REFUSED_BY_POLICY);
  assert.equal(r.ok, false);
});

test('fill with handoff active => proceeds despite page check', async () => {
  const checkFill = ({ pageUrl, site, handoffActive }) => {
    if (handoffActive) return { ok: true };
    if (pageUrl === site.loggedIn.url) return { ok: false, reason: 'protected_page' };
    return { ok: true };
  };

  const handoff = { isActive: (identity) => identity === 'client:ca:meta' };

  const { dispatch } = createDispatcher({
    authenticate: async () => ({
      ok: true, agentId: 'a1', companyId: 'ca', issue: { id: 'i1', identifier: 'PAR-1234', companyId: 'ca' }
    }),
    browser: createFakeBrowser({ 'https://business.facebook.com/latest/home': { text: 'Home Dashboard', fields: {} } }),
    policy: {
      version: 1, agents: { 'a1': { identities: ['client:ca:meta'] } },
      identities: { 'client:ca:meta': { origins: ['https://business.facebook.com'] } }
    },
    sites: { sites: { meta: {
      label: 'Meta', origins: ['https://business.facebook.com'],
      loggedIn: { url: 'https://business.facebook.com/latest/home', expect: 'Home' },
      confirm: [], redact: [], destructive: { selectors: [], text: [] }
    }}},
    clock: () => new Date('2026-01-01T10:00:00Z'),
    evidenceDir: '/tmp/evidence',
    checkFill,
    handoff
  });

  await dispatch({ cmd: 'open', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta' });
  const r = await dispatch({
    cmd: 'fill',
    token: 'valid',
    issue: 'PAR-1234',
    identity: 'client:ca:meta',
    args: { selector: 'input#email', value: 'test@example.com' }
  });
  assert.equal(r.exit, EXIT.DONE);
  assert.equal(r.ok, true);
});

module.exports = {};
