'use strict';
// PAR-14022: handoff-open keeps a person's login window open on :99 while root's flag exists.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EXIT } = require('../src/exit-codes.cjs');
const { createDispatcher, COMMANDS, HANDOFF_COMMANDS } = require('../src/dispatch.cjs');
const { handoffTimeoutMs, DEFAULT_TIMEOUT_MS } = require('../src/handoff-session.cjs');
const { loadConfig } = require('../src/daemon.cjs');
const { run } = require('../src/cli.cjs');

const ID = 'pib:paperclip';
const DASH = 'https://paperclip.partnersinbiz.online/PAR/dashboard';
const SITES = { sites: { paperclip: {
  label: 'Paperclip', origins: ['https://paperclip.partnersinbiz.online'],
  loggedIn: { url: DASH, expect: 'New task' }, confirm: [], redact: [], destructive: { selectors: [], text: [] }
} } };
const POLICY = { version: 1, agents: { a1: { identities: [ID] } }, identities: {} };

function closedError() {
  const e = new Error('Target page, context or browser has been closed');
  e.name = 'TargetClosedError';
  return e;
}

// One page whose text the test changes (logged out: "Sign in"; logged in: "New task").
function fakeBrowser() {
  const state = { text: 'Sign in', windowClosed: false, launchError: null, gotoGate: null, contexts: [] };
  return {
    state,
    newContext({ origins, guard, identity }) {
      if (state.launchError) throw state.launchError;
      const ctx = {
        identity, origins, guard, closed: false, url: null,
        goto: async (u) => { if (state.gotoGate) await state.gotoGate; ctx.url = u; },
        hasText: async (t) => {
          if (state.windowClosed || ctx.closed) throw closedError();
          return state.text.includes(t);
        },
        violations: () => [],
        fill: async () => {}, describe: async () => ({ type: 'password', autocomplete: 'current-password' }),
        url: () => ctx.url,
        close: async () => { ctx.closed = true; }
      };
      state.contexts.push(ctx);
      return ctx;
    }
  };
}

// The watch loop sleeps through `step()`: each step is one poll and moves the clock on by pollMs.
function harness({ flag = true, timeoutMs = 30 * 60 * 1000 } = {}) {
  const browser = fakeBrowser();
  const flags = { [ID]: flag };
  let clock = 1_000_000;
  const waiting = [];
  let authCalls = 0;
  const { dispatch, handoffs, sessions } = createDispatcher({
    authenticate: async () => { authCalls++; return { ok: true, agentId: 'a1', companyId: 'ca' }; },
    browser, policy: POLICY, sites: SITES,
    handoff: { isActive: (id) => flags[id] === true },
    handoffTimeoutMs: timeoutMs,
    handoffPollMs: 2000,
    handoffNow: () => clock,
    handoffSleep: (ms) => new Promise((resolve) => waiting.push(() => { clock += ms; resolve(); })),
    errorLog: { record: () => {} }
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const step = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      await flush();
      const next = waiting.shift();
      if (next) next();
      await flush();
    }
  };
  return { browser, flags, dispatch, handoffs, sessions, step, setClock: (v) => { clock = v; }, now: () => clock, authCalls: () => authCalls };
}

const handoffOpen = (h, identity = ID) => h.dispatch({ cmd: 'handoff-open', identity });

test('handoff-open is not an agent verb', () => {
  assert.deepEqual(HANDOFF_COMMANDS, ['handoff-open']);
  assert(!COMMANDS.includes('handoff-open'));
});

test('refused without root\'s flag; no browser is launched', async () => {
  const h = harness({ flag: false });
  const r = await handoffOpen(h);
  assert.equal(r.exit, EXIT.REFUSED_BY_POLICY);
  assert.equal(r.reason, 'handoff_not_active');
  assert.equal(h.browser.state.contexts.length, 0);
});

