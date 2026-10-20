'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EXIT } = require('../src/exit-codes.cjs');
const { createDispatcher, COMMANDS } = require('../src/dispatch.cjs');
const { createFakeBrowser } = require('./fake-browser.cjs');

const h = (o = {}) => {
  const { dispatch } = createDispatcher({
    authenticate: o.authenticate || (async () => ({
      ok: true, agentId: 'a1', companyId: 'ca', issue: { id: 'i1', identifier: 'PAR-1234', companyId: 'ca' }
    })),
    browser: o.browser || createFakeBrowser({ 'https://business.facebook.com/latest/home': { text: 'Home Dashboard' } }),
    policy: o.policy || {
      version: 1, agents: { 'a1': { identities: ['client:ca:meta'] } },
      identities: { 'client:ca:meta': { origins: ['https://business.facebook.com'] } }
    },
    sites: o.sites || { sites: { meta: {
      label: 'Meta', origins: ['https://business.facebook.com'],
      loggedIn: { url: 'https://business.facebook.com/latest/home', expect: 'Home' },
      confirm: [], redact: [], destructive: { selectors: ['[data-action=delete]'], text: ['delete'] }
    }}},
    clock: o.clock || (() => new Date('2026-01-01T10:00:00Z')),
    evidenceDir: o.evidenceDir || '/tmp/evidence'
  });
  return { dispatch };
};

test('COMMANDS and invalid commands', async () => {
  assert.deepEqual(COMMANDS, ['open', 'goto', 'click', 'fill', 'text', 'shot', 'close']);
  assert(Object.isFrozen(COMMANDS), 'frozen');

  for (const [cmd] of [['cookies'], ['storage'], ['evaluate'], [''], ['unknown'], [null]]) {
    let authCalled = false;
    const { dispatch } = h({ authenticate: async () => { authCalled = true; return { ok: true }; } });
    const result = await dispatch({ cmd });
    assert.equal(result.exit, EXIT.USAGE, `${cmd}`);
    assert.equal(authCalled, false, `auth should not be called for ${cmd}`);
  }
});

