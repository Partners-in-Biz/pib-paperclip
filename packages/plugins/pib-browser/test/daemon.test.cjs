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
  const server = createServer({ dispatch, socketMode: 0o660, logger });
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

test('listen - socket mode 0o600', () => {
  return mkSocket((sock) => {
    const dispatch = async () => ({ exit: 0 });
    const server = createServer({ dispatch, socketMode: 0o600, logger: () => {} });
    return listen(server, sock, 0o600).then(() => {
      assert.equal(fs.statSync(sock).mode & 0o777, 0o600);
      server.close();
    });
  });
});

test('listen - socket mode 0o660', () => {
  return mkSocket((sock) => {
    const dispatch = async () => ({ exit: 0 });
    const server = createServer({ dispatch, socketMode: 0o660, logger: () => {} });
    return listen(server, sock, 0o660).then(() => {
      assert.equal(fs.statSync(sock).mode & 0o777, 0o660);
      server.close();
    });
  });
});

test('listen - stale socket replaced', () => {
  return mkSocket((sock) => {
    fs.writeFileSync(sock, 'stale');
    const dispatch = async () => ({ exit: 0 });
    const server = createServer({ dispatch, socketMode: 0o660, logger: () => {} });
    return listen(server, sock, 0o660).then(() => {
      assert(fs.statSync(sock).isSocket());
      server.close();
    });
  });
});

test('createServer - logger never sees token', () => {
  return mkSocket((sock) => {
    const token = 'sk-secret1234567890';
    const logged = [];
    const dispatch = async () => ({ exit: 0 });
    const logger = (info) => logged.push(JSON.stringify(info));
    const server = createServer({ dispatch, socketMode: 0o660, logger });
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
    const { dispatch } = createDispatcher({ authenticate, browser: null, policy, sites, clock: () => new Date(), evidenceDir: '' });
    const server = createServer({ dispatch, socketMode: 0o660, logger: () => {} });

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
    const server1 = createServer({ dispatch: dispatch1, socketMode: 0o660, logger: () => {} });
    return listen(server1, sock, 0o660).then(() => {
      const dispatch2 = async () => ({ exit: 0 });
      const server2 = createServer({ dispatch: dispatch2, socketMode: 0o660, logger: () => {} });
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
