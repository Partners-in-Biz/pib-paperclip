'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createPlaywrightBrowser } = require('../src/driver-playwright.cjs');

async function launchOpts(env) {
  let opts = null;
  const fakePage = { url: () => 'about:blank', goto: async () => {}, on: () => {}, close: async () => {} };
  const fakeContext = {
    pages: () => [fakePage], newPage: async () => fakePage,
    route: async () => {}, on: () => {}, close: async () => {}
  };
  const pw = { chromium: { launchPersistentContext: async (_p, o) => { opts = o; return fakeContext; } } };
  const browser = createPlaywrightBrowser({ playwright: pw, profileRoot: '/tmp', env });
  const ctx = browser.newContext({ origins: ['https://example.com'], guard: () => true });
  await ctx.goto('https://example.com');
  return opts;
}

test('fake mic and mobile are env-gated', async (t) => {
  await t.test('off by default', async () => {
    const o = await launchOpts({});
    assert.deepEqual(o.permissions, []);
    assert.deepEqual(o.args, []);
    assert.equal(o.isMobile, undefined);
  });
  await t.test('PIB_BROWSER_FAKE_MIC=1', async () => {
    const o = await launchOpts({ PIB_BROWSER_FAKE_MIC: '1' });
    assert.deepEqual(o.permissions, ['microphone']);
    assert.ok(o.args.includes('--use-fake-device-for-media-stream'));
    assert.ok(o.args.includes('--use-fake-ui-for-media-stream'));
  });
  await t.test('PIB_BROWSER_MOBILE=1', async () => {
    const o = await launchOpts({ PIB_BROWSER_MOBILE: '1' });
    assert.deepEqual(o.viewport, { width: 390, height: 844 });
    assert.equal(o.isMobile, true);
    assert.equal(o.hasTouch, true);
  });
});