test('opens the login page with the identity profile, needs no agent token, stays open until the logged-in text shows', async () => {
  const h = harness();
  const r = await handoffOpen(h);
  assert.equal(r.exit, EXIT.DONE);
  assert.equal(r.ok, true);
  assert.equal(r.data.url, DASH);
  assert.equal(h.authCalls(), 0, 'root\'s flag authorises it, not an agent token');
  const ctx = h.browser.state.contexts[0];
  assert.equal(ctx.identity, ID);
  assert.equal(ctx.url, DASH);
  assert.equal(ctx.guard(DASH), true);
  assert.equal(ctx.guard('https://evil.example/x'), false, 'the origin wall still applies');

  // Logged out: unlike `open`, the window is not closed as session_expired.
  await h.step(5);
  assert.equal(ctx.closed, false);
  assert.equal(h.handoffs.isOpen(ID), true);

  h.browser.state.text = 'Dashboard New task';
  await h.step(1);
  assert.equal(await h.handoffs.done(ID), 'logged_in');
  assert.equal(ctx.closed, true);
  assert.equal(h.handoffs.isOpen(ID), false);

  // The status check now goes green: an agent `open` finds the logged-in text.
  const probe = await h.dispatch({ cmd: 'open', token: 't', issue: 'PAR-1', identity: ID });
  assert.equal(probe.exit, EXIT.DONE);
});

test('a second handoff-open for the same identity is refused, even when both arrive together', async () => {
  const h = harness();
  let release;
  h.browser.state.gotoGate = new Promise((resolve) => { release = resolve; });
  const first = handoffOpen(h);
  const second = await handoffOpen(h);
  assert.equal(second.exit, EXIT.USAGE);
  assert.equal(second.reason, 'handoff_already_open');
  release();
  assert.equal((await first).ok, true);
  const third = await handoffOpen(h);
  assert.equal(third.reason, 'handoff_already_open');
  assert.equal(h.browser.state.contexts.length, 1, 'one Chromium per profile');
});

test('closes when root removes the flag', async () => {
  const h = harness();
  await handoffOpen(h);
  await h.step(2);
  h.flags[ID] = false;
  await h.step(1);
  assert.equal(await h.handoffs.done(ID), 'flag_removed');
  assert.equal(h.browser.state.contexts[0].closed, true);
});

test('closes after the timeout', async () => {
  const h = harness({ timeoutMs: 60_000 });
  await handoffOpen(h);
  h.setClock(h.now() + 60_000);
  await h.step(1);
  assert.equal(await h.handoffs.done(ID), 'timeout');
  assert.equal(h.browser.state.contexts[0].closed, true);
});

test('ends when the person closes the window', async () => {
  const h = harness();
  await handoffOpen(h);
  h.browser.state.windowClosed = true;
  await h.step(1);
  assert.equal(await h.handoffs.done(ID), 'window_closed');
  assert.equal(h.handoffs.isOpen(ID), false);
});

test('agents cannot reach the hand-off window, and agent open waits for it to close', async () => {
  const h = harness();
  await handoffOpen(h);
  for (const cmd of ['fill', 'goto', 'text', 'shot', 'click']) {
    const r = await h.dispatch({ cmd, token: 't', issue: 'PAR-1', identity: ID, args: { selector: '#password', value: 'x', url: DASH } });
    assert.equal(r.reason, 'no_session', cmd);
  }
  const open = await h.dispatch({ cmd: 'open', token: 't', issue: 'PAR-1', identity: ID });
  assert.equal(open.exit, EXIT.NO_BROWSER);
  assert.equal(open.reason, 'handoff_open');
  assert.equal(h.browser.state.contexts.length, 1);
});

test('an agent session on the identity is closed before the person\'s window opens', async () => {
  const h = harness();
  h.browser.state.text = 'New task';
  assert.equal((await h.dispatch({ cmd: 'open', token: 't', issue: 'PAR-1', identity: ID })).exit, EXIT.DONE);
  const agentCtx = h.browser.state.contexts[0];
  h.browser.state.text = 'Sign in';
  await handoffOpen(h);
  assert.equal(agentCtx.closed, true);
  assert.equal(h.sessions.size, 0);
});

