'use strict';
// Waiting list (PAR-14514 S4): the tasks the daemon refused because a login was missing (`session_expired`)
// or a person held the browser (`handoff_open`). Cockpit's "Done" wakes exactly these. One entry per
// identity and issue (the latest time wins), kept 7 days, in one small file. A failed write is logged by
// its error code and never fails the agent's command.
const KEEP_MS = 7 * 24 * 60 * 60_000;
const MAX_ENTRIES = 500;

function createWaitingList({ file, fs = require('node:fs'), now = () => Date.now(), logger = () => {} }) {
  function read() {
    let entries = [];
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(j?.entries)) entries = j.entries;
    } catch (e) { /* no file yet, or unreadable: an empty list */ }
    const cutoff = now() - KEEP_MS;
    return entries.filter((e) => e && typeof e.identity === 'string' && typeof e.issue === 'string' && Date.parse(e.at) > cutoff);
  }

  function write(entries) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, entries }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function record(identity, issue, reason) {
    try {
      const entries = read().filter((e) => !(e.identity === identity && e.issue === issue));
      entries.push({ identity, issue, reason, at: new Date(now()).toISOString() });
      write(entries.slice(-MAX_ENTRIES));
    } catch (e) {
      logger(`pib-browser: waiting list not written: ${e?.code || e?.name || 'Error'}`);
    }
  }

  function list(identity) {
    const all = read();
    return identity === undefined ? all : all.filter((e) => e.identity === identity);
  }

  // Removes the named issues for `identity`; returns how many entries went.
  function clear(identity, issues) {
    const drop = new Set(issues);
    const all = read();
    const kept = all.filter((e) => !(e.identity === identity && drop.has(e.issue)));
    if (kept.length !== all.length) write(kept);
    return all.length - kept.length;
  }

  return { record, list, clear };
}

module.exports = { createWaitingList, KEEP_MS };
