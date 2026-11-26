'use strict';
const path = require('path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { EXIT } = require('./exit-codes.cjs');
const { authenticate, ISSUE_RE } = require('./auth.cjs');
const { parseIdentity, originsFor, authorise } = require('./policy.cjs');
const { redactText, parseRegion } = require('./redact.cjs');
const { parseViewport, redactUrl } = require('./netlog.cjs');
const { checkFill: defaultCheckFill } = require('./fill-rules.cjs');
const { createErrorLog } = require('./errlog.cjs');
const { createHandoffSessions, DEFAULT_TIMEOUT_MS } = require('./handoff-session.cjs');

// The agent verbs. They all need an agent token and act on that agent's own session.
const COMMANDS = Object.freeze(['open', 'goto', 'click', 'drag', 'fill', 'select', 'text', 'shot', 'net', 'close']);
// Person hand-off (PAR-14022): authorised by root's flag, not by an agent token. Opens a window only a person
// on the VNC screen can use; no agent verb can reach it.
const HANDOFF_COMMANDS = Object.freeze(['handoff-open']);

// How long to wait for a text that the page renders after its document has loaded.
const OPEN_EXPECT_WAIT_MS = 15000;
const SHOT_EXPECT_WAIT_MS = 5000;

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
  if (name === 'TimeoutError' || /Timeout \d+ms exceeded/i.test(msg)) {
    // The session stays open; the reason says why the action could not run (PAR-14819).
    const why = typeof e?.waitReason === 'string' ? e.waitReason.replace(/[^\x20-\x7e]/g, ' ').slice(0, 200) : '';
    return { exit: EXIT.EXPECT_MISSING, reason: why ? `timeout: ${why}` : 'timeout', drop: false };
  }
  return { exit: EXIT.NO_BROWSER, reason: `internal: ${name || 'Error'}`, drop: false };
}

// --force skips Playwright's actionability checks (stable, not covered). QA seats on approved steps only:
// it needs --approval, and the approval is checked like a destructive click's.
async function checkForce({ args, verifyApproval, identityStr, action, auth, token, verified }) {
  if (!args.force) return null;
  // A destructive step already claimed this single-use approval; claiming it again would fail (approval_already_used).
  if (verified && args.approval) return null;
  if (!args.approval || !verifyApproval) return { exit: EXIT.NEEDS_APPROVAL, ok: false, reason: 'force_needs_approval' };
  let r;
  try {
    r = await verifyApproval({ approval: args.approval, identity: identityStr, action, companyId: auth.companyId }, { token });
  } catch (e) {
    r = { exit: EXIT.NEEDS_APPROVAL, ok: false, reason: 'approval_check_failed' };
  }
  return r && r.ok ? null : { exit: (r && r.exit) || EXIT.NEEDS_APPROVAL, ok: false, reason: (r && r.reason) || 'approval_check_failed' };
}

const issueOf = (auth, issue) => String(auth?.issue?.identifier || issue || '');

