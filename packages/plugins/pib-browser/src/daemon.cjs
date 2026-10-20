'use strict';
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const { EXIT } = require('./exit-codes.cjs');

const MAX_LINE_SIZE = 64 * 1024; // 64 KiB

function loadConfig(env) {
  const socketPath = env.PIB_BROWSER_SOCKET;
  if (!socketPath) throw new Error('socketPath required');
  let socketMode = 0o660;
  if (env.PIB_BROWSER_SOCKET_MODE) {
    const m = env.PIB_BROWSER_SOCKET_MODE;
    socketMode = parseInt((m.startsWith('0o') || m.startsWith('0O') ? m.slice(2) : m), 8);
  }
  const apiBase = (env.PIB_BROWSER_API || env.PAPERCLIP_API_URL || 'http://localhost:3100')
    .replace(/\/+$/, '');
  return {
    socketPath, socketMode,
    evidenceDir: env.PIB_BROWSER_EVIDENCE_DIR || '',
    apiBase,
    policyPath: env.PIB_BROWSER_POLICY || '',
    sitesPath: env.PIB_BROWSER_SITES || ''
  };
}
function createServer(deps) {
  const { dispatch, logger } = deps;
  return net.createServer((socket) => {
    let buffer = '';
    let closed = false;
    socket.on('data', async (chunk) => {
      if (closed) return;
      buffer += chunk.toString('utf8');
      while (true) {
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
        const start = Date.now();
        const cmd = req.cmd || req.command || 'unknown';
        try {
          const result = await dispatch(req);
          socket.write(JSON.stringify(result) + '\n');
          logger({ cmd, exit: result.exit, ms: Date.now() - start });
        } catch (e) {
          const result = { exit: EXIT.USAGE, ok: false, reason: 'dispatch_error' };
          socket.write(JSON.stringify(result) + '\n');
          logger({ cmd, exit: result.exit, ms: Date.now() - start });
        }
      }
    });
    socket.on('end', () => { closed = true; });
    socket.on('error', () => { closed = true; });
  });
}

function listen(server, socketPath, socketMode) {
  return new Promise((resolve, reject) => {
    const tryListen = () => {
      server.listen(socketPath, () => {
        try { fs.chmodSync(socketPath, socketMode); } catch (e) {}
        resolve();
      });
      server.on('error', (err) => {
        if (err.code !== 'EADDRINUSE') return reject(err);
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
      });
    };
    tryListen();
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

  const { authenticate: authFn } = require('./auth.cjs');
  const { createDispatcher } = require('./dispatch.cjs');
  const { dispatch } = createDispatcher({
    authenticate: (req) => authFn(req, { fetch: globalThis.fetch, apiBase: config.apiBase }),
    browser: null,
    policy: policyResult.policy,
    sites,
    clock: () => new Date(),
    evidenceDir: config.evidenceDir
  });

  const server = createServer({ dispatch, socketMode: config.socketMode, logger: () => {} });

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

module.exports = { loadConfig, createServer, listen };
