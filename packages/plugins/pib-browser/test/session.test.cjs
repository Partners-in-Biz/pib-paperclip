'use strict';
// PAR-9187: session survives goto/click/close, write clicks without --approval
// refuse with exit 8, and driver errors name their cause in an agent-readable log.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EXIT } = require('../src/exit-codes.cjs');
const { createDispatcher } = require('../src/dispatch.cjs');
const { createErrorLog, summarise } = require('../src/errlog.cjs');
const { createPlaywrightBrowser } = require('../src/driver-playwright.cjs');
const { createFakeBrowser } = require('./fake-browser.cjs');

const sites = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'sites.json'), 'utf8'));
const DASH = 'https://paperclip.partnersinbiz.online/PAR/dashboard';
const ISSUE_URL = 'https://paperclip.partnersinbiz.online/PAR/issues/PAR-3917';
const ID = 'pib:paperclip';
const req = (cmd, args) => ({ cmd, token: 'pcp_test_token_value', issue: 'PAR-3917', identity: ID, args });

// Wrap the fake browser so tests can inject a label lookup and driver failures.
function harness({ label, clickError, gotoError } = {}) {
  const fake = createFakeBrowser({
    [DASH]: { text: 'New task' },
    [ISSUE_URL]: { text: 'PAR-3917 Save' }
  });
  const recorded = [];
  const browser = {
    newContext(opts) {
      const ctx = fake.newContext(opts);
      const clicks = [];
      ctx.clicks = () => clicks;
      const origClick = ctx.click;
      ctx.click = async (sel, txt) => {
        if (clickError) throw clickError();
        clicks.push(sel);
        return origClick(sel, txt);
      };
      const origGoto = ctx.goto;
      ctx.goto = async (u) => {
        if (gotoError && u === ISSUE_URL) throw gotoError();
        return origGoto(u);
      };
      if (label) ctx.label = async () => label;
      return ctx;
    },
    lastContext: () => fake.lastContext()
  };
  const { dispatch, sessions } = createDispatcher({
    authenticate: async () => ({ ok: true, agentId: 'a1', companyId: 'ca', issue: { id: 'i1', identifier: 'PAR-3917', companyId: 'ca' } }),
    browser,
    policy: { version: 1, agents: { a1: { identities: [ID] } }, identities: {} },
    sites,
    clock: () => new Date('2026-11-11T10:00:00Z'),
    errorLog: { record: (e) => recorded.push(e) }
  });
  return { dispatch, sessions, browser, recorded, key: `a1|${ID}` };
}

test('repro: open, goto, click Save without --approval => exit 8, session survives, close => 0', async () => {
  const h = harness();
  assert.equal((await h.dispatch(req('open'))).exit, EXIT.DONE);
  assert.equal((await h.dispatch(req('goto', { url: ISSUE_URL }))).exit, EXIT.DONE);
  const r = await h.dispatch(req('click', { selector: 'button:has-text(Save)' }));
  assert.equal(r.exit, EXIT.NEEDS_APPROVAL);
  assert.equal(r.reason, 'needs_approval');
  assert.deepEqual(h.browser.lastContext().clicks(), [], 'click must not reach the page');
  assert.equal(h.sessions.has(h.key), true, 'session survives the refusal');
  assert.equal((await h.dispatch(req('close'))).exit, EXIT.DONE);
  assert.equal(h.sessions.has(h.key), false);
});

test('click whose element label is a write word needs approval even with a neutral selector', async () => {
  const h = harness({ label: 'Save changes' });
  await h.dispatch(req('open'));
  const r = await h.dispatch(req('click', { selector: '#btn-3' }));
  assert.equal(r.exit, EXIT.NEEDS_APPROVAL);
  assert.deepEqual(h.browser.lastContext().clicks(), []);
});

test('neutral click with neutral label goes through', async () => {
  const h = harness({ label: 'Comments' });
  await h.dispatch(req('open'));
  const r = await h.dispatch(req('click', { selector: '#tab-comments' }));
  assert.equal(r.exit, EXIT.DONE);
  assert.deepEqual(h.browser.lastContext().clicks(), ['#tab-comments']);
});

test('click timeout => exit 4 timeout, session kept, cause logged without token', async () => {
  const h = harness({
    clickError: () => Object.assign(new Error('locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for <div>secret page text</div>'), { name: 'TimeoutError' })
  });
  await h.dispatch(req('open'));
  const r = await h.dispatch(req('click', { selector: '#tab-comments' }));
  assert.equal(r.exit, EXIT.EXPECT_MISSING);
  assert.equal(r.reason, 'timeout');
  assert.equal(h.sessions.has(h.key), true);
  assert.equal(h.recorded.length, 1);
  assert.equal(h.recorded[0].cmd, 'click');
  assert.equal(h.recorded[0].phase, 'click');
  assert.equal(JSON.stringify(h.recorded[0]).includes('pcp_test_token_value'), false);
});

