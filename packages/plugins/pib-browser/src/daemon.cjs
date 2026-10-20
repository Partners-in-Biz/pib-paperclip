'use strict';
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const { EXIT } = require('./exit-codes.cjs');
const { createApprovalStore, verifyApproval } = require('./approval.cjs');
const { createHandoff } = require('./handoff.cjs');
const { checkFill } = require('./fill-rules.cjs');
const { authenticate: authFn } = require('./auth.cjs');

const MAX_LINE_SIZE = 64 * 1024; // 64 KiB

function loadConfig(env) {
  const socketPath = env.PIB_BROWSER_SOCKET;
  if (!socketPath) throw new Error('socketPath required');
  let socketMode = 0o660;
  if (env.PIB_BROWSER_SOCKET_MODE) {
    const m = env.PIB_BROWSER_SOCKET_MODE;
    // Validate socket mode: accept only octal strings matching /^(0o)?[0-7]{3,4}$/
    if (!/^(0o)?[0-7]{3,4}$/.test(m)) {
      throw new Error('PIB_BROWSER_SOCKET_MODE must be a valid octal string (e.g., 600, 0600, 0o660)');
    }
    socketMode = parseInt((m.startsWith('0o') || m.startsWith('0O') ? m.slice(2) : m), 8);
  }
  const apiBase = (env.PIB_BROWSER_API || env.PAPERCLIP_API_URL || 'http://localhost:3100')
    .replace(/\/+$/, '');
  const evidenceDir = env.PIB_BROWSER_EVIDENCE_DIR;
  // Validate evidenceDir: must be provided and must be absolute
  if (!evidenceDir) {
    throw new Error('PIB_BROWSER_EVIDENCE_DIR is required');
  }
  if (!path.isAbsolute(evidenceDir)) {
    throw new Error('PIB_BROWSER_EVIDENCE_DIR must be an absolute path');
  }
  return {
    socketPath, socketMode,
    evidenceDir,
    apiBase,
    policyPath: env.PIB_BROWSER_POLICY || '',
    sitesPath: env.PIB_BROWSER_SITES || '',
    stateDir: env.PIB_BROWSER_STATE_DIR || '/var/lib/pib-browser',
    handoffDir: env.PIB_BROWSER_HANDOFF_DIR || '/run/pib-browser/handoff'
  };
}
function createServer(deps) {
  const { dispatch, logger } = deps;
  return net.createServer((socket) => {
    let buffer = '';
    let closed = false;
    let requestQueue = Promise.resolve();
    socket.on('data', async (chunk) => {
      if (closed) return;
      buffer += chunk.toString('utf8');
      while (true) {
        // Size cap before delimiter: if buffer is too large and has no newline, reject and close
        if (buffer.length > MAX_LINE_SIZE && !buffer.includes('\n')) {
          socket.write(JSON.stringify({ exit: 2, ok: false, reason: 'bad_request' }) + '\n');
          buffer = '';
          socket.destroy();
          return;
        }
        const idx = buffer.indexOf('\n');
        if (idx === -1) break;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.length > MAX_LINE_SIZE) {
          socket.write(JSON.stringify({ exit: 2, ok: false, reason: 'bad_request' }) + '\n');
          continue;
        }
        let req;
        try { req = JSON.parse(line); } catch (e) {
          socket.write(JSON.stringify({ exit: 2, ok: false, reason: 'bad_request' }) + '\n');
          continue;
        }
        // Chain request handling per connection with promise queue
        requestQueue = requestQueue.then(() => {
          const start = Date.now();
          const cmd = req.cmd || req.command || 'unknown';
          return Promise.resolve().then(async () => {
            try {
              const result = await dispatch(req);
              socket.write(JSON.stringify(result) + '\n');
              logger({ cmd, exit: result.exit, ms: Date.now() - start });
            } catch (e) {
              const result = { exit: EXIT.USAGE, ok: false, reason: 'dispatch_error' };
              socket.write(JSON.stringify(result) + '\n');
              logger({ cmd, exit: result.exit, ms: Date.now() - start });
            }
          });
        }).catch(() => {
          // Catch errors so a throw never breaks the chain
        });
      }
    });
    socket.on('end', () => { closed = true; });
    socket.on('error', () => { closed = true; });
  });
}

