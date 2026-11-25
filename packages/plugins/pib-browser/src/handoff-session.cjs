'use strict';
// Hand-off windows (PAR-14022): a headed Chromium window on the daemon's display (:99) with an identity's
// profile, opened on the site's login page so a PERSON can log in over VNC. Agents never get this window:
// it is not in the agent session map, so goto/click/fill/text/shot cannot reach it.
//
// Allowed only while root's flag exists (handoff.cjs isActive): the root-owned flag is the authority, so the
// command needs no agent token (root's `pib-root browser-handoff-start` calls it). One window per identity.
// The window stays open until the logged-in text shows, the flag is gone, the person closes it, or the timeout.
// A person's take-over lease (PAR-14514 S4, lease.cjs) also makes isActive true; `close()` ends the window
// on release, and `onClose` ends the lease when the window closes for its own reasons.
const { EXIT } = require('./exit-codes.cjs');
const { parseIdentity, originsFor } = require('./policy.cjs');
const { isClosedTargetError } = require('./driver-playwright.cjs');

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_TIMEOUT_MS = 60 * 1000;
const MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_POLL_MS = 2000;

// PIB_BROWSER_HANDOFF_TIMEOUT_MS: unset/invalid gives 30 min; kept between 1 min and 2 h.
function handoffTimeoutMs(env = {}) {
  const raw = env.PIB_BROWSER_HANDOFF_TIMEOUT_MS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(n), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

function createHandoffSessions({
  browser,
  policy,
  sites,
  handoff,
  makeGuard,
  beforeOpen = async () => {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logError = () => {},
  // Called once per window with the reason it closed (the take-over lease ends with it, PAR-14514 S4).
  onClose = () => {}
} = {}) {
  // identity -> { ctx, startedAt, done: Promise<reason>, stopped: reason|null, gone: Promise }
  const open = new Map();
  // identity -> the last window's done promise (kept after the window closes, for tests and logs).
  const lastDone = new Map();

  // Removes the window from the map and tells the lease. Only the entry that owns the slot does this.
  function finish(identity, entry, reason) {
    if (open.get(identity) !== entry) return;
    open.delete(identity);
    entry.resolveGone();
    try { onClose(identity, reason); } catch (e) {}
  }

  async function watch(identity, entry, expect) {
    const deadline = entry.startedAt + timeoutMs;
    let reason;
    for (;;) {
      if (entry.stopped) { reason = entry.stopped; break; }
      if (!handoff || !handoff.isActive(identity)) { reason = 'flag_removed'; break; }
      if (now() >= deadline) { reason = 'timeout'; break; }
      try {
        if (await entry.ctx.hasText(expect)) { reason = 'logged_in'; break; }
      } catch (e) {
        if (entry.stopped) { reason = entry.stopped; break; }
        // The person closed the window (or the browser died): nothing left to watch.
        if (isClosedTargetError(e)) { reason = 'window_closed'; break; }
        // A page in the middle of a navigation cannot be read yet: try again next round.
      }
      // A stop (release) wakes the loop at once instead of after the next poll.
      await Promise.race([sleep(pollMs), entry.stopSignal]);
    }
    // Closing writes the persistent profile (cookies) before the session check opens it again.
    try { await entry.ctx.close(); } catch (e) {}
    finish(identity, entry, reason);
    return reason;
  }

  // Closes the identity's window now (release, lease ended) and resolves once its profile is closed.
  async function close(identityStr, reason = 'released') {
    const entry = open.get(identityStr);
    if (!entry) return;
    if (!entry.stopped) {
      entry.stopped = reason;
      entry.stop();
    }
    await entry.gone;
  }

  async function start(identityStr) {
    const identity = parseIdentity(identityStr);
    if (!identity) return { exit: EXIT.USAGE, ok: false, reason: 'identity_invalid' };
    if (!handoff || !handoff.isActive(identityStr)) {
      return { exit: EXIT.REFUSED_BY_POLICY, ok: false, reason: 'handoff_not_active' };
    }
    if (open.has(identityStr)) return { exit: EXIT.USAGE, ok: false, reason: 'handoff_already_open' };

    const site = sites?.sites?.[identity.svc];
    if (!site?.loggedIn?.url || !site.loggedIn.expect) return { exit: EXIT.USAGE, ok: false, reason: 'site_not_found' };
    const origins = originsFor({ policy, sites, identity: identityStr });
    let url;
    try {
      url = new URL(site.loggedIn.url, origins[0]);
    } catch (e) {
      return { exit: EXIT.REFUSED_BY_POLICY, ok: false, reason: 'origin not allowed' };
    }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || !origins.includes(url.origin)) {
      return { exit: EXIT.REFUSED_BY_POLICY, ok: false, reason: 'origin not allowed' };
    }
    if (!browser) return { exit: EXIT.NO_BROWSER, ok: false, reason: 'no_browser' };

    // Reserve the identity before the first await: a second request arriving while this one launches
    // Chromium sees it and is refused, so two windows never fight over one profile directory.
    const entry = { ctx: null, startedAt: now(), done: null, stopped: null };
    entry.gone = new Promise((resolve) => { entry.resolveGone = resolve; });
    entry.stopSignal = new Promise((resolve) => { entry.stop = resolve; });
    open.set(identityStr, entry);
    try {
      // The profile directory can hold one Chromium: close any agent session on this identity first.
      await beforeOpen(identityStr);
      entry.ctx = browser.newContext({ origins, guard: makeGuard(origins), identity: identityStr });
      // Load the logged-in page: a logged-out profile is sent on to the site's own login page.
      await entry.ctx.goto(url.href);
    } catch (e) {
      try { await entry.ctx?.close(); } catch (closeErr) {}
      finish(identityStr, entry, 'open_failed');
      logError({ cmd: 'handoff-open', identity: identityStr }, 'handoff-open', e);
      const reason = e?.code === 'NO_BROWSER' ? 'browser_launch_failed'
        : isClosedTargetError(e) ? 'browser_closed' : `internal: ${e?.name || 'Error'}`;
      return { exit: EXIT.NO_BROWSER, ok: false, reason };
    }
    // Stopped (released) while Chromium was starting: close it again at once.
    if (entry.stopped) {
      try { await entry.ctx.close(); } catch (e) {}
      finish(identityStr, entry, entry.stopped);
      return { exit: EXIT.NO_BROWSER, ok: false, reason: 'handoff_stopped' };
    }
    entry.done = watch(identityStr, entry, site.loggedIn.expect).catch((e) => {
      finish(identityStr, entry, 'internal');
      logError({ cmd: 'handoff-open', identity: identityStr }, 'handoff-watch', e);
      return 'internal';
    });
    lastDone.set(identityStr, entry.done);
    return {
      exit: EXIT.DONE,
      ok: true,
      data: { identity: identityStr, url: url.origin + url.pathname, timeoutMs }
    };
  }

  return {
    start,
    close,
    isOpen: (identityStr) => open.has(identityStr),
    // For tests and shutdown: resolves to why the window closed (logged_in, flag_removed, timeout, window_closed).
    done: (identityStr) => lastDone.get(identityStr) || Promise.resolve(null)
  };
}

module.exports = { createHandoffSessions, handoffTimeoutMs, DEFAULT_TIMEOUT_MS };