test('strict-mode violation => exit 4 target_ambiguous, session kept', async () => {
  const h = harness({ clickError: () => new Error('locator.click: Error: strict mode violation: resolved to 3 elements') });
  await h.dispatch(req('open'));
  const r = await h.dispatch(req('click', { selector: '#x' }));
  assert.equal(r.exit, EXIT.EXPECT_MISSING);
  assert.equal(r.reason, 'target_ambiguous');
  assert.equal(h.sessions.has(h.key), true);
});

test('closed browser => exit 3 browser_closed and session dropped', async () => {
  const h = harness({ gotoError: () => Object.assign(new Error('page.goto: Target page, context or browser has been closed'), { name: 'TargetClosedError' }) });
  await h.dispatch(req('open'));
  const r = await h.dispatch(req('goto', { url: ISSUE_URL }));
  assert.equal(r.exit, EXIT.NO_BROWSER);
  assert.equal(r.reason, 'browser_closed');
  assert.equal(h.sessions.has(h.key), false);
});

test('open failure names the cause instead of bare "internal" and is logged', async () => {
  const recorded = [];
  const { dispatch } = createDispatcher({
    authenticate: async () => ({ ok: true, agentId: 'a1', companyId: 'ca', issue: { id: 'i1', identifier: 'PAR-3917', companyId: 'ca' } }),
    browser: { newContext: () => ({ goto: async () => { throw Object.assign(new Error('launch failed: /tmp read-only'), { code: 'NO_BROWSER' }); }, close: async () => {} }) },
    policy: { version: 1, agents: { a1: { identities: [ID] } }, identities: {} },
    sites,
    clock: () => new Date(),
    errorLog: { record: (e) => recorded.push(e) }
  });
  const r = await dispatch(req('open'));
  assert.equal(r.exit, EXIT.NO_BROWSER);
  assert.equal(r.reason, 'browser_launch_failed');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].phase, 'open');
});

test('error log: JSON line, first message line only, secrets and query strings scrubbed', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'pib-errlog-'));
  try {
    const file = path.join(dir, 'errors.log');
    const log = createErrorLog({ path: file, clock: () => new Date('2026-11-11T10:00:00Z') });
    const err = new Error('goto https://x.example.com/a?token=abc#f failed Bearer abc.def pcp_live_123\n<div>page html</div>');
    log.record({ cmd: 'goto', issue: 'PAR-3917', identity: ID, phase: 'goto', error: err });
    const line = fs.readFileSync(file, 'utf8').trim();
    const entry = JSON.parse(line);
    assert.equal(entry.cmd, 'goto');
    assert.equal(entry.issue, 'PAR-3917');
    assert.equal(entry.error.name, 'Error');
    assert.ok(Array.isArray(entry.error.stack) && entry.error.stack.length > 0);
    for (const bad of ['token=abc', 'abc.def', 'pcp_live_123', 'page html', '#f'])
      assert.equal(line.includes(bad), false, `log leaked ${bad}`);
    assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('summarise handles non-Error rejections', () => {
  assert.equal(summarise('boom').message, 'boom');
  assert.equal(summarise(undefined).name, 'Error');
});

test('driver route handler swallows rejections from continue/abort (no unhandled rejection)', async () => {
  let routeHandler;
  const page = { on: () => {}, mainFrame: () => ({}), url: () => 'about:blank', goto: async () => {} };
  const context = {
    pages: () => [page],
    route: async (_p, h) => { routeHandler = h; },
    on: () => {},
    close: async () => {}
  };
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'pib-drv-'));
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const browser = createPlaywrightBrowser({ playwright: { chromium: { launchPersistentContext: async () => context } }, profileRoot: dir });
    const ctx = browser.newContext({ origins: ['https://ok.example.com'], guard: (u) => u.startsWith('https://ok.example.com'), identity: ID });
    await ctx.goto('https://ok.example.com/');
    const closed = () => Promise.reject(new Error('Target page, context or browser has been closed'));
    await routeHandler({ request: () => ({ url: () => 'https://ok.example.com/x' }), continue: closed, abort: closed });
    await routeHandler({ request: () => ({ url: () => 'https://evil.example.com/x' }), continue: closed, abort: closed });
    await new Promise((r) => setImmediate(r));
    assert.equal(unhandled.length, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
