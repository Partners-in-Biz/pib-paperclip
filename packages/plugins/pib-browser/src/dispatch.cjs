'use strict';
const path = require('path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { EXIT } = require('./exit-codes.cjs');
const { authenticate, ISSUE_RE } = require('./auth.cjs');
const { parseIdentity, originsFor, authorise } = require('./policy.cjs');
const { redactText, parseRegion } = require('./redact.cjs');
const { checkFill: defaultCheckFill } = require('./fill-rules.cjs');
const { createErrorLog } = require('./errlog.cjs');

const COMMANDS = Object.freeze(['open', 'goto', 'click', 'fill', 'text', 'shot', 'close']);

// Sort a driver error into a reason that names the cause (PAR-9187). Only a dead
// browser/context ends the session; a missing or ambiguous target, a slow page or
// any other page-level error leaves it open so the agent can retry or close.
function classifyDriverError(e) {
  const msg = String(e?.message || '');
  const name = e?.name || '';
  if (e?.code === 'NO_BROWSER') return { exit: EXIT.NO_BROWSER, reason: 'browser_launch_failed', drop: true };
  if (name === 'TargetClosedError' || /Target page, context or browser has been closed|Browser has been closed|browser has disconnected/i.test(msg))
    return { exit: EXIT.NO_BROWSER, reason: 'browser_closed', drop: true };
  if (/strict mode violation/i.test(msg)) return { exit: EXIT.EXPECT_MISSING, reason: 'target_ambiguous', drop: false };
  if (name === 'TimeoutError' || /Timeout \d+ms exceeded/i.test(msg)) return { exit: EXIT.EXPECT_MISSING, reason: 'timeout', drop: false };
  return { exit: EXIT.NO_BROWSER, reason: `internal: ${name || 'Error'}`, drop: false };
}

function createDispatcher(deps = {}) {
  const sessions = new Map();
  const shotCounters = new Map();
  const { verifyApproval, handoff } = deps;
  const errorLog = deps.errorLog || createErrorLog({ path: deps.errorLogPath });
  const logError = (request, phase, error) => {
    try {
      errorLog.record({ cmd: request?.cmd, issue: request?.issue, identity: request?.identity, phase, error });
    } catch (e) {}
  };
  const noopHandoff = { isActive: () => false };

  const makeGuard = (origins) => (url, kind) => {
    try {
      const u = new URL(url);
      return !(u.username || u.password || !['http:', 'https:'].includes(u.protocol)) && origins.includes(u.origin);
    } catch (e) {
      return false;
    }
  };

  const dropSession = async (ctx, key) => {
    try { await ctx.close(); } catch (e) {}
    sessions.delete(key);
  };

  const afterOp = async (ctx, key) => {
    const v = ctx.violations();
    if (v.length > 0) {
      await dropSession(ctx, key);
      let host = 'unparseable';
      try {
        host = new URL(v[0].url).host;
      } catch (e) {}
      return { exit: EXIT.REFUSED_BY_POLICY, ok: false, reason: `origin_wall: ${host}` };
    }
    return null;
  };

  async function dispatch(request, overrideDeps = null) {
    const { authenticate, browser, policy, sites, clock, apiBase } = overrideDeps || deps;

    try {
      const { cmd, token, issue, identity: identityStr, args = {} } = request || {};

      // Validate command before auth
      if (!cmd || typeof cmd !== 'string' || !COMMANDS.includes(cmd)) {
        return { exit: EXIT.USAGE, ok: false, reason: 'unknown_command' };
      }

      // Authenticate
      const auth = await authenticate({ token, issue }, { fetch: global.fetch, apiBase });
      if (!auth.ok) {
        return { exit: auth.exit, ok: false, reason: auth.reason };
      }

      const { agentId } = auth;
      const identity = parseIdentity(identityStr);
      if (!identity) {
        return { exit: EXIT.USAGE, ok: false, reason: 'identity_invalid' };
      }

      const sessionKey = `${agentId}|${identityStr}`;

      if (cmd === 'open') {
        if (!sites) {
          return { exit: EXIT.USAGE, ok: false, reason: 'sites_required' };
        }

        const svc = identity.svc;
        const site = sites.sites?.[svc];
        if (!site) {
          return { exit: EXIT.USAGE, ok: false, reason: 'site_not_found' };
        }

        const authResult = authorise({
          policy,
          sites,
          agentId,
          identity: identityStr,
          url: site.loggedIn.url
        });
        if (!authResult.ok) {
          return { exit: authResult.exit, ok: false, reason: authResult.reason };
        }

        if (!browser) {
          return { exit: EXIT.NO_BROWSER, ok: false, reason: 'no_browser' };
        }

        // Close existing context if one exists for same agentId|identity key
        const existingSession = sessions.get(sessionKey);
        if (existingSession) {
          try {
            await existingSession.ctx.close();
          } catch (e) {}
          sessions.delete(sessionKey);
        }

        try {
          const origins = originsFor({ policy, sites, identity: identityStr });
          let ctx;
          try {
            ctx = browser.newContext({
              origins,
              guard: makeGuard(origins),
              identity: identityStr
            });

            await ctx.goto(site.loggedIn.url);
          } catch (e) {
            try { await ctx?.close(); } catch (closeErr) {}
            throw e;
          }

          const violation = await afterOp(ctx, sessionKey);
          if (violation) return violation;

          if (!(await ctx.hasText(site.loggedIn.expect))) {
            await ctx.close();
            return { exit: EXIT.SESSION_EXPIRED, ok: false, reason: 'session_expired' };
          }

          sessions.set(sessionKey, { ctx, site, auth });
          return { exit: EXIT.DONE, ok: true };
        } catch (e) {
          logError(request, 'open', e);
          const c = classifyDriverError(e);
          return { exit: EXIT.NO_BROWSER, ok: false, reason: c.reason };
        }
      }

      const session = sessions.get(sessionKey);
      if (!session) return { exit: EXIT.USAGE, ok: false, reason: 'no_session' };
      const { ctx, site } = session;

      try {
        if (cmd === 'goto') {
          const { url } = args;
          if (!url) {
            return { exit: EXIT.USAGE, ok: false, reason: 'url_required' };
          }

          const authResult = authorise({
            policy,
            sites,
            agentId,
            identity: identityStr,
            url
          });
          if (!authResult.ok) {
            await dropSession(ctx, sessionKey);
            return { exit: authResult.exit, ok: false, reason: authResult.reason };
          }

          await ctx.goto(url);
          const violation = await afterOp(ctx, sessionKey);
          return violation || { exit: EXIT.DONE, ok: true };
        }

        if (cmd === 'click') {
          const { selector, text, approval } = args;
          if (!selector) {
            return { exit: EXIT.USAGE, ok: false, reason: 'selector_required' };
          }

          // The element's own label (aria-label / visible text) also counts toward
          // the destructive check, so `#btn-3` that reads "Save" still needs approval.
          let label;
          if (typeof ctx.label === 'function') {
            try { label = await ctx.label(selector, text); } catch (e) { label = undefined; }
          }
          const click = { selector, text, label };

          const authResult = authorise({
            policy,
            sites,
            agentId,
            identity: identityStr,
            url: site.loggedIn.url,
            click,
            approved: false
          });

          if (authResult.exit === EXIT.NEEDS_APPROVAL && approval && verifyApproval) {
            let approvalResult;
            try {
              approvalResult = await verifyApproval({
                approval,
                identity: identityStr,
                action: [selector, text].filter(Boolean),
                companyId: auth.companyId
              }, { token });
            } catch (e) {
              approvalResult = { exit: EXIT.NEEDS_APPROVAL, ok: false, reason: 'approval_check_failed' };
            }
            if (!approvalResult.ok) {
              await dropSession(ctx, sessionKey);
              return { exit: approvalResult.exit || EXIT.NEEDS_APPROVAL, ok: false, reason: approvalResult.reason };
            }
            const authResult2 = authorise({
              policy,
              sites,
              agentId,
              identity: identityStr,
              url: site.loggedIn.url,
              click,
              approved: true
            });
            if (!authResult2.ok) {
              await dropSession(ctx, sessionKey);
              return { exit: authResult2.exit, ok: false, reason: authResult2.reason };
            }
          } else if (!authResult.ok) {
            // No approval offered: nothing was attempted, so the session stays open
            // and the agent can still shot/close (PAR-9187). Policy refusals still drop it.
            if (authResult.exit !== EXIT.NEEDS_APPROVAL) await dropSession(ctx, sessionKey);
            return { exit: authResult.exit, ok: false, reason: authResult.reason };
          }

          await ctx.click(selector, text);
          const violation = await afterOp(ctx, sessionKey);
          return violation || { exit: EXIT.DONE, ok: true };
        }

        if (cmd === 'fill') {
          const { selector, value } = args;
          if (!selector || !value) {
            return { exit: EXIT.USAGE, ok: false, reason: 'selector_and_value_required' };
          }

          let field, pageUrl;
          try {
            field = await ctx.describe(selector);
          } catch (e) {
            field = undefined;
          }
          try {
            pageUrl = ctx.url();
          } catch (e) {
            pageUrl = undefined;
          }

          const checkFillFn = deps.checkFill || defaultCheckFill;
          try {
            const fillCheck = checkFillFn({
              field,
              pageUrl,
              site,
              handoffActive: (handoff || noopHandoff).isActive(identityStr)
            });
            if (!fillCheck || fillCheck.ok !== true) {
              await dropSession(ctx, sessionKey);
              return { exit: EXIT.REFUSED_BY_POLICY, ok: false, reason: fillCheck?.reason || 'fill_check_failed' };
            }
          } catch (e) {
            await dropSession(ctx, sessionKey);
            return { exit: EXIT.REFUSED_BY_POLICY, ok: false, reason: 'fill_check_failed' };
          }

          await ctx.fill(selector, value);
          const violation = await afterOp(ctx, sessionKey);
          return violation || { exit: EXIT.DONE, ok: true, data: { filled: true } };
        }

        if (cmd === 'text') {
          const { selector } = args;
          if (!selector) {
            return { exit: EXIT.USAGE, ok: false, reason: 'selector_required' };
          }

          const pageText = await ctx.text(selector);
          const violation = await afterOp(ctx, sessionKey);
          if (violation) return violation;

          const redacted = redactText(pageText);
          return { exit: EXIT.DONE, ok: true, data: { text: redacted } };
        }

        if (cmd === 'shot') {
          const { region, expect } = args;

          let parsedRegion = null;
          if (region) {
            parsedRegion = parseRegion(region);
            if (!parsedRegion) {
              return { exit: EXIT.USAGE, ok: false, reason: 'region_invalid' };
            }
          }

          let expectMatched = false;
          if (expect) {
            if (!(await ctx.hasText(expect))) {
              return { exit: EXIT.EXPECT_MISSING, ok: false, reason: 'expect_missing' };
            }
            expectMatched = true;
          }

          // Get redact selectors from site
          const redactSelectors = site.redact || [];

          // Capture to daemon-private temp directory
          let tempDir, tempPath;
          try {
            tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pib-browser-'), { mode: 0o700 });
            tempPath = path.join(tempDir, 'shot.png');

            const resultPath = await ctx.shot(tempPath, {
              region: parsedRegion,
              redactSelectors
            });

            if (!resultPath) {
              try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
              return { exit: EXIT.NO_SCREENSHOT, ok: false, reason: 'no_screenshot' };
            }

            // Read the file
            const bytes = fs.readFileSync(tempPath);
            const b64 = bytes.toString('base64');
            const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
            const byteLength = bytes.length;
            const pageUrl = ctx.url();

            // Clean up temp directory
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}

            const violation = await afterOp(ctx, sessionKey);
            if (violation) return violation;

            return {
              exit: EXIT.DONE,
              ok: true,
              data: {
                bytes: b64,
                sha256,
                byteLength,
                url: pageUrl,
                expected: expectMatched
              }
            };
          } catch (e) {
            try { if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true }); } catch (cleanup) {}
            logError(request, 'shot', e);
            const c = classifyDriverError(e);
            if (c.drop) await dropSession(ctx, sessionKey);
            return { exit: c.drop ? c.exit : EXIT.NO_SCREENSHOT, ok: false, reason: c.reason };
          }
        }

        if (cmd === 'close') {
          await ctx.close();
          sessions.delete(sessionKey);
          return { exit: EXIT.DONE, ok: true };
        }

        return { exit: EXIT.USAGE, ok: false, reason: 'unknown_command' };
      } catch (e) {
        logError(request, cmd, e);
        const c = classifyDriverError(e);
        if (c.drop || cmd === 'close') await dropSession(ctx, sessionKey);
        return { exit: c.exit, ok: false, reason: c.reason };
      }
    } catch (e) {
      logError(request, 'dispatch', e);
      return { exit: EXIT.NO_BROWSER, ok: false, reason: 'internal: dispatch' };
    }
  }

  return { dispatch, sessions, COMMANDS };
}

module.exports = { createDispatcher, classifyDriverError, COMMANDS };
