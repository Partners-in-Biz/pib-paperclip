'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EXIT } = require('../src/exit-codes.cjs');
const { createDispatcher } = require('../src/dispatch.cjs');
const { createFakeBrowser } = require('./fake-browser.cjs');

const cases = [
  ['goto other origin', () => createFakeBrowser({ 'https://business.facebook.com/home': { text: 'Home' } }), 'goto', { url: 'https://evil.example.com' }, false],
  ['link-click other origin', () => createFakeBrowser({ 'https://business.facebook.com/home': { text: 'Home', links: { 'a': 'https://evil.example.com' } } }), 'click', { selector: 'a' }, true],
  ['server redirect', () => createFakeBrowser({ 'https://business.facebook.com/login': { text: 'Login', redirect: 'https://evil.com/' }, 'https://business.facebook.com/home': { text: 'Home' } }), 'goto', { url: 'https://business.facebook.com/login' }, true],
  ['popup to other host', () => createFakeBrowser({ 'https://business.facebook.com/home': { text: 'Home', popups: { 'btn': 'https://attacker.net/ads' } } }), 'click', { selector: 'btn' }, true],
  ['subresource to other host', () => createFakeBrowser({ 'https://business.facebook.com/home': { text: 'Home', subresources: ['https://cdn.evil.com/js'] } }), 'open', {}, true],
  ['userinfo via redirect', () => createFakeBrowser({ 'https://business.facebook.com/auth': { text: 'Auth', redirect: 'https://user:pw@evil.example.com/' }, 'https://business.facebook.com/home': { text: 'Home' } }), 'goto', { url: 'https://business.facebook.com/auth' }, true],
  ['javascript: scheme', () => createFakeBrowser({ 'https://business.facebook.com/home': { text: 'Home', links: { 'btn': 'javascript:alert(1)' } } }), 'click', { selector: 'btn' }, true],
  ['data: scheme', () => createFakeBrowser({ 'https://business.facebook.com/home': { text: 'Home', links: { 'btn': 'data:text/html,<h1>xss</h1>' } } }), 'click', { selector: 'btn' }, true],
  ['lookalike host', () => createFakeBrowser({ 'https://business.facebook.com/home': { text: 'Home' }, 'https://a.example.com/page': { text: 'Page' } }), 'goto', { url: 'https://a.example.evil.com/page' }, false],
  ['different port', () => createFakeBrowser({ 'https://business.facebook.com/home': { text: 'Home' } }), 'goto', { url: 'https://business.facebook.com:8080/home' }, false],
  ['http downgrade', () => createFakeBrowser({ 'https://business.facebook.com/home': { text: 'Home' } }), 'goto', { url: 'http://business.facebook.com/home' }, false]
];

const defs = { auth: async () => ({ ok: true, agentId: 'a1', companyId: 'ca', issue: { id: 'i1', identifier: 'PAR-1234', companyId: 'ca' } }), clock: () => new Date(), evidenceDir: '/tmp/evidence' };

cases.forEach(([name, setup, cmd, args, isDriver]) => {
  test(`wall - ${name} -> exit 7`, async () => {
    const policy = { version: 1, agents: { 'a1': { identities: ['client:ca:meta'] } }, identities: { 'client:ca:meta': { origins: ['https://business.facebook.com', 'https://a.example.com'] } } };
    const sites = { sites: { meta: { label: 'Meta', origins: ['https://business.facebook.com', 'https://a.example.com'], loggedIn: { url: 'https://business.facebook.com/home', expect: 'Home' }, confirm: [], redact: [], destructive: { selectors: [], text: [] } } } };
    const browser = setup();
    const { dispatch, sessions } = createDispatcher({ authenticate: defs.auth, browser, policy, sites, clock: defs.clock, evidenceDir: defs.evidenceDir });
    if (cmd === 'open') {
      const r = await dispatch({ cmd, token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta' });
      assert.equal(r.exit, EXIT.REFUSED_BY_POLICY);
      assert(!r.reason.includes('/') && !r.reason.includes('?') && !r.reason.includes('@') && !r.reason.includes('pw'));
      if (isDriver) assert(r.reason.startsWith('origin_wall'));
    } else {
      await dispatch({ cmd: 'open', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta' });
      const r = await dispatch({ cmd, token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta', args });
      assert.equal(r.exit, EXIT.REFUSED_BY_POLICY);
      assert(!r.reason.includes('/') && !r.reason.includes('?') && !r.reason.includes('@') && !r.reason.includes('pw'));
      if (isDriver) assert(r.reason.startsWith('origin_wall'));
      const ctx = browser.lastContext();
      if (ctx && isDriver) assert(ctx.violations().length > 0);
    }
    assert.equal(sessions.has('a1|client:ca:meta'), false);
  });
});

test('wall - in-origin navigation passes', async () => {
  const policy = { version: 1, agents: { 'a1': { identities: ['client:ca:meta'] } }, identities: { 'client:ca:meta': { origins: ['https://business.facebook.com', 'https://www.facebook.com'] } } };
  const sites = { sites: { meta: { label: 'Meta', origins: ['https://business.facebook.com', 'https://www.facebook.com'], loggedIn: { url: 'https://business.facebook.com/home', expect: 'Home' }, confirm: [], redact: [], destructive: { selectors: [], text: [] } } } };
  const { dispatch, sessions } = createDispatcher({ authenticate: defs.auth, browser: createFakeBrowser({ 'https://business.facebook.com/home': { text: 'Home' }, 'https://business.facebook.com/ads': { text: 'Ads' }, 'https://www.facebook.com/profile': { text: 'Profile' } }), policy, sites, clock: defs.clock, evidenceDir: defs.evidenceDir });
  await dispatch({ cmd: 'open', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta' });
  const r1 = await dispatch({ cmd: 'goto', token: 'valid', issue: 'PAR-1234', identity: 'client:ca:meta', args: { url: 'https://business.facebook.com/ads' } });
  assert.equal(r1.exit, EXIT.DONE);
  assert.equal(sessions.has('a1|client:ca:meta'), true);
});

test('wall - cross-company isolation', async () => {
  const policy = { version: 1, agents: { 'a1': { identities: ['client:ca:meta'] }, 'a2': { identities: ['client:cb:slack'] } }, identities: { 'client:ca:meta': { origins: ['https://facebook.com'] }, 'client:cb:slack': { origins: ['https://slack.com'] } } };
  const sites = { sites: { slack: { label: 'Slack', origins: ['https://slack.com'], loggedIn: { url: 'https://slack.com/home', expect: 'Home' }, confirm: [], redact: [], destructive: { selectors: [], text: [] } } } };
  const { dispatch } = createDispatcher({ authenticate: defs.auth, browser: createFakeBrowser({ 'https://slack.com/home': { text: 'Home' } }), policy, sites, clock: defs.clock, evidenceDir: defs.evidenceDir });
  const r = await dispatch({ cmd: 'open', token: 'valid', issue: 'PAR-1234', identity: 'client:cb:slack' });
  assert.equal(r.exit, EXIT.REFUSED_BY_POLICY); assert(r.reason.includes('identity not allowed'));
});
