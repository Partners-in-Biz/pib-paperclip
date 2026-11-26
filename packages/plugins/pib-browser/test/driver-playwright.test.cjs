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
      'click', 'close', 'describe', 'drag', 'fill', 'goto', 'hasText', 'label', 'net', 'select', 'setViewport', 'shot', 'text', 'url', 'violations'
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

test('driver-playwright click/fill timeouts (PAR-14819)', async (t) => {
  const { actionTimeoutMs, waitReasonOf } = require('../src/driver-playwright.cjs');
  const make = (page, env = {}) => {
    const fakeContext = { pages: () => [page], route: async () => {}, on: () => {}, close: async () => {} };
    const fakePw = { chromium: { launchPersistentContext: async () => fakeContext } };
    return createPlaywrightBrowser({ playwright: fakePw, profileRoot: '/tmp', env })
      .newContext({ origins: ['https://example.com'], guard: () => true });
  };
  // Real Playwright 1.62 call-log shapes (captured from Chromium 1248).
  const logErr = (...lines) => {
    const e = new Error('locator.click: Timeout 15000ms exceeded.\nCall log:\n' + lines.map((l) => '  - ' + l).join('\n'));
    e.name = 'TimeoutError';
    return e;
  };
  const head = ["waiting for locator('#x')", 'locator resolved to <button id="x">Send</button>', 'attempting click action', 'waiting for element to be visible, enabled and stable'];
  const unstableErr = () => logErr(...head, 'element is not stable', 'retrying click action', 'waiting 500ms');
  const coveredErr = () => logErr(...head, 'element is visible, enabled and stable', 'scrolling into view if needed', 'done scrolling', '<div id="c" class="x"></div> intercepts pointer events', 'retrying click action', 'waiting 500ms');
  const timeoutErr = unstableErr;

  await t.test('actionTimeoutMs: default 15 s, bad values default, 0 never means no timeout, most is 60 s', () => {
    for (const [raw, want] of [[undefined, 15000], ['', 15000], ['0', 15000], ['-5', 15000], ['abc', 15000], ['2500', 2500], ['999999', 60000]]) {
      assert.equal(actionTimeoutMs({ PIB_BROWSER_ACTION_TIMEOUT_MS: raw }), want, JSON.stringify(raw));
    }
  });

  await t.test('waitReasonOf returns the last wait line from the call log', () => {
    assert.equal(waitReasonOf(unstableErr()), 'element is not stable');
    assert.equal(waitReasonOf(coveredErr()), '<div> intercepts pointer events');
    assert.equal(waitReasonOf(new Error('Timeout 5ms exceeded.')), '');
  });

  await t.test('click passes the bounded timeout and no force by default; force only when asked', async () => {
    const seen = [];
    const ctx = make({ url: () => 'https://example.com', on: () => {}, mainFrame: () => ({}),
      locator: () => ({ click: async (o) => { seen.push(o); }, fill: async (v, o) => { seen.push(o); } }) },
      { PIB_BROWSER_ACTION_TIMEOUT_MS: '4000' });
    await ctx.click('#x');
    await ctx.click('#x', undefined, { force: true });
    await ctx.fill('#x', 'v', { force: true });
    assert.deepEqual(seen, [{ timeout: 4000 }, { timeout: 4000, force: true }, { timeout: 4000, force: true }]);
  });

  await t.test('a click timeout keeps the Playwright wait reason on the error', async () => {
    const ctx = make({ url: () => 'https://example.com', on: () => {}, mainFrame: () => ({}),
      locator: () => ({ click: async () => { throw timeoutErr(); } }) });
    await assert.rejects(() => ctx.click('#x'), (e) => e.waitReason === 'element is not stable');
  });
});

test('real Chromium through the dispatcher: timeout names the cause, session survives (PAR-14819)', async (t) => {
  const fs = require('node:fs');
  const exe = process.env.PIB_BROWSER_CHROMIUM || '/opt/pib-browser/ms-playwright/chromium-1248/chrome-linux64/chrome';
  if (!fs.existsSync(exe)) return t.skip('no Chromium');
  const http = require('node:http');
  const os = require('node:os');
  const path = require('node:path');
  const { createDispatcher } = require('../src/dispatch.cjs');
  const { createApprovalStore, verifyApproval } = require('../src/approval.cjs');
  const { EXIT } = require('../src/exit-codes.cjs');
  const html = '<style>#m{position:absolute;left:0;top:50px;animation:mv .3s infinite alternate}@keyframes mv{to{left:300px}}#d{position:absolute;top:120px}</style><h1>Home</h1><button id=m>M</button><button id=d onclick="document.title=\'gone\'">Delete</button>';
  const srv = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(html); });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbr-'));
  const store = createApprovalStore({ stateDir: tmp });
  const now = Date.now();
  const marker = 'approval for client:ca:site:#d';
  const fetch = async (url) => ({ ok: true, status: 200, json: async () => (url.endsWith('/comments') ? [] : url.endsWith('/activity') ? [{ id: 'a', action: 'issue.updated', createdAt: new Date(now - 1000).toISOString(), actorType: 'user', actorId: 'u', details: { changes: { status: { from: 'open', to: 'done' } } } }] : { id: 'PAR-9', status: 'done', companyId: 'ca', description: marker, completedAt: new Date(now - 1000).toISOString() }) });
  const browser = createPlaywrightBrowser({ profileRoot: tmp, env: { PIB_BROWSER_CHROMIUM: exe, PIB_BROWSER_HEADLESS: '1', PIB_BROWSER_ACTION_TIMEOUT_MS: '2000' } });
  const { dispatch } = createDispatcher({
    authenticate: async () => ({ ok: true, agentId: 'a1', companyId: 'ca', issue: { id: 'i1', identifier: 'PAR-1234', companyId: 'ca' } }),
    browser,
    policy: { version: 1, agents: { a1: { identities: ['client:ca:site'] } }, identities: { 'client:ca:site': { origins: [origin] } } },
    sites: { sites: { site: { label: 'S', origins: [origin], loggedIn: { url: origin + '/', expect: 'Home' }, confirm: [], redact: [], destructive: { selectors: ['#d'], text: [] } } } },
    clock: () => new Date(),
    checkFill: () => ({ ok: true }),
    verifyApproval: (a, o) => verifyApproval(a, { ...o, fetch, apiBase: 'http://api', clock: { now: () => now }, store })
  });
  const base = { token: 'valid', issue: 'PAR-1234', identity: 'client:ca:site' };
  try {
    const o = await dispatch({ ...base, cmd: 'open' });
    assert.equal(o.ok, true, JSON.stringify(o));
    const c = await dispatch({ ...base, cmd: 'click', args: { selector: '#m' } });
    assert.equal(c.reason, 'timeout: element is not stable');
    const tx = await dispatch({ ...base, cmd: 'text', args: { selector: 'h1' } });
    assert.equal(tx.ok, true, JSON.stringify(tx));
    // Destructive click + --force + ONE approval: one click, approval burnt once, second use refused.
    const f = await dispatch({ ...base, cmd: 'click', args: { selector: '#d', approval: 'PAR-9', force: true } });
    assert.equal(f.exit, EXIT.DONE, JSON.stringify(f));
    const f2 = await dispatch({ ...base, cmd: 'click', args: { selector: '#d', approval: 'PAR-9', force: true } });
    assert.equal(f2.reason, 'approval_already_used');
  } finally {
    await dispatch({ ...base, cmd: 'close' }).catch(() => {});
    srv.close();
  }
});
