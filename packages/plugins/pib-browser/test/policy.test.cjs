'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { EXIT, exitName } = require('../src/exit-codes.cjs');
const { parseIdentity, validatePolicy, loadPolicy, originsFor, authorise, isDestructive } = require('../src/policy.cjs');
const { redactText, parseRegion } = require('../src/redact.cjs');
const validPolicy = {
  version: 1,
  agents: { 'a1': { identities: ['pib:meta', 'client:ca:wp'] }, 'a2': { identities: ['pib:ga', 'client:cb:wp'] } },
  identities: { 'pib:meta': { origins: ['https://business.facebook.com', 'https://www.facebook.com'] },
    'client:ca:wp': { origins: ['https://ca.example.com'] }, 'client:cb:wp': { origins: ['https://cb.example.com'] } }
};
const sitesFixture = {
  sites: { wp: { label: 'WordPress', origins: [], perIdentityOrigins: true, loggedIn: { url: '/wp-admin/', expect: 'Dashboard' },
    confirm: [{ step: 'test', expect: 'Dashboard' }], redact: ['input[type=password]', '[data-pib-redact]'],
    destructive: { selectors: ['[data-action=delete]', '#publish'], text: ['delete', 'publish'] } } }
};
[['pib:meta', { kind: 'pib', svc: 'meta' }, 'valid pib'],
  ['client:c-123:wp', { kind: 'client', companyId: 'c-123', svc: 'wp' }, 'valid client'],
  ['canary:wp', { kind: 'canary', svc: 'wp' }, 'valid canary'],
  ['invalid', null, 'bad format'], ['pib:', null, 'empty svc'], ['pib:a:b', null, 'too many'],
  [null, null, 'non-string']
].forEach(([i, e, l]) => { test(`parseIdentity - ${l}`, () => { assert.deepEqual(parseIdentity(i), e); }); });
[
  [validPolicy, true, 'valid'],
  [{ agents: {}, identities: {} }, false, 'no version'],
  [{ version: 2, agents: {}, identities: {} }, false, 'wrong version'],
  [{ version: 1, identities: {} }, false, 'no agents'],
  [{ version: 1, agents: { 'a': { identities: ['bad::'] } }, identities: {} }, false, 'bad identity'],
  [{ version: 1, agents: {}, identities: { 'p:m': { origins: ['not-url'] } } }, false, 'bad URL'],
  [{ version: 1, agents: {}, identities: { 'p:m': { origins: ['https://example.com/path'] } } }, false, 'URL with path'],
  [{ version: 1, agents: {}, identities: { 'p:m': { origins: ['http://example.com'] } } }, false, 'http no localhost'],
  [{ version: 1, agents: {}, identities: { 'p:m': { origins: ['http://localhost:8000'] } } }, true, 'http localhost ok'],
  [{ version: 1, agents: { '__proto__': { identities: ['p:m'] } }, identities: {} }, false, '__proto__ guard']
].forEach(([p, ok, l]) => { test(`validatePolicy - ${l}`, () => { assert.equal(validatePolicy(p).ok, ok); }); });
const noSitesPolicy = {
  version: 1, agents: { 'a': { identities: ['pib:ns'] } }, identities: { 'pib:ns': { origins: ['https://ex.com'] } }
};
[
  [{ policy: validPolicy, agentId: 'unknown', identity: 'pib:meta', url: 'https://business.facebook.com' }, EXIT.REFUSED_BY_POLICY, 'unknown agent'],
  [{ policy: validPolicy, agentId: 'a1', identity: 'pib:ga', url: 'https://ads.google.com' }, EXIT.REFUSED_BY_POLICY, 'identity not for agent'],
  [{ policy: validPolicy, agentId: 'a1', identity: 'pib:meta', url: 'https://other.com' }, EXIT.REFUSED_BY_POLICY, 'origin denied'],
  [{ policy: validPolicy, agentId: 'a1', identity: 'client:ca:wp', url: 'https://cb.example.com' }, EXIT.REFUSED_BY_POLICY, 'ca to cb denied'],
  [{ policy: { version: 1, agents: { 'a': { identities: ['p:m'] } }, identities: { 'p:m': { origins: ['https://ex.com'] } } },
    agentId: 'a', identity: 'p:m', url: 'https://..ex.com' }, EXIT.REFUSED_BY_POLICY, 'double-dot'],
  [{ policy: { version: 1, agents: { 'a': { identities: ['p:m'] } }, identities: { 'p:m': { origins: ['https://ex.com'] } } },
    agentId: 'a', identity: 'p:m', url: 'https://ex.com@evil.io' }, EXIT.REFUSED_BY_POLICY, '@ separator'],
  [{ policy: { version: 1, agents: { 'a': { identities: ['p:m'] } }, identities: { 'p:m': { origins: ['http://ex.com'] } } },
    agentId: 'a', identity: 'p:m', url: 'http://ex.com' }, EXIT.REFUSED_BY_POLICY, 'http no localhost'],
  [{ policy: validPolicy, agentId: 'a1', identity: 'pib:meta', url: 'https://business.facebook.com' }, 0, 'valid'],
  [{ policy: { version: 1, agents: { 'a': { identities: ['pib:m'] } }, identities: { 'pib:m': { origins: ['https://ex.com:8443'] } } },
    agentId: 'a', identity: 'pib:m', url: 'https://ex.com:8443' }, 0, 'with port'],
  [{ policy: validPolicy, agentId: 'a1', identity: 'client:ca:wp', url: 'https://ca.example.com',
    sites: sitesFixture, click: { selector: '#publish', text: 'Publish' } }, EXIT.NEEDS_APPROVAL, 'destructive'],
  [{ policy: validPolicy, agentId: 'a1', identity: 'client:ca:wp', url: 'https://ca.example.com',
    sites: sitesFixture, click: { selector: '#publish' }, approved: true }, 0, 'destructive approved'],
  [{ policy: validPolicy, agentId: 'a1', identity: 'client:ca:wp', url: 'https://ca.example.com',
    sites: sitesFixture, click: { selector: 'button.save', text: 'Save' } }, 0, 'non-destructive'],
  [{ policy: { version: 2, agents: {}, identities: {} }, agentId: 'a', identity: 'p:m', url: 'https://ex.com' },
    EXIT.REFUSED_BY_POLICY, 'invalid policy blocks'],
  [{ policy: validPolicy, agentId: 'a1', identity: 'pib:meta', url: 'https://user:pass@business.facebook.com' },
    EXIT.REFUSED_BY_POLICY, 'credentials in url'],
  [{ policy: validPolicy, agentId: 'a1', identity: 'client:ca:wp', url: 'https://ca.example.com', click: { selector: '#publish' } },
    EXIT.NEEDS_APPROVAL, 'click no sites'],
  [{ policy: noSitesPolicy, agentId: 'a', identity: 'pib:ns', url: 'https://ex.com', sites: sitesFixture, click: { selector: '#publish' } },
    EXIT.NEEDS_APPROVAL, 'click no entry'],
  [{ policy: noSitesPolicy, agentId: 'a', identity: 'pib:ns', url: 'https://ex.com', sites: sitesFixture, click: { selector: '#publish' }, approved: true },
    EXIT.NEEDS_APPROVAL, 'click no entry approved fails']
].forEach(([p, e, l]) => { test(`authorise - ${l}`, () => {
  const r = authorise(p);
  if (e === 0) assert.equal(r.ok, true, `Expected ok but got ${r.exit}`);
  else assert.equal(r.exit, e, `Expected ${e} but got ${r.exit}`);
}); });
[
  [{ destructive: { selectors: ['#publish'], text: ['publish'] } }, { selector: '#publish' }, true, 'selector'],
  [{ destructive: { selectors: ['#publish'], text: ['publish', 'delete'] } }, { text: 'Publish Now' }, true, 'text case'],
  [{ destructive: { selectors: ['#publish'], text: ['publish'] } }, { selector: '#save', text: 'Save' }, false, 'no match'],
  [{ label: 'Test' }, { selector: '#any', text: 'any' }, false, 'no destructive']
].forEach(([s, c, e, l]) => { test(`isDestructive - ${l}`, () => { assert.equal(isDestructive(s, c), e); }); });
test('loadPolicy - valid file', () => {
  const f = '/tmp/test-policy-pib.json';
  fs.writeFileSync(f, JSON.stringify(validPolicy));
  const r = loadPolicy(f);
  assert.equal(r.ok, true);
  assert.deepEqual(r.policy, validPolicy);
  fs.unlinkSync(f);
});
test('loadPolicy - missing', () => {
  assert.equal(loadPolicy('/tmp/nonexistent-pib.json').reason, 'policy file not found');
});
test('loadPolicy - invalid JSON', () => {
  const f = '/tmp/bad-pib.json';
  fs.writeFileSync(f, 'not json');
  const r = loadPolicy(f);
  assert.equal(r.ok, false);
  fs.unlinkSync(f);
});
test('loadPolicy - invalid content', () => {
  const f = '/tmp/inv-pib.json';
  fs.writeFileSync(f, JSON.stringify({ version: 2 }));
  const r = loadPolicy(f);
  assert.equal(r.ok, false);
  fs.unlinkSync(f);
});
test('validatePolicy - no echo identity', () => {
  const r = validatePolicy({ version: 1, agents: { 'a': { identities: ['bad-id'] } }, identities: {} });
  assert.equal(r.ok, false);
  assert(!r.reason.includes('bad-id'));
});
test('authorise - no echo url', () => {
  const r = authorise({ policy: validPolicy, agentId: 'a1', identity: 'pib:meta', url: 'https://secret.com' });
  assert.equal(r.exit, EXIT.REFUSED_BY_POLICY);
  assert(!r.reason.includes('secret'));
});
test('EXIT codes', () => {
  assert.deepEqual(Object.values(EXIT).sort((a, b) => a - b), [0, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(Object.isFrozen(EXIT), true);
});
test('exitName maps', () => {
  assert.equal(exitName(0), 'done');
  assert.equal(exitName(8), 'needs_approval');
  assert.equal(exitName(999), undefined);
});
test('sites.json schema', () => {
  const sites = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../sites.json'), 'utf8'));
  assert.equal(sites.version, 1);
  for (const svc in sites.sites) {
    const s = sites.sites[svc];
    assert(Array.isArray(s.origins) || s.perIdentityOrigins, `${svc} missing origins`);
    assert(s.loggedIn?.url && s.loggedIn?.expect, `${svc} missing loggedIn`);
    assert(Array.isArray(s.confirm) && s.confirm.length > 0, `${svc} missing confirm`);
    assert(Array.isArray(s.redact) && s.redact.length >= 2, `${svc} needs redact`);
    assert(s.destructive?.selectors && s.destructive?.text, `${svc} missing destructive`);
  }
});
test('sites.json no accounts.google.com', () => {
  const sites = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../sites.json'), 'utf8'));
  for (const svc in sites.sites) {
    const o = sites.sites[svc].origins;
    if (Array.isArray(o)) assert(!o.some(x => x.includes('accounts.google.com')), `${svc} lists accounts.google.com`);
  }
});
test('redactText - bearer', () => { assert(redactText('Authorization: Bearer abc123').includes('[redacted]')); });
test('redactText - password', () => { assert(redactText('password=hunter2').includes('[redacted]')); });
test('redactText - jwt', () => { assert(redactText('token is aaaa.bbbb.cccc').includes('[redacted]')); });
test('redactText - non-string', () => { assert.equal(redactText(null), ''); assert.equal(redactText(123), ''); });
test('parseRegion - valid', () => { assert.deepEqual(parseRegion('10,20,100,200'), { x: 10, y: 20, w: 100, h: 200 }); });
test('parseRegion - negative', () => { assert.equal(parseRegion('-1,0,100,100'), null); assert.equal(parseRegion('0,0,0,100'), null); });
test('parseRegion - too large', () => { assert.equal(parseRegion('0,0,20001,100'), null); });
test('parseRegion - bad format', () => { assert.equal(parseRegion('10,20,100'), null); assert.equal(parseRegion('not,a,number,here'), null); });
test('CI workflow includes pib-browser', () => {
  const content = fs.readFileSync(path.resolve(__dirname, '../../../../.github/workflows/pib-plugins-ci.yml'), 'utf8');
  assert(content.includes('pib-browser'), 'CI workflow must include pib-browser');
});
