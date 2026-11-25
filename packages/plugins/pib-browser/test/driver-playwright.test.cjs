'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createPlaywrightBrowser } = require('../src/driver-playwright.cjs');

test('driver-playwright', async (t) => {
  await t.test('requiring module does not launch browser', () => {
    assert.ok(typeof createPlaywrightBrowser === 'function');
  });

  await t.test('launch failure throws error with code NO_BROWSER', async () => {
    const fakePw = {
      chromium: {
        launchPersistentContext: async () => {
          throw new Error('Failed to launch');
        }
      }
    };

    const browser = createPlaywrightBrowser({ playwright: fakePw, profileRoot: '/tmp' });

    let errorCode = null;
    try {
      const ctx = browser.newContext({ origins: ['https://example.com'], guard: () => true });
      await ctx.goto('https://example.com');
    } catch (e) {
      errorCode = e.code;
    }

    assert.equal(errorCode, 'NO_BROWSER');
  });

  await t.test('ctx has exactly the expected interface keys', async () => {
    const fakePage = {
      url: () => 'https://example.com',
      goto: async () => {},
      locator: () => ({
        click: async () => {},
        fill: async () => {},
        innerText: async () => '',
        getAttribute: async () => null,
        first: () => ({ getAttribute: async () => null }),
        filter: () => ({ click: async () => {} })
      }),
      on: () => {},
      screenshot: async () => {},
      mainFrame: () => ({})
    };

    const fakeContext = {
      pages: () => [fakePage],
      route: async () => {},
      on: () => {},
      close: async () => {}
    };

    const fakePw = {
      chromium: {
        launchPersistentContext: async () => fakeContext
      }
    };

    const browser = createPlaywrightBrowser({ playwright: fakePw, profileRoot: '/tmp' });
    const ctx = browser.newContext({ origins: ['https://example.com'], guard: () => true });

    const keys = Object.keys(ctx).sort();
    const expected = [
      'click', 'close', 'describe', 'fill', 'goto', 'hasText', 'label', 'shot', 'text', 'url', 'violations'
    ].sort();

    assert.deepEqual(keys, expected);
  });

  await t.test('disallowed request is aborted and recorded in violations', async () => {
    let routeHandler = null;

    const fakePage = {
      url: () => 'https://example.com',
      goto: async () => {},
      locator: () => ({
        click: async () => {},
        fill: async () => {},
        innerText: async () => 'loaded',
        getAttribute: async () => null,
        first: () => ({ getAttribute: async () => null }),
        filter: () => ({ click: async () => {} })
      }),
      on: () => {},
      screenshot: async () => {},
      mainFrame: () => ({})
    };

    const fakeContext = {
      pages: () => [fakePage],
      route: async (pattern, handler) => {
        routeHandler = handler;
      },
      on: () => {},
      close: async () => {}
    };

    const fakePw = {
      chromium: {
        launchPersistentContext: async () => fakeContext
      }
    };

    const browser = createPlaywrightBrowser({ playwright: fakePw, profileRoot: '/tmp' });
    const guard = (url) => !url.includes('disallowed');
    const ctx = browser.newContext({ origins: ['https://example.com'], guard });

    await ctx.goto('https://example.com');

    const aborted = [];
    const mockRoute = {
      request: () => ({ url: () => 'https://disallowed.com/path' }),
      abort: () => aborted.push(true),
      continue: () => {}
    };

    await routeHandler(mockRoute);

    const violations = ctx.violations();
    assert.ok(violations.length > 0);
    assert.equal(violations[0].url, 'https://disallowed.com/path');
    assert.ok(aborted.length > 0);
  });

  await t.test('allowed request is continued', async () => {
    let routeHandler = null;

    const fakePage = {
      url: () => 'https://example.com',
      goto: async () => {},
      locator: () => ({
        click: async () => {},
        fill: async () => {},
        innerText: async () => 'loaded',
        getAttribute: async () => null,
        first: () => ({ getAttribute: async () => null }),
        filter: () => ({ click: async () => {} })
      }),
      on: () => {},
      screenshot: async () => {},
      mainFrame: () => ({})
    };

    const fakeContext = {
      pages: () => [fakePage],
      route: async (pattern, handler) => {
        routeHandler = handler;
      },
      on: () => {},
      close: async () => {}
    };

    const fakePw = {
      chromium: {
        launchPersistentContext: async () => fakeContext
      }
    };

    const browser = createPlaywrightBrowser({ playwright: fakePw, profileRoot: '/tmp' });
    const guard = () => true;
    const ctx = browser.newContext({ origins: ['https://example.com'], guard });

    await ctx.goto('https://example.com');

    const continued = [];
    const mockRoute = {
      request: () => ({ url: () => 'https://example.com/resource' }),
      abort: () => {},
      continue: () => continued.push(true)
    };

    await routeHandler(mockRoute);

    assert.ok(continued.length > 0);
    assert.equal(ctx.violations().length, 0);
  });

  await t.test('popup to disallowed origin is closed and recorded', async () => {
    let pageHandler = null;

    const fakePage = {
      url: () => 'https://example.com',
      goto: async () => {},
      locator: () => ({
        click: async () => {},
        fill: async () => {},
        innerText: async () => 'loaded',
        getAttribute: async () => null,
        first: () => ({ getAttribute: async () => null }),
        filter: () => ({ click: async () => {} })
      }),
      on: () => {},
      screenshot: async () => {},
      mainFrame: () => ({})
    };

    const fakeContext = {
      pages: () => [fakePage],
      route: async () => {},
      on: (event, handler) => {
        if (event === 'page') pageHandler = handler;
      },
      close: async () => {}
    };

    const fakePw = {
      chromium: {
        launchPersistentContext: async () => fakeContext
      }
    };

    const browser = createPlaywrightBrowser({ playwright: fakePw, profileRoot: '/tmp' });
    const guard = (url) => url.includes('example.com');
    const ctx = browser.newContext({ origins: ['https://example.com'], guard });

    await ctx.goto('https://example.com');

    const closed = [];
    const popup = {
      url: () => 'https://evil.com',
      close: () => closed.push(true)
    };

    await pageHandler(popup);

    const violations = ctx.violations();
    assert.ok(violations.some(v => v.kind === 'popup'));
    assert.ok(closed.length > 0);
  });

  await t.test('query string and fragment stripped from violations', async () => {
    let routeHandler = null;

    const fakePage = {
      url: () => 'https://example.com',
      goto: async () => {},
      locator: () => ({
        click: async () => {},
        fill: async () => {},
        innerText: async () => 'loaded',
        getAttribute: async () => null,
        first: () => ({ getAttribute: async () => null }),
        filter: () => ({ click: async () => {} })
      }),
      on: () => {},
      screenshot: async () => {},
      mainFrame: () => ({})
    };

    const fakeContext = {
      pages: () => [fakePage],
      route: async (pattern, handler) => {
        routeHandler = handler;
      },
      on: () => {},
      close: async () => {}
    };

    const fakePw = {
      chromium: {
        launchPersistentContext: async () => fakeContext
      }
    };

    const browser = createPlaywrightBrowser({ playwright: fakePw, profileRoot: '/tmp' });
    const ctx = browser.newContext({ origins: [], guard: () => false });

    await ctx.goto('https://example.com');

    const mockRoute = {
      request: () => ({ url: () => 'https://example.com/page?token=secret&user=bob#section' }),
      abort: () => {},
      continue: () => {}
    };

    await routeHandler(mockRoute);

    const violations = ctx.violations();
    assert.equal(violations[0].url, 'https://example.com/page');
    assert.ok(!violations[0].url.includes('token'));
    assert.ok(!violations[0].url.includes('section'));
  });

  await t.test('shot passes region as clip parameter', async () => {
    const captureOpts = {};
    const fakePage = {
      url: () => 'https://example.com',
      goto: async () => {},
      locator: () => ({
        click: async () => {},
        fill: async () => {},
        innerText: async () => 'loaded',
        getAttribute: async () => null,
        first: () => ({ getAttribute: async () => null }),
        filter: () => ({ click: async () => {} })
      }),
      on: () => {},
      screenshot: async (opts) => {
        Object.assign(captureOpts, opts);
      },
      mainFrame: () => ({})
    };

    const fakeContext = {
      pages: () => [fakePage],
      route: async () => {},
      on: () => {},
      close: async () => {}
    };

    const fakePw = {
      chromium: {
        launchPersistentContext: async () => fakeContext
      }
    };

    const browser = createPlaywrightBrowser({ playwright: fakePw, profileRoot: '/tmp' });
    const ctx = browser.newContext({ origins: ['https://example.com'], guard: () => true });

    await ctx.shot('/tmp/test.png', { region: { x: 10, y: 20, w: 100, h: 50 } });

    assert.equal(captureOpts.clip.x, 10);
    assert.equal(captureOpts.clip.y, 20);
    assert.equal(captureOpts.clip.width, 100);
    assert.equal(captureOpts.clip.height, 50);
    assert.equal(captureOpts.fullPage, false);
    assert.equal(captureOpts.maskColor, '#000000');
  });

  await t.test('shot passes redactSelectors as mask locators', async () => {
    const captureOpts = {};
    const locators = [];

    const fakePage = {
      url: () => 'https://example.com',
      goto: async () => {},
      locator: (sel) => {
        const locator = {
          click: async () => {},
          fill: async () => {},
          innerText: async () => 'loaded',
          getAttribute: async () => null,
          first: () => ({ getAttribute: async () => null }),
          filter: () => ({ click: async () => {} })
        };
        if (sel.includes('password') || sel.includes('token')) {
          locators.push(sel);
        }
        return locator;
      },
      on: () => {},
      screenshot: async (opts) => {
        Object.assign(captureOpts, opts);
      },
      mainFrame: () => ({})
    };

    const fakeContext = {
      pages: () => [fakePage],
      route: async () => {},
      on: () => {},
      close: async () => {}
    };

    const fakePw = {
      chromium: {
        launchPersistentContext: async () => fakeContext
      }
    };

    const browser = createPlaywrightBrowser({ playwright: fakePw, profileRoot: '/tmp' });
    const ctx = browser.newContext({ origins: ['https://example.com'], guard: () => true });

    await ctx.shot('/tmp/test.png', { redactSelectors: ['[type=password]', '[data-sensitive]'] });

    assert.ok(captureOpts.mask);
    assert.ok(Array.isArray(captureOpts.mask));
    assert.ok(captureOpts.mask.length > 0);
  });

  await t.test('launch options include serviceWorkers:block and acceptDownloads:false', async () => {
    const launchOpts = {};

    const fakePw = {
      chromium: {
        launchPersistentContext: async (profilePath, opts) => {
          Object.assign(launchOpts, opts);
          return {
            pages: () => [],
            newPage: async () => ({
              url: () => 'https://example.com',
              goto: async () => {},
              locator: () => ({
                click: async () => {},
                fill: async () => {},
                innerText: async () => 'loaded',
                getAttribute: async () => null,
                first: () => ({ getAttribute: async () => null }),
                filter: () => ({ click: async () => {} })
              }),
              on: () => {},
              screenshot: async () => {},
              mainFrame: () => ({})
            }),
            route: async () => {},
            on: () => {},
            close: async () => {}
          };
        }
      }
    };

    const browser = createPlaywrightBrowser({ playwright: fakePw, profileRoot: '/tmp' });
    const ctx = browser.newContext({ origins: ['https://example.com'], guard: () => true });

    await ctx.goto('https://example.com');

    assert.equal(launchOpts.serviceWorkers, 'block');
    assert.equal(launchOpts.acceptDownloads, false);
  });
});

