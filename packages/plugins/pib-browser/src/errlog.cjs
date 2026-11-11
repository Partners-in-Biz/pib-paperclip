'use strict';
// Agent-readable error log for the daemon (PAR-9187). One JSON line per failure.
// Never logs tokens, fill values, page text or query strings: only the command,
// identity, issue, the error class, the first line of the message and stack frames.
const DEFAULT_ERROR_LOG = '/run/pib-browser/errors.log';
const MAX_BYTES = 1024 * 1024;

function scrub(s) {
  return String(s || '')
    .replace(/(https?:\/\/[^\s?#'"`]+)[?#][^\s'"`]*/g, '$1')
    .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 [redacted]')
    .replace(/\b(pcp|pcgt|sk|pk|ghp|gho|xox[a-z])[_-][A-Za-z0-9_\-.]+/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_.-]+/g, '[redacted]')
    .replace(/[A-Za-z0-9+=_]{32,}/g, '[redacted]');
}

// First line only: Playwright appends a call log and, for strict-mode errors,
// the matched elements' HTML on later lines. That is page content; drop it.
function summarise(err) {
  const name = (err && (err.name || err.constructor?.name)) || 'Error';
  const message = scrub(String(err?.message ?? err).split('\n')[0]).slice(0, 300);
  const stack = String(err?.stack || '')
    .split('\n')
    .filter((l) => /^\s+at\s/.test(l))
    .slice(0, 10)
    .map((l) => scrub(l.trim()).slice(0, 200));
  return { name, code: typeof err?.code === 'string' ? err.code : undefined, message, stack };
}

function createErrorLog({ path = DEFAULT_ERROR_LOG, fs = require('node:fs'), clock = () => new Date() } = {}) {
  let chmodDone = false;
  function record({ cmd, issue, identity, phase, error }) {
    const line = JSON.stringify({
      ts: clock().toISOString(),
      cmd: typeof cmd === 'string' ? cmd.slice(0, 20) : undefined,
      issue: typeof issue === 'string' && /^[A-Z]+-\d+$/.test(issue) ? issue : undefined,
      identity: typeof identity === 'string' ? identity.slice(0, 100) : undefined,
      phase,
      error: summarise(error)
    }) + '\n';
    try {
      try {
        if (fs.statSync(path).size > MAX_BYTES) fs.renameSync(path, path + '.1');
      } catch (e) { /* missing file is fine */ }
      fs.appendFileSync(path, line, { mode: 0o640 });
      if (!chmodDone) { try { fs.chmodSync(path, 0o640); } catch (e) {} chmodDone = true; }
    } catch (e) { /* logging must never break a command */ }
  }
  return { record, path };
}

module.exports = { createErrorLog, summarise, scrub, DEFAULT_ERROR_LOG };