function createDispatcher(deps = {}) {
  const sessions = new Map();
  const shotCounters = new Map();
  const { verifyApproval, handoff } = deps;
  // Take-over (PAR-14514 S4): the person's lease and the list of tasks waiting for a login. Both optional.
  const lease = deps.lease || null;
  const waiting = deps.waiting || null;
  const noteWaiting = (identity, issue, reason) => {
    try { if (waiting) waiting.record(identity, issue, reason); } catch (e) {}
  };
  const errorLog = deps.errorLog || createErrorLog({ path: deps.errorLogPath });
  const logError = (request, phase, error) => {
    try {
      errorLog.record({ cmd: request?.cmd, issue: request?.issue, identity: request?.identity, phase, error });
    } catch (e) {}
  };

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

  const handoffs = createHandoffSessions({
    browser: deps.browser,
    policy: deps.policy,
    sites: deps.sites,
    handoff,
    makeGuard,
    // One Chromium per profile directory: end every agent session on the identity before the person's window opens.
    beforeOpen: async (identity) => {
      for (const [key, s] of [...sessions]) {
        if (key.endsWith(`|${identity}`)) await dropSession(s.ctx, key);
      }
    },
    timeoutMs: deps.handoffTimeoutMs || DEFAULT_TIMEOUT_MS,
    pollMs: deps.handoffPollMs,
    now: deps.handoffNow,
    sleep: deps.handoffSleep,
    logError: (req, phase, e) => logError(req, phase, e),
    // The window closed for its own reasons (logged in, timeout, closed by the person): the lease ends with it.
    onClose: (identity, reason) => { if (lease) lease.end(reason, { identity }); }
  });
  // The lease ended (time limit, no control stream, release): its window closes with it.
  if (lease) lease.onEnd((l, reason) => { handoffs.close(l.identity, reason).catch(() => {}); });

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

      if (cmd === 'handoff-open') return await handoffs.start(identityStr);

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

      // A person holds the screen (a take-over, or its release check): every agent command waits, on every
      // identity, because :99 has no window manager and the person could click into any window (Q4).
      if (lease && lease.busy()) {
        noteWaiting(identityStr, issue, 'handoff_open');
        return { exit: EXIT.NO_BROWSER, ok: false, reason: 'handoff_open' };
      }

      const sessionKey = `${agentId}|${identityStr}`;

      let viewport;
      if ((cmd === 'open' || cmd === 'goto') && args.viewport !== undefined) {
        viewport = parseViewport(args.viewport);
        if (!viewport) return { exit: EXIT.USAGE, ok: false, reason: 'viewport_invalid' };
      }

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

        // A person is logging in on this profile: Chromium allows one window per profile directory.
        if (handoffs.isOpen(identityStr)) {
          noteWaiting(identityStr, issue, 'handoff_open');
          return { exit: EXIT.NO_BROWSER, ok: false, reason: 'handoff_open' };
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
              identity: identityStr,
              ...(viewport ? { viewport } : {})
            });

            await ctx.goto(site.loggedIn.url);
          } catch (e) {
            try { await ctx?.close(); } catch (closeErr) {}
            throw e;
          }

          const violation = await afterOp(ctx, sessionKey);
          if (violation) return violation;

          // The logged-in text can render a moment after the document: wait for it before calling the session expired.
          const loggedIn = await ctx.hasText(site.loggedIn.expect, { timeoutMs: OPEN_EXPECT_WAIT_MS });
          // The page can navigate or open a popup while we wait. Check the origin wall again before deciding
          // anything: a refused origin is reported as such, and never keeps a session or hides behind "expired".
          const lateViolation = await afterOp(ctx, sessionKey);
          if (lateViolation) return lateViolation;
          if (!loggedIn) {
            await ctx.close();
            noteWaiting(identityStr, issue, 'session_expired');
            return { exit: EXIT.SESSION_EXPIRED, ok: false, reason: 'session_expired' };
          }

          sessions.set(sessionKey, { ctx, site, auth, issue: issueOf(auth, issue), companyId: auth.companyId || null, lastActiveAt: Date.now() });
          return { exit: EXIT.DONE, ok: true };
        } catch (e) {
          logError(request, 'open', e);
          const c = classifyDriverError(e);
          return { exit: EXIT.NO_BROWSER, ok: false, reason: c.reason };
        }
      }

      const session = sessions.get(sessionKey);
      if (!session) return { exit: EXIT.USAGE, ok: false, reason: 'no_session' };
      // Which task the session works on now, and when it last did something (the live chip reads both).
      session.issue = issueOf(auth, issue);
      session.lastActiveAt = Date.now();
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

          if (viewport) await ctx.setViewport(viewport);
          await ctx.goto(url);
          const violation = await afterOp(ctx, sessionKey);
          return violation || { exit: EXIT.DONE, ok: true };
        }

        if (cmd === 'click' || cmd === 'drag' || cmd === 'select') {
          const { text, approval } = args;
          const { from, to } = args;
          // A drag is gated like a click on both ends: the destructive-word check sees both selectors.
          const selector = cmd === 'drag' ? (from && to ? `${from} => ${to}` : '') : args.selector;
          if (cmd === 'select' && selector && !args.value) {
            return { exit: EXIT.USAGE, ok: false, reason: 'selector_and_value_required' };
          }
          if (!selector) {
            return { exit: EXIT.USAGE, ok: false, reason: cmd === 'drag' ? 'from_and_to_required' : 'selector_required' };
          }

          // The element's own label (aria-label / visible text) also counts toward
          // the destructive check, so `#btn-3` that reads "Save" still needs approval.
          let label;
          if (typeof ctx.label === 'function') {
            try {
              label = cmd === 'drag'
                ? [await ctx.label(from), await ctx.label(to)].filter(Boolean).join(' ')
                : await ctx.label(selector, text);
            } catch (e) { label = undefined; }
          }
          // A select is gated like a click; the chosen option text also counts toward the destructive check.
          if (cmd === 'select') label = [label, args.value].filter(Boolean).join(' ');
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

          let approvalVerified = false;
          if (authResult.exit === EXIT.NEEDS_APPROVAL && approval && verifyApproval) {
            let approvalResult;
            try {
              approvalResult = await verifyApproval({
                approval,
                identity: identityStr,
                action: cmd === 'drag' ? [from, to] : [selector, text].filter(Boolean),
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
            approvalVerified = true;
          } else if (!authResult.ok) {
            // No approval offered: nothing was attempted, so the session stays open
            // and the agent can still shot/close (PAR-9187). Policy refusals still drop it.
            if (authResult.exit !== EXIT.NEEDS_APPROVAL) await dropSession(ctx, sessionKey);
            return { exit: authResult.exit, ok: false, reason: authResult.reason };
          }

          if (cmd === 'drag') await ctx.drag(from, to);
          else if (cmd === 'select') await ctx.select(selector, args.value);
          else {
            const refused = await checkForce({ args, verifyApproval, identityStr, action: [selector, text].filter(Boolean), auth, token, verified: approvalVerified });
            if (refused) return refused;
            await ctx.click(selector, text, args.force ? { force: true } : {});
          }
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

          // The hand-off flag never lifts these rules for an agent: during a hand-off the person types the
          // password into their own window (handoff-open), never through `fill` (PAR-14022).
          const checkFillFn = deps.checkFill || defaultCheckFill;
          try {
            const fillCheck = checkFillFn({ field, pageUrl, site });
            if (!fillCheck || fillCheck.ok !== true) {
              await dropSession(ctx, sessionKey);
              return { exit: EXIT.REFUSED_BY_POLICY, ok: false, reason: fillCheck?.reason || 'fill_check_failed' };
            }
          } catch (e) {
            await dropSession(ctx, sessionKey);
            return { exit: EXIT.REFUSED_BY_POLICY, ok: false, reason: 'fill_check_failed' };
          }

          const refused = await checkForce({ args, verifyApproval, identityStr, action: [selector], auth, token });
          if (refused) return refused;
          await ctx.fill(selector, value, args.force ? { force: true } : {});
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
            if (!(await ctx.hasText(expect, { timeoutMs: SHOT_EXPECT_WAIT_MS }))) {
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

        if (cmd === 'net') {
          const raw = typeof ctx.net === 'function' ? ctx.net() : [];
          // Redact again on the way out: the log never leaves the daemon with a query value in it.
          const entries = raw.map((e) => ({ time: e.time, method: e.method, url: redactUrl(e.url), status: e.status }));
          return { exit: EXIT.DONE, ok: true, data: { entries } };
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

  // The session check after a take-over (F18): the same test as `open`, run by the daemon itself.
  async function checkSession(identityStr) {
    const identity = parseIdentity(identityStr);
    const site = identity && deps.sites?.sites?.[identity.svc];
    if (!site?.loggedIn?.url || !site.loggedIn.expect) return { ok: false, reason: 'site_not_found' };
    if (!deps.browser) return { ok: false, reason: 'no_browser' };
    const origins = originsFor({ policy: deps.policy, sites: deps.sites, identity: identityStr });
    let url;
    try { url = new URL(site.loggedIn.url, origins[0]); } catch (e) { return { ok: false, reason: 'origin not allowed' }; }
    if (!origins.includes(url.origin)) return { ok: false, reason: 'origin not allowed' };
    // One Chromium per profile directory.
    for (const [key, s] of [...sessions]) {
      if (key.endsWith(`|${identityStr}`)) await dropSession(s.ctx, key);
    }
    let ctx;
    try {
      ctx = deps.browser.newContext({ origins, guard: makeGuard(origins), identity: identityStr });
      await ctx.goto(url.href);
      const wall = () => {
        const v = ctx.violations();
        if (!v.length) return null;
        let host = 'unparseable';
        try { host = new URL(v[0].url).host; } catch (e) {}
        return { ok: false, reason: `origin_wall: ${host}` };
      };
      const early = wall();
      if (early) return early;
      const loggedIn = await ctx.hasText(site.loggedIn.expect, { timeoutMs: OPEN_EXPECT_WAIT_MS });
      return wall() || (loggedIn ? { ok: true, reason: 'logged_in' } : { ok: false, reason: 'session_expired' });
    } catch (e) {
      logError({ cmd: 'release', identity: identityStr }, 'session-check', e);
      return { ok: false, reason: classifyDriverError(e).reason };
    } finally {
      try { await ctx?.close(); } catch (e) {}
    }
  }

  // POST /release (PAR-14514 S4): end the lease, close the window (its profile is written), check the
  // session. Agents stay refused until the check is over. Releases run one at a time; a second release
  // for an ended lease answers the same way (a fresh check), so it is safe twice.
  let releaseChain = Promise.resolve();
  function release(identityStr) {
    const run = async () => {
      if (!parseIdentity(identityStr)) return { ok: false, reason: 'identity_invalid' };
      const work = async () => {
        if (lease) lease.end('released', { identity: identityStr });
        await handoffs.close(identityStr, 'released');
        const r = await checkSession(identityStr);
        if (lease) lease.confirm(identityStr);
        return r;
      };
      return lease ? lease.runCheck(work) : work();
    };
    const p = releaseChain.then(run, run);
    releaseChain = p.catch(() => {});
    return p;
  }

  return { dispatch, sessions, handoffs, release, checkSession, COMMANDS };
}

module.exports = { createDispatcher, classifyDriverError, COMMANDS, HANDOFF_COMMANDS };
