'use strict';
const path = require('node:path');
const { parseIdentity } = require('./policy.cjs');

function createHandoff({ dir = '/run/pib-browser/handoff', fs = require('node:fs') } = {}) {
  return {
    isActive(identity) {
      try {
        // Validate identity format with parseIdentity
        if (!parseIdentity(identity)) return false;

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
