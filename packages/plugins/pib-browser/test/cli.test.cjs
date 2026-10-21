'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { run, send } = require('../src/cli.cjs');

class MockOutput {
  constructor() {
    this.lines = [];
  }
  write(data) {
    this.lines.push(data);
    return this.lines.length;
  }
  toString() {
    return this.lines.join('');
  }
}

test('missing token returns exit 2', async () => {
  const stdout = new MockOutput();
  const stderr = new MockOutput();
  const code = await run(['open', '--identity', 'client:ca:meta', '--issue', 'PAR-1234'], {}, {
    stdout,
    stderr,
    send: async () => ({ exit: 0 })
  });
  assert.equal(code, 2);
  assert(stderr.toString().includes('PAPERCLIP_API_KEY'));
});

test('missing issue returns exit 2', async () => {
  const stdout = new MockOutput();
  const stderr = new MockOutput();
  const code = await run(['open', '--identity', 'client:ca:meta'], {
    PAPERCLIP_API_KEY: 'token'
  }, {
    stdout,
    stderr,
    send: async () => ({ exit: 0 })
  });
  assert.equal(code, 2);
  assert(stderr.toString().includes('--issue'));
});

test('missing identity returns exit 2', async () => {
  const stdout = new MockOutput();
  const stderr = new MockOutput();
  const code = await run(['open', '--issue', 'PAR-1234'], {
    PAPERCLIP_API_KEY: 'token'
  }, {
    stdout,
    stderr,
    send: async () => ({ exit: 0 })
  });
  assert.equal(code, 2);
  assert(stderr.toString().includes('--identity'));
});

test('unknown command returns exit 2', async () => {
  const stdout = new MockOutput();
  const stderr = new MockOutput();
  const code = await run(['unknown', '--identity', 'client:ca:meta', '--issue', 'PAR-1234'], {
    PAPERCLIP_API_KEY: 'token'
  }, {
    stdout,
    stderr,
    send: async () => ({ exit: 0 })
  });
  assert.equal(code, 2);
});

test('--help shows help text without password', async () => {
  const stdout = new MockOutput();
  const stderr = new MockOutput();
  const code = await run(['--help'], {}, {
    stdout,
    stderr,
    send: async () => ({ exit: 0 })
  });
  assert.equal(code, 0);
  const help = stdout.toString();
  assert(!help.includes('password'));
  assert(!help.includes('cookies'));
  assert(!help.includes('storage'));
  assert(!help.includes('evaluate'));
});

test('invalid region returns exit 2', async () => {
  const stdout = new MockOutput();
  const stderr = new MockOutput();
  const code = await run(['shot', '--identity', 'client:ca:meta', '--issue', 'PAR-1234', '--redact-region', 'invalid'], {
    PAPERCLIP_API_KEY: 'token'
  }, {
    stdout,
    stderr,
    send: async () => ({ exit: 0 })
  });
  assert.equal(code, 2);
});

test('daemon exit code passes through', async () => {
  const stdout = new MockOutput();
  const stderr = new MockOutput();
  const code = await run(['open', '--identity', 'client:ca:meta', '--issue', 'PAR-1234'], {
    PAPERCLIP_API_KEY: 'token'
  }, {
    stdout,
    stderr,
    send: async () => ({ exit: 7, ok: false, reason: 'test_reason' })
  });
  assert.equal(code, 7);
});

test('daemon exit 8 passes through', async () => {
  const stdout = new MockOutput();
  const stderr = new MockOutput();
  const code = await run(['click', '--identity', 'client:ca:meta', '--issue', 'PAR-1234', '--selector', 'button'], {
    PAPERCLIP_API_KEY: 'token'
  }, {
    stdout,
    stderr,
    send: async () => ({ exit: 8, ok: false, reason: 'needs_approval' })
  });
  assert.equal(code, 8);
});

test('shot with valid args calls send', async () => {
  let sendCalled = false;
  const stdout = new MockOutput();
  const stderr = new MockOutput();
  const code = await run(
    ['shot', '--identity', 'client:ca:meta', '--issue', 'PAR-1234'],
    {
      PAPERCLIP_API_KEY: 'token',
      PIB_EVIDENCE_ROOT: '/tmp'
    },
    {
      stdout,
      stderr,
      send: async (request) => {
        sendCalled = true;
        assert.equal(request.cmd, 'shot');
        assert.equal(request.issue, 'PAR-1234');
        return { exit: 3, ok: false, reason: 'no_browser' };
      }
    }
  );

  assert(sendCalled, 'send should be called');
  assert.equal(code, 3);
});

test('token never appears in stdout/stderr', async () => {
  const CANARY = 'UNIQUE_TOKEN_12345';
  const stdout = new MockOutput();
  const stderr = new MockOutput();
  const code = await run(['open', '--identity', 'client:ca:meta', '--issue', 'PAR-1234'], {
    PAPERCLIP_API_KEY: CANARY
  }, {
    stdout,
    stderr,
    send: async () => ({ exit: 0, ok: true })
  });

  assert.equal(code, 0);
  const combined = stdout.toString() + stderr.toString();
  assert(!combined.includes(CANARY));
});

test('value flag never appears in stdout/stderr', async () => {
  const CANARY = 'SECRET_VALUE_67890';
  const stdout = new MockOutput();
  const stderr = new MockOutput();
  const code = await run(['fill', '--identity', 'client:ca:meta', '--issue', 'PAR-1234', '--selector', 'input', '--value', CANARY], {
    PAPERCLIP_API_KEY: 'token'
  }, {
    stdout,
    stderr,
    send: async () => ({ exit: 0, ok: true, data: { filled: true } })
  });

  assert.equal(code, 0);
  const combined = stdout.toString() + stderr.toString();
  assert(!combined.includes(CANARY));
});