test('bad identity, unknown site and launch failure', async () => {
  const h = harness();
  assert.equal((await handoffOpen(h, '../x')).reason, 'identity_invalid');
  h.flags['pib:nosite'] = true;
  assert.equal((await handoffOpen(h, 'pib:nosite')).reason, 'site_not_found');

  const err = new Error('no chrome');
  err.code = 'NO_BROWSER';
  h.browser.state.launchError = err;
  const r = await handoffOpen(h);
  assert.equal(r.exit, EXIT.NO_BROWSER);
  assert.equal(r.reason, 'browser_launch_failed');
  assert.equal(h.handoffs.isOpen(ID), false, 'a failed launch frees the identity');
  h.browser.state.launchError = null;
  assert.equal((await handoffOpen(h)).ok, true);
});

test('a login URL outside the allowed origins is refused', async () => {
  const sites = { sites: { paperclip: { ...SITES.sites.paperclip, loggedIn: { url: 'https://evil.example/login', expect: 'x' } } } };
  const { dispatch } = createDispatcher({
    authenticate: async () => ({ ok: true }), browser: fakeBrowser(), policy: POLICY, sites,
    handoff: { isActive: () => true }, errorLog: { record: () => {} }
  });
  const r = await dispatch({ cmd: 'handoff-open', identity: ID });
  assert.equal(r.exit, EXIT.REFUSED_BY_POLICY);
  assert.equal(r.reason, 'origin not allowed');
});

test('PIB_BROWSER_HANDOFF_TIMEOUT_MS: default 30 min, bounded 1 min to 2 h', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 30 * 60 * 1000);
  assert.equal(handoffTimeoutMs({}), DEFAULT_TIMEOUT_MS);
  assert.equal(handoffTimeoutMs({ PIB_BROWSER_HANDOFF_TIMEOUT_MS: 'x' }), DEFAULT_TIMEOUT_MS);
  assert.equal(handoffTimeoutMs({ PIB_BROWSER_HANDOFF_TIMEOUT_MS: '-5' }), DEFAULT_TIMEOUT_MS);
  assert.equal(handoffTimeoutMs({ PIB_BROWSER_HANDOFF_TIMEOUT_MS: '10' }), 60 * 1000);
  assert.equal(handoffTimeoutMs({ PIB_BROWSER_HANDOFF_TIMEOUT_MS: '600000' }), 600000);
  assert.equal(handoffTimeoutMs({ PIB_BROWSER_HANDOFF_TIMEOUT_MS: String(9e9) }), 2 * 60 * 60 * 1000);
  assert.equal(loadConfig({ PIB_BROWSER_SOCKET: '/s', PIB_BROWSER_HANDOFF_TIMEOUT_MS: '120000' }).handoffTimeoutMs, 120000);
});

function cliIo() {
  const out = [];
  const err = [];
  return { out, err, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } };
}

test('CLI handoff-open sends only the identity (no token, no issue) and prints how the window closes', async () => {
  const io = cliIo();
  let sent;
  const code = await run(['handoff-open', '--identity', ID], {}, {
    ...io,
    send: async (req) => { sent = req; return { exit: 0, ok: true, data: { identity: ID, url: DASH, timeoutMs: 1800000 } }; }
  });
  assert.equal(code, 0);
  assert.deepEqual(sent, { cmd: 'handoff-open', identity: ID, args: {} });
  assert.match(io.out.join(''), /closes by itself once you are logged in.*after 30 min/s);
});

test('CLI handoff-open: identity required; daemon refusals keep their exit code', async () => {
  let io = cliIo();
  assert.equal(await run(['handoff-open'], {}, { ...io, send: async () => assert.fail('no call') }), 2);
  io = cliIo();
  const code = await run(['handoff-open', '--identity', ID], {}, { ...io, send: async () => ({ exit: 7, ok: false, reason: 'handoff_not_active' }) });
  assert.equal(code, 7);
  assert.match(io.err.join(''), /handoff_not_active/);
  io = cliIo();
  assert.equal(await run(['handoff-open', '--identity', ID], {}, { ...io, send: async () => { throw new Error('ENOENT'); } }), 3);
});
