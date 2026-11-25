'use strict';
// Take-over lease (PAR-14514 S4). One at a time, in memory only (a daemon restart ends it), for one identity,
// owned by the signed user id of the control stream that started it. It ends after `maxMs` (20 min), after
// `graceMs` (60 s) with no control stream attached, on release, or when the hand-off window closes for its own
// reasons. While it is live, and while a release's session check runs, every agent command gets `handoff_open`.
// Logged: start and end with the reason. Never the identity's user, the path or any stream byte.
const MAX_MS = 20 * 60_000;
const GRACE_MS = 60_000;

function createLease({ maxMs = MAX_MS, graceMs = GRACE_MS, now = () => Date.now(), logger = () => {} } = {}) {
  let live = null; // { identity, userId, startedAt, expiresAt, controls, maxTimer, graceTimer }
  let ended = null; // the last lease that ended without a release: "ended, not confirmed"
  let checks = 0; // release session checks in flight
  const listeners = new Set();

  const timer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; };

  function armGrace(l) {
    clearTimeout(l.graceTimer);
    l.graceTimer = l.controls === 0 ? timer(() => end('no_control_stream'), graceMs) : null;
  }

  function start(identity, userId) {
    if (live) return null;
    const t = now();
    const l = { identity, userId, startedAt: t, expiresAt: t + maxMs, controls: 0, maxTimer: null, graceTimer: null };
    live = l;
    ended = null;
    l.maxTimer = timer(() => end('time_limit'), maxMs);
    armGrace(l);
    logger('pib-browser live: take-over started');
    return l;
  }

  // A control stream joins the lease `l`. The returned detach is safe to call twice, and does nothing once
  // `l` has ended (a later lease is never touched by an old stream).
  function attach(l) {
    if (!l || live !== l) return () => {};
    l.controls++;
    armGrace(l);
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      if (live !== l) return;
      l.controls = Math.max(0, l.controls - 1);
      armGrace(l);
    };
  }

  // Ends the live lease (only when it is for `identity`, if given). Listeners close the window and the
  // control streams. Returns whether a lease ended.
  function end(reason, { identity } = {}) {
    const l = live;
    if (!l || (identity !== undefined && l.identity !== identity)) return false;
    live = null;
    clearTimeout(l.maxTimer);
    clearTimeout(l.graceTimer);
    ended = { identity: l.identity, userId: l.userId, reason, endedAt: now() };
    logger(`pib-browser live: take-over ended (${reason})`);
    for (const fn of [...listeners]) { try { fn(l, reason); } catch (e) {} }
    return true;
  }

  // A release answered for `identity`: it is no longer "ended, not confirmed".
  function confirm(identity) {
    if (ended && ended.identity === identity) ended = null;
  }

  async function runCheck(fn) {
    checks++;
    try { return await fn(); } finally { checks--; }
  }

  function status() {
    if (live) {
      return {
        state: 'live', identity: live.identity, userId: live.userId,
        secondsLeft: Math.max(0, Math.ceil((live.expiresAt - now()) / 1000)), controlConnected: live.controls > 0
      };
    }
    if (ended) {
      return {
        state: 'ended', confirmed: false, identity: ended.identity, userId: ended.userId,
        reason: ended.reason, endedAt: new Date(ended.endedAt).toISOString()
      };
    }
    return null;
  }

  return {
    start, attach, end, confirm, runCheck, status,
    current: () => live,
    isLive: (identity) => !!live && live.identity === identity,
    busy: () => live !== null || checks > 0,
    onEnd(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };
}

module.exports = { createLease, MAX_MS, GRACE_MS };
