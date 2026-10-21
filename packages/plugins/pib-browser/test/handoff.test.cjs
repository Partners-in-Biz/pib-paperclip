'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createHandoff } = require('../src/handoff.cjs');

// Test with real file system
test('handoff - non-existent flag', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pib-test-'));
  try {
    const h = createHandoff({ dir: tmpDir });
    assert.equal(h.isActive('pib:test'), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('handoff - traversal identity rejected', () => {
  const h = createHandoff();
  assert.equal(h.isActive('../x'), false);
  assert.equal(h.isActive('pib:../../etc'), false);
});

test('handoff - identity not matching grammar', () => {
  const h = createHandoff();
  assert.equal(h.isActive('invalid'), false);
  assert.equal(h.isActive('pib:'), false);
  assert.equal(h.isActive('pib:a:b'), false);
  assert.equal(h.isActive(''), false);
  assert.equal(h.isActive(null), false);
});

// Test with fake fs object for privileged checks
test('handoff - root-owned dir and file', () => {
  const fakeFs = {
    lstatSync(p) {
      if (p === '/test-dir') {
        return {
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => false,
          uid: 0,
          mode: 0o40755 // directory, root, 755
        };
      }
      if (p === '/test-dir/pib:test') {
        return {
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
          uid: 0,
          mode: 0o100644 // file, root, 644
        };
      }
      throw new Error('ENOENT');
    }
  };
  const h = createHandoff({ dir: '/test-dir', fs: fakeFs });
  assert.equal(h.isActive('pib:test'), true);
});

test('handoff - file owned by non-root', () => {
  const fakeFs = {
    lstatSync(p) {
      if (p === '/test-dir') {
        return {
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => false,
          uid: 0,
          mode: 0o40755
        };
      }
      if (p === '/test-dir/pib:test') {
        return {
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
          uid: 1000, // non-root
          mode: 0o100644
        };
      }
      throw new Error('ENOENT');
    }
  };
  const h = createHandoff({ dir: '/test-dir', fs: fakeFs });
  assert.equal(h.isActive('pib:test'), false);
});

test('handoff - dir writable by group', () => {
  const fakeFs = {
    lstatSync(p) {
      if (p === '/test-dir') {
        return {
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => false,
          uid: 0,
          mode: 0o40775 // group-writable
        };
      }
      throw new Error('ENOENT');
    }
  };
  const h = createHandoff({ dir: '/test-dir', fs: fakeFs });
  assert.equal(h.isActive('pib:test'), false);
});

test('handoff - dir owned by non-root', () => {
  const fakeFs = {
    lstatSync(p) {
      if (p === '/test-dir') {
        return {
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => false,
          uid: 1000,
          mode: 0o40755
        };
      }
      throw new Error('ENOENT');
    }
  };
  const h = createHandoff({ dir: '/test-dir', fs: fakeFs });
  assert.equal(h.isActive('pib:test'), false);
});

test('handoff - flag is symlink', () => {
  const fakeFs = {
    lstatSync(p) {
      if (p === '/test-dir') {
        return {
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => false,
          uid: 0,
          mode: 0o40755
        };
      }
      if (p === '/test-dir/pib:test') {
        return {
          isDirectory: () => false,
          isFile: () => false,
          isSymbolicLink: () => true,
          uid: 0,
          mode: 0o120644
        };
      }
      throw new Error('ENOENT');
    }
  };
  const h = createHandoff({ dir: '/test-dir', fs: fakeFs });
  assert.equal(h.isActive('pib:test'), false);
});

test('handoff - lstat throws', () => {
  const fakeFs = {
    lstatSync(p) {
      throw new Error('permission denied');
    }
  };
  const h = createHandoff({ dir: '/test-dir', fs: fakeFs });
  assert.equal(h.isActive('pib:test'), false);
});
