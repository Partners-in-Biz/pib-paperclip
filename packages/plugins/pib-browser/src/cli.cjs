'use strict';
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { parseRegion } = require('./redact.cjs');
const { writeShot } = require('./shot.cjs');
const { probeAll } = require('./probe.cjs');

const COMMANDS = ['open', 'goto', 'click', 'fill', 'text', 'shot', 'close'];
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

async function send(request, { socketPath = '/run/pib-browser/sock', maxResponseBytes = MAX_RESPONSE_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    let responseText = '';
    let receivedBytes = 0;
    let finished = false;

    const timeout = setTimeout(() => {
      client.destroy();
      reject(new Error('Socket timeout'));
    }, 5000);

    client.on('connect', () => {
      client.write(JSON.stringify(request) + '\n');
    });

    client.on('data', (chunk) => {
      receivedBytes += chunk.length;
      if (receivedBytes > maxResponseBytes) {
        clearTimeout(timeout);
        client.destroy();
        if (!finished) {
          finished = true;
          reject(new Error('Response size exceeded'));
        }
        return;
      }

      responseText += chunk.toString('utf8');
      const idx = responseText.indexOf('\n');
      if (idx !== -1) {
        clearTimeout(timeout);
        const line = responseText.slice(0, idx);
        client.destroy();
        if (!finished) {
          finished = true;
          try {
            resolve(JSON.parse(line));
          } catch (e) {
            reject(new Error('Invalid response'));
          }
        }
      }
    });

    client.on('error', (err) => {
      clearTimeout(timeout);
      if (!finished) {
        finished = true;
        reject(err);
      }
    });

    client.on('close', () => {
      clearTimeout(timeout);
    });
  });
}

function parseArgs(argv) {
  const args = {};
  let cmd = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help') {
      return { help: true };
    }
    if (arg === '--json') {
      args.json = true;
    } else if (arg === '--all') {
      args.all = true;
    } else if (arg === '--identities') {
      args.identities = argv[++i];
    } else if (arg === '--out') {
      args.out = argv[++i];
    } else if (arg === '--identity') {
      args.identity = argv[++i];
    } else if (arg === '--issue') {
      args.issue = argv[++i];
    } else if (arg === '--url') {
      args.url = argv[++i];
    } else if (arg === '--selector') {
      args.selector = argv[++i];
    } else if (arg === '--value') {
      args.value = argv[++i];
    } else if (arg === '--expect') {
      args.expect = argv[++i];
    } else if (arg === '--redact-region') {
      args.region = argv[++i];
    } else if (arg === '--approval') {
      args.approval = argv[++i];
    } else if (arg === '--step') {
      args.step = argv[++i];
    } else if (!arg.startsWith('--')) {
      if (!cmd) {
        cmd = arg;
      }
    }
  }

  return { cmd, ...args };
}

function printHelp() {
  return `Usage: pib-browser <command> [options]

Commands:
  open      Open a browser context
  goto      Navigate to a URL
  click     Click an element
  fill      Fill a form field
  text      Get text from an element
  shot      Take a screenshot
  close     Close the browser context
  probe     Check browser session status for identities

Options:
  --identity ID         Identity string (required for most commands)
  --issue PAR-N         Issue identifier (required)
  --url URL            URL to navigate to (for goto)
  --selector SEL       CSS selector (for click, fill, text)
  --value VAL          Value to fill (for fill)
  --expect TEXT        Text to expect before screenshot
  --redact-region X,Y,W,H  Region to redact in screenshot
  --approval PAR-N      Approval identifier
  --step NAME          Step name for screenshot
  --all                Check all identities (for probe)
  --identities LIST    Space-separated identity list (for probe)
  --out PATH           Output file path (for probe)
  --json               JSON output
  --help               Show this help message
`;
}