function listen(server, socketPath, socketMode) {
  return new Promise((resolve, reject) => {
    const tryListen = () => {
      const prevUmask = process.umask(~socketMode & 0o777);
      try {
        server.listen(socketPath, () => {
          try {
            fs.chmodSync(socketPath, socketMode);
          } catch (err) {
            process.umask(prevUmask);
            server.close(() => {
              try { fs.unlinkSync(socketPath); } catch (e) {}
            });
            return reject(err);
          }
          process.umask(prevUmask);
          resolve();
        });
      } finally {
        process.umask(prevUmask);
      }
      server.once('error', (err) => {
        if (err.code !== 'EADDRINUSE') return reject(err);
        // Check if the socket path is a stale socket or something else
        let isStaleSocket = false;
        try {
          const stat = fs.lstatSync(socketPath);
          if (!stat.isSocket()) {
            // Path exists but is not a socket, reject and do not unlink
            return reject(err);
          }
          isStaleSocket = true;
        } catch (e) {
          // Path doesn't exist, try listening again
          isStaleSocket = false;
        }
        if (isStaleSocket) {
          // Try to connect to verify it's really stale
          const testClient = net.createConnection(socketPath);
          let connected = false;
          testClient.on('connect', () => {
            connected = true;
            testClient.end();
            reject(err);
          });
          testClient.on('error', () => {
            if (!connected) {
              try { fs.unlinkSync(socketPath); } catch (e) {}
              tryListen();
            }
          });
        } else {
          // Socket path doesn't exist, try listening again
          tryListen();
        }
      });
    };
    tryListen();
  });
}
function buildVerifyApproval({ apiBase, store, clock, fetch }) {
  return (params, { token }) => verifyApproval(params, {
    fetch, apiBase, token, clock, store
  });
}

async function main() {
  const config = loadConfig(process.env);

  const { loadPolicy } = require('./policy.cjs');
  const policyResult = loadPolicy(config.policyPath);
  if (!policyResult.ok) {
    console.error('Policy load failed:', policyResult.reason);
    process.exit(1);
  }

  let sites = null;
  if (config.sitesPath) {
    try {
      sites = JSON.parse(fs.readFileSync(config.sitesPath, 'utf8'));
    } catch (e) {
      console.error('Sites load failed:', e.message);
      process.exit(1);
    }
  }

  const store = createApprovalStore({ stateDir: config.stateDir, fs, path });
  const handoff = createHandoff({ dir: config.handoffDir, fs });

  const dispatchClock = { now: () => Date.now() };
  const verifyApprovalFn = buildVerifyApproval({
    apiBase: config.apiBase,
    store,
    clock: dispatchClock,
    fetch: globalThis.fetch
  });

  const { createDispatcher } = require('./dispatch.cjs');
  const { dispatch } = createDispatcher({
    authenticate: (req) => authFn(req, { fetch: globalThis.fetch }),
    browser: null,
    policy: policyResult.policy,
    sites,
    clock: () => new Date(),
    evidenceDir: config.evidenceDir,
    verifyApproval: verifyApprovalFn,
    handoff,
    checkFill
  });

  const server = createServer({ dispatch, logger: () => {} });

  try {
    await listen(server, config.socketPath, config.socketMode);
    console.log(`Daemon listening on ${config.socketPath}`);
  } catch (err) {
    console.error('Failed to start daemon:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Daemon error:', err.message);
    process.exit(1);
  });
}

module.exports = { loadConfig, createServer, listen, buildVerifyApproval };
