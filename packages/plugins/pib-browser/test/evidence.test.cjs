'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { run } = require('../src/evidence.cjs');

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

test('evidence help shows usage', async () => {
  const stdout = new MockOutput();
  const stderr = new MockOutput();
  const code = await run(['--help'], {}, { stdout, stderr });
  assert.equal(code, 0);
  assert.ok(stdout.toString().includes('Usage'));
  assert.ok(stdout.toString().includes('--issue'));
});

test('evidence requires PNG path', async () => {
  const stdout = new MockOutput();
  const stderr = new MockOutput();
  const code = await run([], {}, { stdout, stderr });
  assert.equal(code, 2);
  assert.ok(stderr.toString().includes('PNG'));
});

test('evidence requires --issue', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-test-'));
  const pngPath = path.join(tmpDir, 'test.png');
  fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic

  const stdout = new MockOutput();
  const stderr = new MockOutput();
  const code = await run([pngPath], {}, { stdout, stderr });
  assert.equal(code, 2);
  assert.ok(stderr.toString().includes('--issue'));

  fs.rmSync(tmpDir, { recursive: true });
});

test('evidence requires --step', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-test-'));
  const pngPath = path.join(tmpDir, 'test.png');
  fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic

  const stdout = new MockOutput();
  const stderr = new MockOutput();
  const code = await run([pngPath, '--issue', 'PAR-123'], {}, { stdout, stderr });
  assert.equal(code, 2);
  assert.ok(stderr.toString().includes('--step'));
  assert.equal(stdout.toString(), '');

  fs.rmSync(tmpDir, { recursive: true });
});

test('evidence requires valid issue format', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-test-'));
  const pngPath = path.join(tmpDir, 'test.png');
  fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const stdout = new MockOutput();
  const stderr = new MockOutput();
  const code = await run([pngPath, '--issue', 'invalid'], {}, { stdout, stderr });
  assert.equal(code, 2);
  assert.ok(stderr.toString().includes('--issue'));

  fs.rmSync(tmpDir, { recursive: true });
});

test('evidence fails on missing PNG file', async () => {
  const stdout = new MockOutput();
  const stderr = new MockOutput();
  const code = await run(['/nonexistent/file.png', '--issue', 'PAR-123'], {}, { stdout, stderr });
  assert.equal(code, 2);
  assert.ok(stderr.toString().includes('not found'));
});

test('evidence success with stub upload script', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-test-'));
  const pngPath = path.join(tmpDir, 'test.png');
  const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  fs.writeFileSync(pngPath, pngData);

  const scriptPath = path.join(tmpDir, 'stub-upload.sh');
  fs.writeFileSync(scriptPath, `#!/bin/bash
  echo '{"attachment": {"id": "test-attach-123"}, "workProduct": null, "chatComment": null}'
  `, { mode: 0o755 });

  const stdout = new MockOutput();
  const stderr = new MockOutput();

  const mockSpawn = () => ({
    status: 0,
    signal: null,
    stdout: '{"attachment": {"id": "test-attach-123"}, "workProduct": null, "chatComment": null}'
  });

  const code = await run([pngPath, '--issue', 'PAR-123', '--step', 'screenshot'], { PIB_UPLOAD_ARTIFACT_SCRIPT: scriptPath }, {
    spawnSync: mockSpawn,
    stdout,
    stderr
  });

  assert.equal(code, 0);
  const output = JSON.parse(stdout.toString());
  assert.equal(output.attachmentId, 'test-attach-123');
  assert.ok(output.sha256);

  fs.rmSync(tmpDir, { recursive: true });
});

test('evidence computes correct sha256', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-test-'));
  const pngPath = path.join(tmpDir, 'test.png');
  const pngData = Buffer.from('test content');
  fs.writeFileSync(pngPath, pngData);

  const expectedSha = crypto.createHash('sha256').update(pngData).digest('hex');

  const stdout = new MockOutput();
  const stderr = new MockOutput();

  const mockSpawn = () => ({
    status: 0,
    signal: null,
    stdout: '{"attachment": {"id": "test-id"}, "workProduct": null, "chatComment": null}'
  });

  const code = await run([pngPath, '--issue', 'PAR-123', '--step', 'verify_sha'], {}, {
    spawnSync: mockSpawn,
    stdout,
    stderr
  });

  assert.equal(code, 0);
  const output = JSON.parse(stdout.toString());
  assert.equal(output.sha256, expectedSha);

  fs.rmSync(tmpDir, { recursive: true });
});

test('evidence upload failure returns nonzero', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-test-'));
  const pngPath = path.join(tmpDir, 'test.png');
  fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const stdout = new MockOutput();
  const stderr = new MockOutput();

  const mockSpawn = () => ({
    status: 1,
    signal: null,
    stdout: '',
    stderr: 'Upload failed'
  });

  const code = await run([pngPath, '--issue', 'PAR-123', '--step', 'fail_test'], {}, {
    spawnSync: mockSpawn,
    stdout,
    stderr
  });

  assert.notEqual(code, 0);
  assert.equal(stdout.toString(), '');
  assert.ok(stderr.toString().length > 0);

  fs.rmSync(tmpDir, { recursive: true });
});

test('evidence handles missing attachment id in response', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-test-'));
  const pngPath = path.join(tmpDir, 'test.png');
  fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const stdout = new MockOutput();
  const stderr = new MockOutput();

  const mockSpawn = () => ({
    status: 0,
    signal: null,
    stdout: '{"attachment": {}, "workProduct": null}'
  });

  const code = await run([pngPath, '--issue', 'PAR-123', '--step', 'test'], {}, {
    spawnSync: mockSpawn,
    stdout,
    stderr
  });

  assert.notEqual(code, 0);
  assert.equal(stdout.toString(), '');
  assert.ok(stderr.toString().includes('attachment id'));

  fs.rmSync(tmpDir, { recursive: true });
});