async function run(argv, env, deps = {}) {
  const {
    send: sendFn = send,
    fs: fsLib = fs,
    now = () => new Date(),
    stdout = process.stdout,
    stderr = process.stderr,
    maxResponseBytes = MAX_RESPONSE_BYTES
  } = deps;

  const parsed = parseArgs(argv);

  if (parsed.help) {
    const help = printHelp();
    stdout.write(help);
    return 0;
  }

  const { cmd } = parsed;

  // Handle probe command (doesn't require identity)
  if (cmd === 'probe') {
    // Get token from environment
    const token = env.PAPERCLIP_API_KEY;
    if (!token) {
      stderr.write('Error: PAPERCLIP_API_KEY environment variable is required\n');
      return 2;
    }

    // Get issue
    const issue = parsed.issue;
    if (!issue) {
      stderr.write('Error: --issue is required\n');
      return 2;
    }

    if (!parsed.all) {
      stderr.write('Error: --all is required for probe\n');
      return 2;
    }

    // Get identities from flag or env
    const idStr = parsed.identities || env.PIB_BROWSER_IDENTITIES || '';
    const identities = idStr ? idStr.split(/\s+/).filter(id => id) : [];
    if (identities.length === 0) {
      stderr.write('Error: --identities is required or PIB_BROWSER_IDENTITIES must be set\n');
      return 2;
    }

    // Resolve output path
    const outPath = parsed.out || env.PIB_BROWSER_STATUS || '/home/paperclip/pib-tools/browser-status.json';

    // Define check function that calls open/close via daemon
    const check = async (identity) => {
      try {
        const openReq = { cmd: 'open', token, issue, identity, args: {} };
        const openResp = await sendFn(openReq, { socketPath: env.PIB_BROWSER_SOCKET || '/run/pib-browser/sock', maxResponseBytes });

        // Close the session
        try {
          const closeReq = { cmd: 'close', token, issue, identity, args: {} };
          await sendFn(closeReq, { socketPath: env.PIB_BROWSER_SOCKET || '/run/pib-browser/sock', maxResponseBytes });
        } catch (e) {}

        // Use ?? instead of || to preserve exit code 0; treat ok:true as success
        const exitCode = openResp.exit ?? 2;
        const isOk = openResp.ok === true;
        return { exit: isOk ? 0 : exitCode, reason: openResp.reason || '' };
      } catch (e) {
        return { exit: 3, reason: 'no_browser' };
      }
    };

    // Run probe
    const result = await probeAll({ identities, check, outPath, fs: fsLib, now });
    if (result.exit !== 0) {
      stderr.write(`Error: ${result.reason}\n`);
    }
    return result.exit;
  }

  // Validate command
  if (!cmd || !COMMANDS.includes(cmd)) {
    stderr.write('Error: unknown command\n');
    return 2;
  }

  // Get token from environment
  const token = env.PAPERCLIP_API_KEY;
  if (!token) {
    stderr.write('Error: PAPERCLIP_API_KEY environment variable is required\n');
    return 2;
  }

  // Get issue
  const issue = parsed.issue;
  if (!issue) {
    stderr.write('Error: --issue is required\n');
    return 2;
  }

  // Get identity
  const identity = parsed.identity;
  if (!identity) {
    stderr.write('Error: --identity is required\n');
    return 2;
  }

  // Validate region if provided
  if (parsed.region && !parseRegion(parsed.region)) {
    stderr.write('Error: invalid --redact-region format\n');
    return 2;
  }

  // Build request
  const args = {};
  if (cmd === 'goto') {
    if (!parsed.url) {
      stderr.write('Error: --url is required for goto\n');
      return 2;
    }
    args.url = parsed.url;
  } else if (cmd === 'click') {
    if (!parsed.selector) {
      stderr.write('Error: --selector is required for click\n');
      return 2;
    }
    args.selector = parsed.selector;
    if (parsed.text) args.text = parsed.text;
    if (parsed.approval) args.approval = parsed.approval;
  } else if (cmd === 'fill') {
    if (!parsed.selector || !parsed.value) {
      stderr.write('Error: --selector and --value are required for fill\n');
      return 2;
    }
    args.selector = parsed.selector;
    args.value = parsed.value;
  } else if (cmd === 'text') {
    if (!parsed.selector) {
      stderr.write('Error: --selector is required for text\n');
      return 2;
    }
    args.selector = parsed.selector;
  } else if (cmd === 'shot') {
    if (parsed.region) args.region = parsed.region;
    if (parsed.expect) args.expect = parsed.expect;
  }

  const request = {
    cmd,
    token,
    issue,
    identity,
    args
  };

  // Send request to daemon
  let response;
  try {
    response = await sendFn(request, {
      socketPath: env.PIB_BROWSER_SOCKET || '/run/pib-browser/sock',
      maxResponseBytes
    });
  } catch (e) {
    stderr.write(`Error: connection failed\n`);
    return 3;
  }

  const { exit: exitCode = 2, ok, reason, data } = response;

  // Handle shot command specially
  if (cmd === 'shot' && exitCode === 0 && ok && data) {
    const evidenceRoot = env.PIB_EVIDENCE_ROOT || '/home/paperclip/qa-evidence';
    const step = parsed.step || 'shot';

    const writeResult = writeShot({
      fs: fsLib,
      root: evidenceRoot,
      issue,
      step,
      now,
      b64: data.bytes,
      sha256: data.sha256
    });

    if (writeResult.exit && writeResult.exit !== 0) {
      stderr.write(`Error: failed to write evidence\n`);
      return writeResult.exit;
    }

    // Output result
    if (parsed.json) {
      const output = {
        path: writeResult.path,
        bytes: writeResult.bytes,
        sha256: writeResult.sha256,
        url: data.url,
        identity,
        expected: data.expected
      };
      stdout.write(JSON.stringify(output) + '\n');
    } else {
      stdout.write(`Screenshot written to ${writeResult.path}\n`);
    }
    return 0;
  }

  // Handle non-shot commands or errors
  if (exitCode !== 0) {
    if (reason) {
      stderr.write(`Error: ${reason}\n`);
    }
    return exitCode;
  }

  // Handle success for non-shot commands
  if (data) {
    if (cmd === 'text') {
      if (parsed.json) {
        stdout.write(JSON.stringify(data) + '\n');
      } else {
        stdout.write(data.text + '\n');
      }
    } else {
      if (parsed.json) {
        stdout.write(JSON.stringify(data) + '\n');
      }
    }
  }

  return 0;
}

module.exports = { run, send };
