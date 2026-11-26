'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDispatcher } = require('../src/dispatch.cjs');
const { createFakeBrowser } = require('./fake-browser.cjs');
const { run } = require('../src/cli.cjs');
const { EXIT } = require('../src/exit-codes.cjs');

test('cli: select needs selector and value, passes approval', async () => {
  const sent = [];
  const err = { w: '', write(d) { this.w += d; } };
  const deps = { send: async (r) => { sent.push(r); return { exit: 0, ok: true }; }, stdout: { write() {} }, stderr: err };
  const env = { PAPERCLIP_API_KEY: 't' };
  const base = ['--identity', 'client:ca:meta', '--issue', 'PAR-1234'];
  assert.equal(await run(['select', ...base, '--selector', 'select'], env, deps), 2);
  assert.equal(await run(['select', ...base, '--selector', 'select', '--value', 'Sam', '--approval', 'PAR-9'], env, deps), 0);
  assert.deepEqual(sent.at(-1).args, { selector: 'select', value: 'Sam', approval: 'PAR-9' });
});

test('driver select: real Chromium picks by label, falls back to value', async (t) => {
  let playwright;
  try { playwright = require('playwright-core'); } catch (e) { return t.skip('playwright not installed'); }
  const http = require('node:http');
  const srv = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end('<div id="d"></div><select id="s" onchange="d.textContent=this.value"><option value="">-</option><option value="a1">Alex</option><option value="s2">Sam</option></select>'); });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const { createPlaywrightBrowser } = require('../src/driver-playwright.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pibsel-'));
  const browser = createPlaywrightBrowser({ playwright, profileRoot: root, env: { ...process.env, PIB_BROWSER_HEADLESS: '1', ...(process.env.PIB_BROWSER_CHROMIUM ? {} : { PIB_BROWSER_CHROMIUM: ['/opt/pib-browser/ms-playwright/chromium-1248/chrome-linux64/chrome'].find((p) => fs.existsSync(p)) }) } });
  const ctx = browser.newContext({ origins: [url], guard: () => true, identity: 'test:sel' });
  try {
    try { await ctx.goto(url); } catch (e) { if (e.code === 'NO_BROWSER') return t.skip('no chromium'); throw e; }
    await ctx.select('select', 'Sam');
    assert.equal(await ctx.text('#d'), 's2');
    await ctx.select('select', 'a1');
    assert.equal(await ctx.text('#d'), 'a1');
  } finally { await ctx.close(); srv.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('dispatch: select is gated like click and never echoes the value', async () => {
  const { createDispatcher: cd } = require('../src/dispatch.cjs');
  const browser = createFakeBrowser({ 'https://business.facebook.com/latest/home': { text: 'Home' } });
  const { dispatch } = cd({
    authenticate: async () => ({ ok: true, agentId: 'a1', companyId: 'ca', issue: { id: 'i1', identifier: 'PAR-1234', companyId: 'ca' } }),
    browser,
    policy: { version: 1, agents: { a1: { identities: ['client:ca:meta'] } }, identities: { 'client:ca:meta': { origins: ['https://business.facebook.com'] } } },
    sites: { sites: { meta: { label: 'Meta', origins: ['https://business.facebook.com'], loggedIn: { url: 'https://business.facebook.com/latest/home', expect: 'Home' }, confirm: [], redact: [], destructive: { selectors: [], text: ['delete'] } } } },
    checkFill: () => ({ ok: true })
  });
  const call = (args) => dispatch({ cmd: 'select', token: 't', issue: 'PAR-1234', identity: 'client:ca:meta', args });
  await dispatch({ cmd: 'open', token: 't', issue: 'PAR-1234', identity: 'client:ca:meta', args: {} });
  assert.equal((await call({ selector: 'select' })).reason, 'selector_and_value_required');
  assert.equal((await call({ selector: 'select', value: 'Delete account' })).exit, EXIT.NEEDS_APPROVAL);
  const ok = await call({ selector: 'select', value: 'sk-secret-value-123' });
  assert.equal(ok.exit, EXIT.DONE);
  assert.ok(!JSON.stringify(ok).includes('sk-secret'));
  assert.deepEqual(browser.lastContext().performed().filter((p) => p.cmd === 'select'), [{ cmd: 'select', selector: 'select', value: 'sk-secret-value-123' }]);
});