test('evidence handles invalid JSON from upload', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-test-'));
  const pngPath = path.join(tmpDir, 'test.png');
  fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const stdout = new MockOutput();
  const stderr = new MockOutput();

  const mockSpawn = () => ({
    status: 0,
    signal: null,
    stdout: 'not json'
  });

  const code = await run([pngPath, '--issue', 'PAR-123', '--step', 'json_test'], {}, {
    spawnSync: mockSpawn,
    stdout,
    stderr
  });

  assert.notEqual(code, 0);
  assert.equal(stdout.toString(), '');

  fs.rmSync(tmpDir, { recursive: true });
});

test('evidence redacts errors', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-test-'));
  const pngPath = path.join(tmpDir, 'test.png');
  fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const stdout = new MockOutput();
  const stderr = new MockOutput();

  const mockSpawn = () => ({
    status: 1,
    signal: null,
    stdout: '',
    stderr: 'Authorization: Bearer secret_token_12345'
  });

  const code = await run([pngPath, '--issue', 'PAR-123', '--step', 'redact_test'], {}, {
    spawnSync: mockSpawn,
    stdout,
    stderr
  });

  assert.notEqual(code, 0);
  assert.ok(!stderr.toString().includes('secret_token'));
  assert.ok(!stderr.toString().includes('Bearer'));

  fs.rmSync(tmpDir, { recursive: true });
});

test('evidence passes step name as title argument to upload script', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-test-'));
  const pngPath = path.join(tmpDir, 'test.png');
  const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  fs.writeFileSync(pngPath, pngData);

  const stdout = new MockOutput();
  const stderr = new MockOutput();

  let capturedArgs;
  const mockSpawn = (cmd, args) => {
    capturedArgs = args;
    return {
      status: 0,
      signal: null,
      stdout: '{"attachment": {"id": "test-id"}, "workProduct": null, "chatComment": null}'
    };
  };

  const code = await run([pngPath, '--issue', 'PAR-456', '--step', 'screenshot_1'], {}, {
    spawnSync: mockSpawn,
    stdout,
    stderr
  });

  assert.equal(code, 0);
  assert.ok(capturedArgs.includes('--title'));
  const titleIndex = capturedArgs.indexOf('--title');
  assert.equal(capturedArgs[titleIndex + 1], 'screenshot_1');
  assert.ok(!capturedArgs.includes('--step'), '--step flag should not be passed to upload script');

  fs.rmSync(tmpDir, { recursive: true });
});

test('evidence uses --title for step name in upload script call', async () => {
  // Test that the step name is passed as --title to the upload script, not --step.
  // This verifies the fix that changes the argument from --step to --title.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-test-'));
  const pngPath = path.join(tmpDir, 'test.png');
  const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  fs.writeFileSync(pngPath, pngData);

  const stdout = new MockOutput();
  const stderr = new MockOutput();

  let capturedArgs;
  const mockSpawn = (cmd, args) => {
    capturedArgs = args;
    return {
      status: 0,
      signal: null,
      stdout: '{"attachment": {"id": "test-id"}, "workProduct": null, "chatComment": null}'
    };
  };

  const code = await run([pngPath, '--issue', 'PAR-456', '--step', 'verify_step'], {}, {
    spawnSync: mockSpawn,
    stdout,
    stderr
  });

  assert.equal(code, 0);
  // Verify --title is used, not --step
  assert.ok(capturedArgs.includes('--title'), '--title flag should be present');
  assert.ok(!capturedArgs.includes('--step'), '--step flag should NOT be present');

  const titleIndex = capturedArgs.indexOf('--title');
  assert.equal(capturedArgs[titleIndex + 1], 'verify_step', 'title should contain step name');

  fs.rmSync(tmpDir, { recursive: true });
});

test('real upload script accepts evidence.cjs argument structure with --dry-run', async () => {
  // This test verifies the real paperclip-upload-artifact.sh script
  // accepts the exact arguments that evidence.cjs builds for it.
  // It uses --dry-run to avoid needing API credentials.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-real-script-test-'));
  const pngPath = path.join(tmpDir, 'test.png');
  const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  fs.writeFileSync(pngPath, pngData);

  const scriptPath = path.resolve(__dirname, '../../../../skills/paperclip/scripts/paperclip-upload-artifact.sh');

  // Verify script exists
  assert.ok(fs.existsSync(scriptPath), 'upload script should exist at expected path');

  const { spawnSync } = require('node:child_process');

  // Call with exact args that evidence.cjs builds: [imagePath, '--issue-id', issue, '--title', step, '--output', 'json', '--dry-run']
  const result = spawnSync(scriptPath, [
    pngPath,
    '--issue-id', 'PAR-999',
    '--title', 'real_script_test',
    '--output', 'json',
    '--dry-run'
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // Script should exit 0 with --dry-run
  assert.equal(result.status, 0, `script should exit 0 with --dry-run; stderr: ${result.stderr}`);

  // Verify no "unknown option" error
  assert.ok(!result.stderr.includes('unknown option'), 'should not report unknown options');
  assert.ok(!result.stderr.includes('unrecognized'), 'should not report unrecognized flags');

  fs.rmSync(tmpDir, { recursive: true });
});