[
  ['bad token', { authenticate: async () => ({ exit: EXIT.REFUSED_BY_POLICY, reason: 'bad_token' }) }, 'open', { token: 'bad', issue: 'PAR-1234', identity: 'client:ca:meta' }, EXIT.REFUSED_BY_POLICY],
  ['other company', { authenticate: async () => ({ exit: EXIT.REFUSED_BY_POLICY, reason: 'issue_other_company' }) }, 'open', { token: 'valid', issue: 'OTHER-999', identity: 'client:ca:meta' }, EXIT.REFUSED_BY_POLICY],
  ['invalid identity', {}, 'open', { token: 'valid', issue: 'PAR-1234', identity: 'bad-format' }, EXIT.USAGE],
  ['session expired', { browser: createFakeBrowser({ 'https://business.facebook.com/latest/home': { text: 'No' } }) }, 'open', { token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta' }, EXIT.SESSION_EXPIRED],
].forEach(([label, cfg, cmd, req, exitExpected]) => {
  test(label + ' -> ' + exitExpected, async () => {
    const { dispatch } = h(cfg);
    const r = await dispatch({ cmd, ...req });
    assert.equal(r.exit, exitExpected);
  });
});

test('open happy path', async () => {
  const { dispatch } = h();
  const r = await dispatch({ cmd: 'open', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta' });
  assert.equal(r.exit, EXIT.DONE);
});

test('goto happy path', async () => {
  const { dispatch } = h({
    browser: createFakeBrowser({
      'https://business.facebook.com/latest/home': { text: 'Home' },
      'https://business.facebook.com/campaigns': { text: 'Campaigns' }
    })
  });
  await dispatch({ cmd: 'open', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta' });
  const r = await dispatch({ cmd: 'goto', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta', args: { url: 'https://business.facebook.com/campaigns' } });
  assert.equal(r.exit, EXIT.DONE);
});

test('fill happy path with data', async () => {
  const { dispatch } = h();
  await dispatch({ cmd: 'open', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta' });
  const r = await dispatch({ cmd: 'fill', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta', args: { selector: 'input#email', value: 'test@example.com' } });
  assert.equal(r.exit, EXIT.DONE);
  assert.deepEqual(r.data, { filled: true });
});

test('fill never echoes canary', async () => {
  const CANARY = 'THIS_IS_A_CANARY_STRING_12345';
  const { dispatch } = h();
  await dispatch({ cmd: 'open', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta' });
  const r = await dispatch({ cmd: 'fill', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta', args: { selector: 'input#secret', value: CANARY } });
  assert(!JSON.stringify(r).includes(CANARY));
});

test('text happy path', async () => {
  const { dispatch } = h();
  await dispatch({ cmd: 'open', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta' });
  const r = await dispatch({ cmd: 'text', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta', args: { selector: 'body' } });
  assert.equal(r.exit, EXIT.DONE);
  assert(typeof r.data.text === 'string');
});

test('shot evidence path includes identifier', async () => {
  const { dispatch } = h();
  await dispatch({ cmd: 'open', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta' });
  const r = await dispatch({ cmd: 'shot', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta', args: {} });
  assert.equal(r.exit, EXIT.DONE);
  assert(r.data.path.includes('PAR-1234') && r.data.path.endsWith('.png'));
});

test('shot expect missing -> 4', async () => {
  const { dispatch } = h();
  await dispatch({ cmd: 'open', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta' });
  const r = await dispatch({ cmd: 'shot', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta', args: { expect: 'Nonexistent' } });
  assert.equal(r.exit, EXIT.EXPECT_MISSING);
});

test('shot failure -> 5', async () => {
  const { dispatch } = h({
    browser: { newContext: () => ({ goto: async () => {}, hasText: async () => true, text: async () => 'test', shot: async () => null, click: async () => {}, fill: async () => {}, close: async () => {}, violations: () => [] }) }
  });
  await dispatch({ cmd: 'open', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta' });
  const r = await dispatch({ cmd: 'shot', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta', args: {} });
  assert.equal(r.exit, EXIT.NO_SCREENSHOT);
});

test('close removes session', async () => {
  const { dispatch } = h();
  const { dispatch: d2, sessions } = createDispatcher({
    authenticate: async () => ({ ok: true, agentId: 'a1', companyId: 'ca', issue: { id: 'i1', identifier: 'PAR-1234', companyId: 'ca' } }),
    browser: createFakeBrowser({ 'https://business.facebook.com/latest/home': { text: 'Home Dashboard' } }),
    policy: { version: 1, agents: { 'a1': { identities: ['client:ca:meta'] } }, identities: { 'client:ca:meta': { origins: ['https://business.facebook.com'] } } },
    sites: { sites: { meta: { label: 'Meta', origins: ['https://business.facebook.com'], loggedIn: { url: 'https://business.facebook.com/latest/home', expect: 'Home' }, confirm: [], redact: [], destructive: { selectors: [], text: [] } }}},
    clock: () => new Date('2026-01-01T10:00:00Z'),
    evidenceDir: '/tmp/evidence'
  });
  await d2({ cmd: 'open', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta' });
  assert.equal(sessions.has('a1|client:ca:meta'), true);
  await d2({ cmd: 'close', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta' });
  assert.equal(sessions.has('a1|client:ca:meta'), false);
});

test('click missing selector -> 2', async () => {
  const { dispatch } = h();
  await dispatch({ cmd: 'open', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta' });
  const r = await dispatch({ cmd: 'click', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta', args: {} });
  assert.equal(r.exit, EXIT.USAGE);
});

test('shot region invalid -> 2', async () => {
  const { dispatch } = h();
  await dispatch({ cmd: 'open', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta' });
  const r = await dispatch({ cmd: 'shot', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta', args: { region: 'invalid' } });
  assert.equal(r.exit, EXIT.USAGE);
});

test('open with no browser -> 3', async () => {
  const { dispatch } = createDispatcher({
    authenticate: async () => ({ ok: true, agentId: 'a1', companyId: 'ca', issue: { id: 'i1', identifier: 'PAR-1234', companyId: 'ca' } }),
    browser: null,
    policy: { version: 1, agents: { 'a1': { identities: ['client:ca:meta'] } }, identities: { 'client:ca:meta': { origins: ['https://business.facebook.com'] } } },
    sites: { sites: { meta: { label: 'Meta', origins: ['https://business.facebook.com'], loggedIn: { url: 'https://business.facebook.com/latest/home', expect: 'Home' }, confirm: [], redact: [], destructive: { selectors: [], text: [] } } } },
    clock: () => new Date('2026-01-01T10:00:00Z'),
    evidenceDir: '/tmp/evidence'
  });
  const r = await dispatch({ cmd: 'open', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta' });
  assert.equal(r.exit, EXIT.NO_BROWSER);
  assert.equal(r.reason, 'no_browser');
});

test('destructive click -> 8', async () => {
  const { dispatch } = h();
  await dispatch({ cmd: 'open', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta' });
  const r = await dispatch({ cmd: 'click', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta', args: { selector: '[data-action=delete]', text: 'delete' } });
  assert.equal(r.exit, EXIT.NEEDS_APPROVAL);
});

test('text redaction applied', async () => {
  const { dispatch } = h({
    browser: createFakeBrowser({ 'https://business.facebook.com/latest/home': { text: 'Home Dashboard. Bearer secret123 in response.' } })
  });
  await dispatch({ cmd: 'open', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta' });
  const r = await dispatch({ cmd: 'text', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta', args: { selector: 'body' } });
  assert.equal(r.exit, EXIT.DONE);
  assert(!r.data.text.includes('secret123'));
  assert(r.data.text.includes('[redacted]'));
});
