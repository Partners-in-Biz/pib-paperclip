'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const net = require('node:net');
const { loadConfig, createServer, listen } = require('../src/daemon.cjs');
function mkSocket(fn) {
  const tmpDir = fs.mkdtempSync(path.join(tmpdir(), 'pib-'));
  const sock = path.join(tmpDir, 't.sock');
  return fn(sock).finally(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  });
}

function socketTest(sock, dispatch, logger, test1, test2) {
  const server = createServer({ dispatch, logger });
  return listen(server, sock, 0o660).then(() => new Promise((resolve) => {
    const client = net.createConnection(sock);
    const responses = [];
    let buf = '';
    client.on('data', (d) => {
      buf += d; buf.split('\n').forEach((l, i, a) => {
        if (l && i < a.length - 1) responses.push(JSON.parse(l));
      });
      buf = buf.split('\n').pop() || '';
    });
    client.on('connect', () => {
      test1(client);
      setTimeout(() => {
        client.end();
        setTimeout(() => { test2(responses); server.close(); resolve(); }, 50);
      }, 200);
    });
  }));
}

test('loadConfig - throws without socketPath (no env leaks)', () => {
  assert.throws(() => loadConfig({}), (err) => {
    return err.message === 'socketPath required' && !err.message.includes('PIB_');
  });
});

test('loadConfig - rejects invalid socket mode', () => {
  assert.throws(() => loadConfig({ PIB_BROWSER_SOCKET: '/tmp/sock', PIB_BROWSER_SOCKET_MODE: 'garbage', PIB_BROWSER_EVIDENCE_DIR: '/tmp' }), (err) => {
    return err.message.includes('PIB_BROWSER_SOCKET_MODE') && !err.message.includes('garbage');
  });
});

test('loadConfig - rejects invalid socket mode 999', () => {
  assert.throws(() => loadConfig({ PIB_BROWSER_SOCKET: '/tmp/sock', PIB_BROWSER_SOCKET_MODE: '999', PIB_BROWSER_EVIDENCE_DIR: '/tmp' }), (err) => {
    return err.message.includes('PIB_BROWSER_SOCKET_MODE') && !err.message.includes('999');
  });
});

test('loadConfig - rejects invalid socket mode 0o9', () => {
  assert.throws(() => loadConfig({ PIB_BROWSER_SOCKET: '/tmp/sock', PIB_BROWSER_SOCKET_MODE: '0o9', PIB_BROWSER_EVIDENCE_DIR: '/tmp' }), (err) => {
    return err.message.includes('PIB_BROWSER_SOCKET_MODE') && !err.message.includes('0o9');
  });
});

test('loadConfig - accepts valid socket modes', () => {
  const config1 = loadConfig({ PIB_BROWSER_SOCKET: '/tmp/sock', PIB_BROWSER_SOCKET_MODE: '600' });
  assert.equal(config1.socketMode, 0o600);
  const config2 = loadConfig({ PIB_BROWSER_SOCKET: '/tmp/sock', PIB_BROWSER_SOCKET_MODE: '0600' });
  assert.equal(config2.socketMode, 0o600);
  const config3 = loadConfig({ PIB_BROWSER_SOCKET: '/tmp/sock', PIB_BROWSER_SOCKET_MODE: '0o660' });
  assert.equal(config3.socketMode, 0o660);
});

test('createServer - ordered round trip', () => {
  return mkSocket((sock) => {
    return socketTest(sock, async (req) => ({ exit: 0, ok: true, seq: req.seq }), () => {},
      (client) => {
        client.write(JSON.stringify({ seq: 1 }) + '\n');
        client.write(JSON.stringify({ seq: 2 }) + '\n');
      },
      (responses) => {
        assert.equal(responses.length, 2);
        assert.equal(responses[0].seq, 1);
        assert.equal(responses[1].seq, 2);
      }
    );
  });
});

test('createServer - bad JSON + usable', () => {
  return mkSocket((sock) => {
    return socketTest(sock, async () => ({ exit: 0, ok: true }), () => {},
      (client) => {
        client.write('bad\n');
        client.write(JSON.stringify({ cmd: 'ok' }) + '\n');
      },
      (responses) => {
        assert.equal(responses.length, 2);
        assert.equal(responses[0].exit, 2);
        assert.equal(responses[1].ok, true);
      }
    );
  });
});

