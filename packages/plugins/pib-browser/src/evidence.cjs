'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { redactText } = require('./redact.cjs');

const ISSUE_RE = /^[A-Z]+-\d+$/;

function parseArgs(argv) {
  const args = {};
  let imagePath = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help') {
      return { help: true };
    } else if (arg === '--issue') {
      args.issue = argv[++i];
    } else if (arg === '--step') {
      args.step = argv[++i];
    } else if (!arg.startsWith('--') && !imagePath) {
      imagePath = arg;
    }
  }

  return { imagePath, ...args };
}

function printHelp() {
  return `Usage: pib-evidence <png-file> [options]

Options:
  --issue PAR-N    Issue identifier (required)
  --step NAME      Step name (required)
  --help           Show this help message
`;
}

async function run(argv, env, deps = {}) {
  const {
    fs: fsLib = fs,
    spawnSync: spawn = spawnSync,
    stdout = process.stdout,
    stderr = process.stderr
  } = deps;

  const parsed = parseArgs(argv);

  if (parsed.help) {
    stdout.write(printHelp());
    return 0;
  }

  const imagePath = parsed.imagePath;
  if (!imagePath) {
    stderr.write('Error: PNG file path is required\n');
    return 2;
  }

  // Check if file exists
  if (!fsLib.existsSync(imagePath)) {
    stderr.write('Error: PNG file not found\n');
    return 2;
  }

  const issue = parsed.issue;
  if (!issue || !ISSUE_RE.test(issue)) {
    stderr.write('Error: --issue is required (format: PAR-N)\n');
    return 2;
  }

  const step = parsed.step;
  if (!step || step.trim() === '') {
    stderr.write('Error: --step is required\n');
    return 2;
  }

  // Read the file and compute SHA256
  let fileBytes;
  try {
    fileBytes = fsLib.readFileSync(imagePath);
  } catch (e) {
    stderr.write('Error: failed to read file\n');
    return 5;
  }

  const sha256 = crypto.createHash('sha256').update(fileBytes).digest('hex');

  // Resolve upload script path
  const scriptPath = env.PIB_UPLOAD_ARTIFACT_SCRIPT ||
    path.resolve(__dirname, '../../../../skills/paperclip/scripts/paperclip-upload-artifact.sh');
  const result = spawn(scriptPath, [imagePath, '--issue-id', issue, '--step', step, '--output', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  if (result.signal || result.status !== 0) {
    const errMsg = result.stderr ? redactText(result.stderr) : 'upload failed';
    stderr.write(errMsg + '\n');
    return result.status || 1;
  }

  let output;
  try {
    output = JSON.parse(result.stdout);
  } catch (e) {
    stderr.write('Error: upload response not valid JSON\n');
    return 1;
  }

  const attachmentId = output.attachment?.id;
  if (!attachmentId) {
    stderr.write('Error: attachment id not found in response\n');
    return 1;
  }

  // Return the attachment ID and SHA256
  const evidence = { attachmentId, sha256 };
  stdout.write(JSON.stringify(evidence) + '\n');
  return 0;
}

module.exports = { run };
