'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EXIT } = require('../src/exit-codes.cjs');
const { checkFill } = require('../src/fill-rules.cjs');

const testCases = [
  // Rule a: field missing/not an object
  { field: undefined, pageUrl: 'https://ex.com/page', site: { loggedIn: { url: 'https://ex.com/admin' } }, ok: false, reason: 'field_unknown', desc: 'field undefined' },
  { field: null, pageUrl: 'https://ex.com/page', site: { loggedIn: { url: 'https://ex.com/admin' } }, ok: false, reason: 'field_unknown', desc: 'field null' },
  { field: 'string', pageUrl: 'https://ex.com/page', site: { loggedIn: { url: 'https://ex.com/admin' } }, ok: false, reason: 'field_unknown', desc: 'field not object' },

  // Rule b: type === 'password'
  { field: { type: 'password' }, pageUrl: 'https://ex.com/page', site: { loggedIn: { url: 'https://ex.com/admin' } }, ok: false, reason: 'password_field_refused', desc: 'type password' },
  { field: { type: 'PASSWORD' }, pageUrl: 'https://ex.com/page', site: { loggedIn: { url: 'https://ex.com/admin' } }, ok: false, reason: 'password_field_refused', desc: 'type PASSWORD uppercase' },

  // Rule c: autocomplete contains 'password'
  { field: { type: 'text', autocomplete: 'current-password' }, pageUrl: 'https://ex.com/page', site: { loggedIn: { url: 'https://ex.com/admin' } }, ok: false, reason: 'password_field_refused', desc: 'autocomplete current-password' },
  { field: { type: 'text', autocomplete: 'new-password' }, pageUrl: 'https://ex.com/page', site: { loggedIn: { url: 'https://ex.com/admin' } }, ok: false, reason: 'password_field_refused', desc: 'autocomplete new-password' },
  { field: { type: 'text', autocomplete: 'password-something' }, pageUrl: 'https://ex.com/page', site: { loggedIn: { url: 'https://ex.com/admin' } }, ok: false, reason: 'password_field_refused', desc: 'autocomplete password substring' },
  { field: { type: 'text', autocomplete: 'on' }, pageUrl: 'https://ex.com/page', site: { loggedIn: { url: 'https://ex.com/admin' } }, ok: true, desc: 'autocomplete on is ok' },

  // Rule d: page URL checks
  { field: { type: 'text' }, pageUrl: 'https://ex.com/page', site: { loggedIn: { url: 'https://ex.com/admin' } }, ok: true, desc: 'non-login page same origin different path' },
  { field: { type: 'text' }, pageUrl: 'https://ex.com/admin', site: { loggedIn: { url: 'https://ex.com/admin' } }, ok: false, reason: 'fill_on_logged_in_page', desc: 'exact login page URL' },
  { field: { type: 'text' }, pageUrl: 'https://ex.com/admin/settings', site: { loggedIn: { url: 'https://ex.com/admin' } }, ok: false, reason: 'fill_on_logged_in_page', desc: 'pathname starts with admin' },
  { field: { type: 'text' }, pageUrl: 'https://ex.com/admin/', site: { loggedIn: { url: 'https://ex.com/admin' } }, ok: false, reason: 'fill_on_logged_in_page', desc: 'trailing slash ignored' },
  { field: { type: 'text' }, pageUrl: 'https://other.com/admin', site: { loggedIn: { url: 'https://ex.com/admin' } }, ok: true, desc: 'different origin not treated as logged-in' },
  { field: { type: 'text' }, pageUrl: 'https://ex.com/page', site: { loggedIn: { url: '/admin' } }, ok: true, desc: 'relative URL non-login path' },
  { field: { type: 'text' }, pageUrl: 'https://ex.com/admin/page', site: { loggedIn: { url: '/admin' } }, ok: false, reason: 'fill_on_logged_in_page', desc: 'relative URL login path' },
  { field: { type: 'text' }, pageUrl: 'https://ex.com/admin', site: { loggedIn: { url: '/admin/' } }, ok: false, reason: 'fill_on_logged_in_page', desc: 'relative URL with trailing slash' },
  { field: { type: 'text' }, pageUrl: 'not-a-url', site: { loggedIn: { url: 'https://ex.com/admin' } }, ok: false, reason: 'fill_on_logged_in_page', desc: 'unparsable pageUrl' },
  { field: { type: 'text' }, pageUrl: 'https://ex.com/page', site: { loggedIn: {} }, ok: false, reason: 'fill_on_logged_in_page', desc: 'missing loggedIn.url' },
  { field: { type: 'text' }, pageUrl: 'https://ex.com/page', site: {}, ok: false, reason: 'fill_on_logged_in_page', desc: 'missing loggedIn' },
  { field: { type: 'text' }, pageUrl: 'https://ex.com/page', site: null, ok: false, reason: 'fill_on_logged_in_page', desc: 'missing site' },

  // Hand-off mode: lifts all restrictions
  { field: { type: 'password' }, pageUrl: 'https://ex.com/admin', site: { loggedIn: { url: 'https://ex.com/admin' } }, handoffActive: true, ok: true, desc: 'handoff allows password on login page' },
];

testCases.forEach(({ field, pageUrl, site, handoffActive, ok, reason, desc }) => {
  test(`fill - ${desc}`, () => {
    const result = checkFill({ field, pageUrl, site, handoffActive });
    assert.equal(result.ok, ok, `expected ok=${ok}, got ${result.ok}`);
    if (!ok) {
      assert.equal(result.reason, reason, `expected reason=${reason}, got ${result.reason}`);
      assert.equal(result.exit, EXIT.REFUSED_BY_POLICY, `expected exit=${EXIT.REFUSED_BY_POLICY}, got ${result.exit}`);
    }
  });
});
