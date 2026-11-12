'use strict';
const path = require('path');
const fs = require('fs');

// How long goto lets the network settle after the document has loaded (PIB_BROWSER_SETTLE_MS).
// Playwright reads `timeout: 0` as "no timeout", so 0 here means "do not wait at all", never "wait for ever".
// Unset, empty, negative and non-numeric values give the default; the most is 30 s.
const DEFAULT_SETTLE_MS = 8000;
const MAX_SETTLE_MS = 30000;
function settleMs(env = {}) {
  const raw = env.PIB_BROWSER_SETTLE_MS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_SETTLE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_SETTLE_MS;
  return Math.min(Math.floor(n), MAX_SETTLE_MS);
}

// A dead page, context or browser. Never swallow it: the dispatcher sorts it into `browser_closed` and drops the session.
function isClosedTargetError(e) {
  return e?.name === 'TargetClosedError'
    || /Target page, context or browser has been closed|Browser has been closed|browser has disconnected/i.test(String(e?.message || ''));
}

function createPlaywrightBrowser({ playwright, env = {}, profileRoot } = {}) {
  const pw = playwright || require('playwright-core');
  const defaultProfileRoot = profileRoot || env.PIB_BROWSER_PROFILES || '/var/lib/pib-browser/profiles';

  function sanitizeIdentity(identity) {
    return (identity || 'default')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '_')
      .slice(0, 255);
  }

  function stripQueryFragment(url) {
    try {
      const u = new URL(url);
      return u.origin + u.pathname;
    } catch (e) {
      return url;
    }
  }

  return {
    newContext({ origins = [], guard, identity }) {
      let context = null;
      let page = null;
      const violations = [];
      let initialized = false;

      const checkGuard = (url, kind) => {
        if (!guard(url, kind)) {
          violations.push({ url: stripQueryFragment(url), kind });
          return false;
        }
        return true;
      };

      const init = async () => {
        if (initialized) return;
        initialized = true;

        const profilePath = path.join(
          defaultProfileRoot,
          sanitizeIdentity(identity)
        );

        if (!fs.existsSync(profilePath)) {
          fs.mkdirSync(profilePath, { recursive: true });
        }

        try {
          context = await pw.chromium.launchPersistentContext(profilePath, {
            headless: env.PIB_BROWSER_HEADLESS !== '0',
            executablePath: env.PIB_BROWSER_CHROMIUM || undefined,
            acceptDownloads: false,
            serviceWorkers: 'block',
            permissions: []
          });
        } catch (e) {
          const err = new Error(e.message);
          err.code = 'NO_BROWSER';
          throw err;
        }

        let pages = context.pages();
        if (pages.length === 0) {
          page = await context.newPage();
        } else {
          page = pages[0];
        }

        await context.route('**/*', (route) => {
          const url = route.request().url();
          let scheme;
          try {
            scheme = new URL(url).protocol;
          } catch (e) {
            scheme = '';
          }

          // Swallow route errors: a request still in flight when the page or context
          // closes rejects, and an unhandled rejection would kill the daemon (PAR-9187).
          const safe = (fn) => {
            try { return Promise.resolve(fn()).catch(() => {}); } catch (e) { return Promise.resolve(); }
          };
          if (!['http:', 'https:'].includes(scheme) && url !== 'about:blank') {
            checkGuard(url, 'request');
            return safe(() => route.abort());
          } else if (checkGuard(url, 'request')) {
            return safe(() => route.continue());
          } else {
            return safe(() => route.abort());
          }
        });

        context.on('page', (popup) => {
          const url = popup.url();
          if (!checkGuard(url, 'popup')) {
            Promise.resolve().then(() => popup.close()).catch(() => {});
          }
        });

        page.on('framenavigated', (frame) => {
          if (frame === page.mainFrame()) {
            const url = page.url();
            checkGuard(url, 'navigation');
          }
        });
      };

      const ensureInitialized = async () => {
        if (!initialized) {
          await init();
        }
      };

      return {
        goto: async (url) => {
          await ensureInitialized();
          // A live board never goes network-idle (polling, event streams). Waiting for "networkidle" alone
          // timed out on a healthy, logged-in page and was reported as an expired session (2026-11-12).
          // Load the document, then give the network a bounded moment to settle.
          await page.goto(url, { waitUntil: 'domcontentloaded' });
          const settle = settleMs(env);
          if (settle > 0 && typeof page.waitForLoadState === 'function') {
            await page.waitForLoadState('networkidle', { timeout: settle }).catch((e) => {
              if (isClosedTargetError(e)) throw e;
            });
          }
        },

        click: async (selector, text) => {
          await ensureInitialized();
          let locator = page.locator(selector);
          if (text) {
            locator = locator.filter({ hasText: text });
          }
          await locator.click();
        },

        // Short read of the click target's label for the destructive-word check.
        // Returns '' when the target is missing; never waits the full action timeout.
        label: async (selector, text) => {
          await ensureInitialized();
          let locator = page.locator(selector);
          if (text) {
            locator = locator.filter({ hasText: text });
          }
          if ((await locator.count()) === 0) return '';
          const first = locator.first();
          const opts = { timeout: 2000 };
          const parts = await Promise.all([
            first.getAttribute('aria-label', opts).catch(() => null),
            first.getAttribute('title', opts).catch(() => null),
            first.getAttribute('value', opts).catch(() => null),
            first.innerText(opts).then((t) => t.slice(0, 200)).catch(() => null)
          ]);
          return parts.filter(Boolean).join(' ');
        },

        fill: async (selector, value) => {
          await ensureInitialized();
          await page.locator(selector).fill(value);
        },

        text: async (selector) => {
          await ensureInitialized();
          try {
            return await page.locator(selector).innerText();
          } catch (e) {
            return '';
          }
        },

        // timeoutMs > 0 re-reads the page until the text shows or the time is up: a single-page app renders
        // after the document has loaded. The default (0) is one read that throws as before. Inside a wait a
        // failed read is tried again, but a closed page, context or browser always throws.
        hasText: async (text, opts) => {
          await ensureInitialized();
          const timeoutMs = Math.max(0, Number(opts && opts.timeoutMs) || 0);
          if (timeoutMs === 0) {
            const bodyText = await page.locator('body').innerText();
            return bodyText.includes(text);
          }
          const deadline = Date.now() + timeoutMs;
          for (;;) {
            const remaining = Math.max(1, deadline - Date.now());
            let bodyText = '';
            try {
              bodyText = await page.locator('body').innerText({ timeout: remaining });
            } catch (e) {
              if (isClosedTargetError(e)) throw e;
            }
            if (bodyText.includes(text)) return true;
            if (Date.now() >= deadline) return false;
            await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
          }
        },

        describe: async (selector) => {
          await ensureInitialized();
          const element = page.locator(selector).first();
          const type = (await element.getAttribute('type')) || 'text';
          const autocomplete = (await element.getAttribute('autocomplete')) || '';
          return { type, autocomplete };
        },

        url: () => {
          if (!page) throw new Error('Context not initialized');
          return page.url();
        },

        shot: async (shotPath, opts = {}) => {
          await ensureInitialized();
          const screenshotOpts = {
            path: shotPath,
            fullPage: false,
            maskColor: '#000000'
          };

          if (opts.redactSelectors && opts.redactSelectors.length > 0) {
            screenshotOpts.mask = opts.redactSelectors.map(s => page.locator(s));
          }

          if (opts.region) {
            screenshotOpts.clip = {
              x: opts.region.x,
              y: opts.region.y,
              width: opts.region.w,
              height: opts.region.h
            };
          }

          await page.screenshot(screenshotOpts);
          return shotPath;
        },

        close: async () => {
          if (context) {
            await context.close();
            context = null;
            page = null;
          }
        },

        violations: () => violations
      };
    }
  };
}

module.exports = { createPlaywrightBrowser, settleMs, isClosedTargetError };
