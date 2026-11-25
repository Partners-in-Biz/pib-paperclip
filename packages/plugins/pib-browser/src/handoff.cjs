'use strict';
const path = require('node:path');
const { parseIdentity } = require('./policy.cjs');

// A hand-off is active while root's flag exists (break-glass) OR a person's take-over lease is live for the
// identity (PAR-14514 S4). The lease check sits here so the window's 2-second watch loop keeps it open.
function createHandoff({ dir = '/run/pib-browser/handoff', fs = require('node:fs'), lease = null } = {}) {
  return {
    isActive(identity) {
      try {
        // Validate identity format with parseIdentity
        if (!parseIdentity(identity)) return false;
        if (lease && lease.isLive(identity)) return true;

        // Check the flag directory and file ownership/permissions. The parent /run/pib-browser
        // directory must itself be root-owned, created by the installer or systemd RuntimeDirectory.
        // This function does not verify parent directory ownership.

        // Check directory: real directory, root-owned, not group/world-writable
        const dirStat = fs.lstatSync(dir);
        if (!dirStat.isDirectory() || dirStat.uid !== 0 || (dirStat.mode & 0o022) !== 0) {
          return false;
        }

        // Check flag file: regular file, root-owned, not group/world-writable
        const flagPath = path.join(dir, identity);
        const fileStat = fs.lstatSync(flagPath);
        if (!fileStat.isFile() || fileStat.uid !== 0 || (fileStat.mode & 0o022) !== 0) {
          return false;
        }

        return true;
      } catch (e) {
        // Any error (file not found, permission, etc) => fail closed
        return false;
      }
    }
  };
}

module.exports = { createHandoff };
