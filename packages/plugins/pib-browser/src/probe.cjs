'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { redactText } = require('./redact.cjs');
const { exitName } = require('./exit-codes.cjs');

function validateStatus(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (typeof obj.checkedAt !== 'string') return false;
  if (!obj.identities || typeof obj.identities !== 'object' || Array.isArray(obj.identities)) return false;

  for (const id in obj.identities) {
    const result = obj.identities[id];
    if (!result || typeof result !== 'object') return false;
    if (typeof result.ok !== 'boolean') return false;
    if (typeof result.reason !== 'string') return false;
  }
  return true;
}

async function probeAll({ identities = [], check, outPath, fs: fsLib = fs, now = () => new Date() }) {
  if (!check) throw new Error('check function required');
  if (!identities || identities.length === 0) {
    return { exit: 4, reason: 'no_identities' };
  }

  const results = {};
  for (const id of identities) {
    let result;
    try {
      result = await check(id);
    } catch (e) {
      result = { exit: 3, reason: 'no_browser' };
    }
    const name = exitName(result.exit);
    const reason = result.reason || (name && name !== 'done' ? name : '');
    results[id] = {
      ok: result.exit === 0,
      reason: redactText(reason)
    };
  }

  const status = {
    checkedAt: now().toISOString(),
    identities: results
  };

  if (!validateStatus(status)) {
    return { exit: 4, reason: 'invalid_status_generated' };
  }

  // Write atomically
  const resolved = path.resolve(outPath);
  const dir = path.dirname(resolved);
  const pid = process.pid;
  const rand = crypto.randomBytes(4).toString('hex');
  const tmpPath = `${resolved}.tmp-${pid}-${rand}`;

  try {
    fsLib.mkdirSync(dir, { recursive: true, mode: 0o750 });
    fsLib.writeFileSync(tmpPath, JSON.stringify(status, null, 2) + '\n', { mode: 0o640 });
    fsLib.renameSync(tmpPath, resolved);
  } catch (e) {
    try { fsLib.unlinkSync(tmpPath); } catch (e2) {}
    return { exit: 5, reason: 'write_failed' };
  }

  return { exit: 0, reason: '' };
}

module.exports = { validateStatus, probeAll };
