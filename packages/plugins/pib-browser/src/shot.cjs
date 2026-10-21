'use strict';
const crypto = require('node:crypto');
const path = require('node:path');

const ISSUE_RE = /^[A-Z]+-\d+$/;

function evidencePath({ root, issue, step = 'shot', now = new Date() }) {
  // Validate issue format
  if (!ISSUE_RE.test(issue)) {
    throw new Error('Invalid issue format');
  }

  // Sanitize step: keep only alphanumeric and hyphens
  const sanitizedStep = String(step).replace(/[^a-z0-9-]/g, '');
  if (!sanitizedStep) {
    throw new Error('Invalid step name');
  }

  // Format timestamp as YYYYMMDDTHHMMSSZ
  const iso = now.toISOString();
  const timestamp = iso.replace(/[-:]/g, '').replace('Z', 'Z');

  // Construct path: <root>/<PAR-n>/<PAR-n>-<step>-<YYYYMMDDTHHMMSSZ>.png
  const filePath = path.join(root, issue, `${issue}-${sanitizedStep}-${timestamp}.png`);

  // Check for path traversal
  const resolvedPath = path.resolve(filePath);
  const resolvedRoot = path.resolve(root);
  if (!resolvedPath.startsWith(resolvedRoot)) {
    throw new Error('Path traversal detected');
  }

  return resolvedPath;
}

function writeShot({ fs, root, issue, step = 'shot', now = new Date(), b64, sha256 }) {
  try {
    // Decode base64
    const bytes = Buffer.from(b64, 'base64');

    // Verify SHA256
    const computedHash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (computedHash !== sha256) {
      return { exit: 5, reason: 'sha_mismatch' };
    }

    // Generate evidence path
    let filePath;
    try {
      filePath = evidencePath({ root, issue, step, now });
    } catch (e) {
      return { exit: 2, reason: 'invalid_path' };
    }

    // Create directories if needed
    const dir = path.dirname(filePath);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    } catch (e) {
      return { exit: 5, reason: 'mkdir_failed' };
    }

    // Write file with mode 0o640
    try {
      fs.writeFileSync(filePath, bytes, { mode: 0o640 });
    } catch (e) {
      return { exit: 5, reason: 'write_failed' };
    }

    return {
      path: filePath,
      bytes: bytes.length,
      sha256
    };
  } catch (e) {
    return { exit: 5, reason: 'internal_error' };
  }
}

module.exports = { evidencePath, writeShot };