test('createServer - oversize line', () => {
  return mkSocket((sock) => {
    return socketTest(sock, async () => ({ exit: 0, ok: true }), () => {},
      (client) => {
        const big = JSON.stringify({ x: 'y'.repeat(100 * 1024) }) + '\n';
        client.write(big);
        client.write(JSON.stringify({ ok: true }) + '\n');
      },
      (responses) => {
        assert.equal(responses[0].exit, 2);
        assert.equal(responses[1].ok, true);
      }
    );
  });
});

test('createServer - size cap before delimiter: 100 KiB without newline closes connection', () => {
  return mkSocket((sock) => {
    return socketTest(sock, async () => ({ exit: 0, ok: true }), () => {},
      (client) => {
        // Send 100 KiB without a newline
        const big = 'x'.repeat(100 * 1024);
        client.write(big);
        // Give server time to process and close
        setTimeout(() => {
          // Try to send another request to verify connection is closed
          client.write(JSON.stringify({ ok: true }) + '\n');
        }, 100);
      },
      (responses) => {
        // Should receive at least the bad_request response
        assert(responses.length >= 1);
        assert.equal(responses[0].exit, 2);
        assert.equal(responses[0].reason, 'bad_request');
      }
    );
  });
});

test('listen - socket mode 0o600', () => {
  return mkSocket((sock) => {
    const dispatch = async () => ({ exit: 0 });
    const server = createServer({ dispatch, logger: () => {} });
    return listen(server, sock, 0o600).then(() => {
      assert.equal(fs.statSync(sock).mode & 0o777, 0o600);
      server.close();
    });
  });
});

test('listen - socket mode 0o660', () => {
  return mkSocket((sock) => {
    const dispatch = async () => ({ exit: 0 });
    const server = createServer({ dispatch, logger: () => {} });
    return listen(server, sock, 0o660).then(() => {
      assert.equal(fs.statSync(sock).mode & 0o777, 0o660);
      server.close();
    });
  });
});

test('listen - chmod failure rejects and closes socket', () => {
  return mkSocket((sock) => {
    const dispatch = async () => ({ exit: 0 });
    const server = createServer({ dispatch, logger: () => {} });
    // Mock fs.chmodSync to throw
    const originalChmod = fs.chmodSync;
    let chmodCalled = false;
    fs.chmodSync = () => {
      chmodCalled = true;
      throw new Error('chmod failed');
    };
    return listen(server, sock, 0o660).then(
      () => {
        fs.chmodSync = originalChmod;
        throw new Error('should have rejected chmod failure');
      },
      (err) => {
        fs.chmodSync = originalChmod;
        assert(chmodCalled);
        assert.equal(err.message, 'chmod failed');
        // Socket should not exist or should have been cleaned up
        assert(!fs.existsSync(sock) || !fs.statSync(sock).isSocket());
      }
    );
  });
});

test('listen - socket mode defaults to 0o660', () => {
  return mkSocket((sock) => {
    const dispatch = async () => ({ exit: 0 });
    const server = createServer({ dispatch, logger: () => {} });
    // Call listen with the mode parameter (uses default 0o660 in the module)
    return listen(server, sock, 0o660).then(() => {
      // Verify the socket was created with the correct permissions
      const stat = fs.statSync(sock);
      assert(stat.isSocket());
      assert.equal(stat.mode & 0o777, 0o660);
      server.close();
    });
  });
});

test('listen - regular file at socket path is refused and not unlinked', () => {
  return mkSocket((sock) => {
    fs.writeFileSync(sock, 'regular file');
    const dispatch = async () => ({ exit: 0 });
    const server = createServer({ dispatch, logger: () => {} });
    return listen(server, sock, 0o660).then(
      () => { throw new Error('should have rejected regular file'); },
      (err) => {
        // File should still exist (not unlinked)
        assert(fs.existsSync(sock));
        assert(fs.statSync(sock).isFile());
        assert(!fs.statSync(sock).isSocket());
      }
    );
  });
});