test('response exceeding size limit returns exit 3', async (t) => {
  const net = require('node:net');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pib-socket-test-'));
  const socketPath = path.join(tempDir, 'test.sock');

  // Create a test server that streams more than the cap
  const server = net.createServer((socket) => {
    socket.on('data', () => {
      // Stream 2KB in chunks to exceed the 1KB limit
      socket.write('x'.repeat(600));
      socket.write('x'.repeat(600));
    });
  });

  await new Promise((resolve, reject) => {
    server.listen(socketPath, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  try {
    const FAKE_TOKEN = 'fake_token_12345678';
    const stdout = new MockOutput();
    const stderr = new MockOutput();

    // Use a tiny cap of 1KB for the test
    const code = await run(['open', '--identity', 'client:ca:meta', '--issue', 'PAR-1234'], {
      PAPERCLIP_API_KEY: FAKE_TOKEN,
      PIB_BROWSER_SOCKET: socketPath
    }, {
      stdout,
      stderr,
      maxResponseBytes: 1024,
      send
    });

    assert.equal(code, 3, 'Should return exit code 3 for oversized response');
    const combined = stdout.toString() + stderr.toString();
    assert(!combined.includes(FAKE_TOKEN), 'Token should not appear in output');
    assert(combined.includes('connection failed'), 'Should show generic error message');
  } finally {
    await new Promise((resolve) => {
      server.close(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
        resolve();
      });
    });
  }
});

test('~200 KiB valid JSON response is accepted', async (t) => {
  const net = require('node:net');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pib-socket-test-'));
  const socketPath = path.join(tempDir, 'test.sock');

  // Create a test server that sends a valid 200KB JSON response
  const server = net.createServer((socket) => {
    socket.on('data', () => {
      const largeData = 'x'.repeat(200 * 1024);
      const response = JSON.stringify({ exit: 0, ok: true, data: { result: largeData } });
      socket.write(response + '\n');
    });
  });

  await new Promise((resolve, reject) => {
    server.listen(socketPath, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  try {
    const response = await send(
      { cmd: 'open', token: 'test', issue: 'PAR-1234', identity: 'test:id', args: {} },
      { socketPath }
    );

    assert.equal(response.exit, 0, 'Should parse the response successfully');
    assert.equal(response.ok, true, 'Response should be valid');
    assert(response.data.result.length === 200 * 1024, 'Should preserve the large data');
  } finally {
    await new Promise((resolve) => {
      server.close(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
        resolve();
      });
    });
  }
});

test('probe exit code mapping with nullish coalescing: ok:true exit:0', async () => {
  const stdout = new MockOutput();
  const stderr = new MockOutput();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pib-probe-test-'));
  const statusPath = path.join(tempDir, 'status.json');

  try {
    const code = await run(['probe', '--all', '--issue', 'PAR-1', '--identities', 'test:id1'], {
      PAPERCLIP_API_KEY: 'test_token',
      PIB_BROWSER_STATUS: statusPath
    }, {
      stdout,
      stderr,
      send: async (req) => {
        assert.equal(req.cmd, 'open');
        return { exit: 0, ok: true };
      }
    });

    assert.equal(code, 0);
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    assert.equal(status.identities['test:id1'].ok, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('probe exit code mapping with nullish coalescing: ok:false exit:6', async () => {
  const stdout = new MockOutput();
  const stderr = new MockOutput();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pib-probe-test-'));
  const statusPath = path.join(tempDir, 'status.json');

  try {
    const code = await run(['probe', '--all', '--issue', 'PAR-1', '--identities', 'test:id2'], {
      PAPERCLIP_API_KEY: 'test_token',
      PIB_BROWSER_STATUS: statusPath
    }, {
      stdout,
      stderr,
      send: async (req) => {
        return { exit: 6, ok: false, reason: 'session_expired' };
      }
    });

    assert.equal(code, 0);
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    assert.equal(status.identities['test:id2'].ok, false);
    assert.equal(status.identities['test:id2'].reason, 'session_expired');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('probe missing --issue returns exit 2', async () => {
  const stdout = new MockOutput();
  const stderr = new MockOutput();

  const code = await run(['probe', '--all', '--identities', 'test:id'], {
    PAPERCLIP_API_KEY: 'test_token'
  }, {
    stdout,
    stderr,
    send: async () => ({ exit: 0, ok: true })
  });

  assert.equal(code, 2);
  assert(stderr.toString().includes('--issue'));
});

test('probe missing --all returns exit 2', async () => {
  const stdout = new MockOutput();
  const stderr = new MockOutput();

  const code = await run(['probe', '--issue', 'PAR-1234', '--identities', 'test:id'], {
    PAPERCLIP_API_KEY: 'test_token'
  }, {
    stdout,
    stderr,
    send: async () => ({ exit: 0, ok: true })
  });

  assert.equal(code, 2);
  assert(stderr.toString().includes('--all'));
});

test('probe missing PAPERCLIP_API_KEY returns exit 2', async () => {
  const stdout = new MockOutput();
  const stderr = new MockOutput();

  const code = await run(['probe', '--all', '--issue', 'PAR-1234', '--identities', 'test:id'], {}, {
    stdout,
    stderr,
    send: async () => ({ exit: 0, ok: true })
  });

  assert.equal(code, 2);
  assert(stderr.toString().includes('PAPERCLIP_API_KEY'));
});
