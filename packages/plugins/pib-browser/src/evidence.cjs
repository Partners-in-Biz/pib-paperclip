'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const { redactText } = require('./redact.cjs');

const SCRIPT_NAME = 'paperclip-upload-artifact.sh';

// Candidate locations of the upload script, most specific first. The installed
// copy under /opt/pib-browser has no repo around it, so also look in the
// Paperclip instance skills store and the current checkout.
function uploadScriptCandidates(env, fsLib) {
  const out = [];
  if (env.PIB_UPLOAD_ARTIFACT_SCRIPT) out.push(env.PIB_UPLOAD_ARTIFACT_SCRIPT);
  out.push(path.resolve(__dirname, '../../../../skills/paperclip/scripts', SCRIPT_NAME));
  out.push(path.resolve(process.cwd(), 'skills/paperclip/scripts', SCRIPT_NAME));
  const home = env.PAPERCLIP_HOME || path.join(env.HOME || os.homedir(), '.paperclip');
  const instance = env.PAPERCLIP_INSTANCE_ID || 'default';
  const skillsRoot = path.join(home, 'instances', instance, 'skills');
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fsLib.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const full = path.join(dir, ent.name);
      if (ent.name === 'scripts') {
        const cand = path.join(full, SCRIPT_NAME);
        try { found.push({ cand, mtime: fsLib.statSync(cand).mtimeMs }); } catch (e) { /* none */ }
      } else if (depth < 5) {
        walk(full, depth + 1);
      }
    }
  };
  walk(skillsRoot, 0);
  // Prefer this company's skills subtree, then the newest copy overall.
  const co = env.PAPERCLIP_COMPANY_ID;
  const mine = (f) => (co && f.cand.split(path.sep).includes(co) ? 1 : 0);
  found.sort((a, b) => mine(b) - mine(a) || b.mtime - a.mtime);
  for (const f of found) out.push(f.cand);
  return out;
}

function resolveUploadScript(env, fsLib) {
  const candidates = uploadScriptCandidates(env, fsLib);
  // An explicit env path is authoritative: never silently fall back.
  if (env.PIB_UPLOAD_ARTIFACT_SCRIPT) {
    return { path: fsLib.existsSync(env.PIB_UPLOAD_ARTIFACT_SCRIPT) ? env.PIB_UPLOAD_ARTIFACT_SCRIPT : null, candidates: [env.PIB_UPLOAD_ARTIFACT_SCRIPT] };
  }
  const hit = candidates.find((c) => fsLib.existsSync(c));
  return { path: hit || null, candidates };
}

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
  const resolved = resolveUploadScript(env, fsLib);
  if (!resolved.path) {
    stderr.write('Error: upload script not found: ' + resolved.candidates.join(', ') +
      ' (set PIB_UPLOAD_ARTIFACT_SCRIPT to the path of ' + SCRIPT_NAME + ')\n');
    return 5;
  }
  const scriptPath = resolved.path;
  const result = spawn(scriptPath, [imagePath, '--issue-id', issue, '--title', step, '--output', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  if (result.signal || result.status !== 0) {
    const errMsg = result.error
      ? 'Error: could not run upload script ' + scriptPath + ': ' + redactText(String(result.error.message || result.error))
      : (result.stderr ? redactText(result.stderr) : 'upload failed (script ' + scriptPath + ' exited ' + (result.status === null ? 'by signal ' + result.signal : result.status) + ')');
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

  // Link to the stored artifact (the Paperclip-hosted copy; Drive saving is separate).
  const contentPath = output.attachment?.contentPath || output.workProduct?.url || '';
  let url = contentPath;
  if (contentPath && !/^https?:\/\//.test(contentPath) && env.PAPERCLIP_API_URL) {
    try { url = new URL(contentPath, env.PAPERCLIP_API_URL).toString(); } catch (e) { url = contentPath; }
  }
  // Return the attachment ID and SHA256 (plus the link when known).
  const evidence = { attachmentId, sha256 };
  if (url) evidence.url = url;
  stdout.write(JSON.stringify(evidence) + '\n');
  return 0;
}

module.exports = { run };