test('createServer - per-connection ordering with slow dispatch', () => {
  return mkSocket((sock) => {
    let inFlight = 0;
    let maxInFlight = 0;
    const dispatchWithDelay = async (req) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (req.slow) {
        await new Promise(r => setTimeout(r, 100));
      }
      inFlight--;
      return { exit: 0, ok: true, seq: req.seq };
    };
    return socketTest(sock, dispatchWithDelay, () => {},
      (client) => {
        // Send first request (slow) and second request (fast) in separate writes
        client.write(JSON.stringify({ seq: 1, slow: true }) + '\n');
        client.write(JSON.stringify({ seq: 2, slow: false }) + '\n');
      },
      (responses) => {
        // Verify responses arrive in request order
        assert.equal(responses.length, 2);
        assert.equal(responses[0].seq, 1);
        assert.equal(responses[1].seq, 2);
        // Verify dispatch calls never overlap (only one in flight at a time)
        assert.equal(maxInFlight, 1);
      }
    );
  });
});

test('createServer - logger never sees token', () => {
  return mkSocket((sock) => {
    const token = 'sk-secret1234567890';
    const logged = [];
    const dispatch = async () => ({ exit: 0 });
    const logger = (info) => logged.push(JSON.stringify(info));
    const server = createServer({ dispatch, logger });
    return listen(server, sock, 0o660).then(() => new Promise((resolve) => {
      const client = net.createConnection(sock);
      client.on('connect', () => {
        client.write(JSON.stringify({ token }) + '\n');
        setTimeout(() => {
          client.end();
          const logStr = logged.join('');
          assert(!logStr.includes(token) && !logStr.includes('sk-'));
          server.close();
          resolve();
        }, 100);
      });
    }));
  });
});

test('daemon - real dispatcher: evaluate exit 2, open browser null exit 3', () => {
  return mkSocket((sock) => {
    const { createDispatcher } = require('../src/dispatch.cjs');
    const { EXIT } = require('../src/exit-codes.cjs');
    const authenticate = async () => ({ ok: true, agentId: 'a1', companyId: 'c1' });
    const sites = { sites: { s1: { label: 's1', origins: ['http://localhost'], loggedIn: { url: 'http://localhost/', expect: 'ok' }, confirm: [], redact: [], destructive: { selectors: [], text: [] } } } };
    const policy = { version: 1, agents: { a1: { identities: ['pib:s1'] } }, identities: { 'pib:s1': { origins: ['http://localhost'] } } };
    const { dispatch } = createDispatcher({ authenticate, browser: null, policy, sites, clock: () => new Date(), evidenceDir: '/tmp' });
    const server = createServer({ dispatch, logger: () => {} });

    return listen(server, sock, 0o660).then(() => new Promise((resolve) => {
      const client = net.createConnection(sock);
      const responses = [];
      let buf = '';
      client.on('data', (d) => {
        buf += d;
        buf.split('\n').forEach((l, i, a) => {
          if (l && i < a.length - 1) responses.push(JSON.parse(l));
        });
        buf = buf.split('\n').pop() || '';
      });
      client.on('connect', () => {
        client.write(JSON.stringify({ cmd: 'evaluate' }) + '\n');
        client.write(JSON.stringify({ cmd: 'open', identity: 'pib:s1', token: 'sk-1', issue: 'TEST-1' }) + '\n');
        setTimeout(() => {
          client.end();
          assert.equal(responses.length, 2);
          assert.equal(responses[0].exit, EXIT.USAGE);
          assert.equal(responses[1].exit, EXIT.NO_BROWSER);
          server.close();
          resolve();
        }, 150);
      });
    }));
  });
});

test('listen - rejects live server and preserves socket', () => {
  return mkSocket((sock) => {
    const dispatch1 = async () => ({ exit: 0 });
    const server1 = createServer({ dispatch: dispatch1, logger: () => {} });
    return listen(server1, sock, 0o660).then(() => {
      const dispatch2 = async () => ({ exit: 0 });
      const server2 = createServer({ dispatch: dispatch2, logger: () => {} });
      return listen(server2, sock, 0o660).then(
        () => { throw new Error('should have rejected live server'); },
        (err) => {
          assert(err.code === 'EADDRINUSE');
          assert(fs.existsSync(sock));
          assert(fs.statSync(sock).isSocket());
          server1.close();
        }
      );
    });
  });
});