test('driver-playwright on a live page (2026-11-12)', async (t) => {
  const { settleMs, isClosedTargetError } = require('../src/driver-playwright.cjs');
  const make = (page, env = {}) => {
    const fakeContext = { pages: () => [page], route: async () => {}, on: () => {}, close: async () => {} };
    const fakePw = { chromium: { launchPersistentContext: async () => fakeContext } };
    return createPlaywrightBrowser({ playwright: fakePw, profileRoot: '/tmp', env })
      .newContext({ origins: ['https://example.com'], guard: () => true });
  };
  const basePage = (over) => Object.assign({
    url: () => 'https://example.com',
    on: () => {}, screenshot: async () => {}, mainFrame: () => ({}),
    locator: () => ({ innerText: async () => '' })
  }, over);
  const closed = () => { const e = new Error('Target page, context or browser has been closed'); e.name = 'TargetClosedError'; return e; };

  await t.test('settleMs: empty and bad values give the default, 0 stays 0, the most is 30 s', () => {
    assert.equal(settleMs({}), 8000);
    for (const [raw, want] of [['', 8000], ['  ', 8000], ['0', 0], [0, 0], ['-1', 8000], ['abc', 8000], ['99999', 30000], ['2500', 2500], [undefined, 8000], [null, 8000]]) {
      assert.equal(settleMs({ PIB_BROWSER_SETTLE_MS: raw }), want, JSON.stringify(raw));
    }
  });

  await t.test('goto loads the document and does not fail when the network never goes idle', async () => {
    const calls = [];
    const ctx = make(basePage({
      goto: async (url, opts) => { calls.push(['goto', opts.waitUntil]); },
      waitForLoadState: async (state, opts) => { calls.push(['settle', state, opts.timeout]); throw new Error('Timeout 8000ms exceeded.'); }
    }));
    await ctx.goto('https://example.com');
    assert.deepEqual(calls, [['goto', 'domcontentloaded'], ['settle', 'networkidle', 8000]]);
  });

  await t.test('goto never passes timeout 0 to the settle wait (Playwright reads 0 as no timeout)', async () => {
    for (const raw of ['0', '']) {
      const calls = [];
      const ctx = make(basePage({
        goto: async () => { calls.push('goto'); },
        waitForLoadState: async (state, opts) => { calls.push(opts.timeout); }
      }), { PIB_BROWSER_SETTLE_MS: raw });
      await ctx.goto('https://example.com');
      assert.deepEqual(calls, raw === '0' ? ['goto'] : ['goto', 8000], JSON.stringify(raw));
    }
  });

  await t.test('goto lets a closed target through from the settle wait', async () => {
    const ctx = make(basePage({ goto: async () => {}, waitForLoadState: async () => { throw closed(); } }));
    await assert.rejects(() => ctx.goto('https://example.com'), (e) => isClosedTargetError(e));
  });

  await t.test('goto still reports a document that fails to load', async () => {
    const ctx = make(basePage({ goto: async () => { throw new Error('net::ERR_CONNECTION_REFUSED'); } }));
    await assert.rejects(() => ctx.goto('https://example.com'), /ERR_CONNECTION_REFUSED/);
  });

  await t.test('hasText reads once by default and waits when asked', async () => {
    let reads = 0;
    const ctx = make(basePage({
      goto: async () => {},
      locator: () => ({ innerText: async () => { reads += 1; return reads >= 3 ? 'Dashboard New task' : 'Loading'; } })
    }));
    await ctx.goto('https://example.com');
    assert.equal(await ctx.hasText('New task'), false);
    assert.equal(reads, 1);
    assert.equal(await ctx.hasText('New task', { timeoutMs: 3000 }), true);
    assert.equal(reads, 3);
  });

  await t.test('hasText with no option throws what the read throws, as before', async () => {
    const ctx = make(basePage({ goto: async () => {}, locator: () => ({ innerText: async () => { throw new Error('element detached'); } }) }));
    await ctx.goto('https://example.com');
    await assert.rejects(() => ctx.hasText('New task'), /element detached/);
  });

  await t.test('hasText lets a closed target through, with and without a wait', async () => {
    const ctx = make(basePage({ goto: async () => {}, locator: () => ({ innerText: async () => { throw closed(); } }) }));
    await ctx.goto('https://example.com');
    await assert.rejects(() => ctx.hasText('New task'), (e) => isClosedTargetError(e));
    await assert.rejects(() => ctx.hasText('New task', { timeoutMs: 2000 }), (e) => isClosedTargetError(e));
  });

  await t.test('hasText inside a wait tries a failed read again, bounds each read, and gives up on time', async () => {
    const timeouts = [];
    const ctx = make(basePage({ goto: async () => {}, locator: () => ({ innerText: async (o) => { timeouts.push(o && o.timeout); throw new Error('element detached'); } }) }));
    await ctx.goto('https://example.com');
    const t0 = Date.now();
    assert.equal(await ctx.hasText('New task', { timeoutMs: 600 }), false);
    const took = Date.now() - t0;
    assert.ok(took >= 500 && took < 3000, String(took));
    assert.ok(timeouts.length >= 2);
    assert.ok(timeouts.every((x) => x >= 1 && x <= 600), JSON.stringify(timeouts));
  });
});
