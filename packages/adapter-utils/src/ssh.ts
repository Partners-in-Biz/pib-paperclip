import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { constants as fsConstants, createReadStream, createWriteStream, promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeIntoChildStdin, writeChildStdin } from "./child-stdin.js";
import type { CommandManagedRuntimeRunner } from "./command-managed-runtime.js";
import {
  createUnrelatedHistoryGraftCommit,
  GIT_SYNC_COMMIT_IDENTITY_ARGS,
  listProjectRepositoryStagingPaths,
  PROJECT_REPOSITORIES_DIR,
  PROJECT_REPOSITORY_STAGING_PATTERN,
  readSanitizedOriginRemoteUrl,
  resetLocalGitIndexToHead,
} from "./git-workspace-sync.js";
import type { RunProcessResult } from "./server-utils.js";
import type { DirectorySnapshot } from "./workspace-restore-merge.js";
import { mergeDirectoryWithBaseline } from "./workspace-restore-merge.js";
import {
  createRuntimeProgressReporter,
  type RuntimeProgressDirection,
  type RuntimeProgressPhase,
  type RuntimeProgressSink,
} from "./runtime-progress.js";

export interface SshConnectionConfig {
  host: string;
  port: number;
  username: string;
  remoteWorkspacePath: string;
  privateKey: string | null;
  knownHosts: string | null;
  strictHostKeyChecking: boolean;
}

export interface SshCommandResult {
  stdout: string;
  stderr: string;
}

export interface SshRemoteExecutionSpec extends SshConnectionConfig {
  remoteCwd: string;
}

export function createSshCommandManagedRuntimeRunner(input: {
  spec: SshRemoteExecutionSpec;
  defaultCwd?: string | null;
  maxBufferBytes?: number | null;
}): CommandManagedRuntimeRunner {
  const defaultCwd = input.defaultCwd?.trim() || input.spec.remoteCwd;
  const maxBufferBytes =
    typeof input.maxBufferBytes === "number" && Number.isFinite(input.maxBufferBytes) && input.maxBufferBytes > 0
      ? Math.trunc(input.maxBufferBytes)
      : 1024 * 1024;

  return {
    execute: async (commandInput): Promise<RunProcessResult> => {
      const startedAt = new Date().toISOString();
      const command = commandInput.command.trim();
      const args = commandInput.args ?? [];
      const cwd = commandInput.cwd?.trim() || defaultCwd;
      const envEntries = Object.entries(commandInput.env ?? {})
        .filter((entry): entry is [string, string] => typeof entry[1] === "string");
      for (const [key] of envEntries) {
        if (!isValidShellEnvKey(key)) {
          throw new Error(`Invalid SSH environment variable key: ${key}`);
        }
      }
      const envPrefix = envEntries.length > 0
        ? `env ${envEntries.map(([key, value]) => shellQuote(`${key}=${value}`)).join(" ")} `
        : "";
      const commandScript = `exec ${envPrefix}${[shellQuote(command), ...args.map((arg) => shellQuote(arg))].join(" ")}`;
      const remoteCommand = `cd ${shellQuote(cwd)} && ${commandScript}`;

      try {
        const result = await runSshCommand(input.spec, remoteCommand, {
          stdin: commandInput.stdin,
          timeoutMs: commandInput.timeoutMs,
          maxBuffer: maxBufferBytes,
        });
        if (result.stdout) await commandInput.onLog?.("stdout", result.stdout);
        if (result.stderr) await commandInput.onLog?.("stderr", result.stderr);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: result.stdout,
          stderr: result.stderr,
          pid: null,
          startedAt,
        };
      } catch (error) {
        const failure = error as {
          stdout?: unknown;
          stderr?: unknown;
          code?: unknown;
          signal?: unknown;
          killed?: unknown;
        };
        const stdout = typeof failure.stdout === "string" ? failure.stdout : "";
        const stderr = typeof failure.stderr === "string"
          ? failure.stderr
          : error instanceof Error
            ? error.message
            : String(error);
        if (stdout) await commandInput.onLog?.("stdout", stdout);
        if (stderr) await commandInput.onLog?.("stderr", stderr);
        return {
          exitCode: typeof failure.code === "number" ? failure.code : null,
          signal: typeof failure.signal === "string" ? failure.signal : null,
          timedOut: failure.killed === true,
          stdout,
          stderr,
          pid: null,
          startedAt,
        };
      }
    },
  };
}

export interface SshEnvLabSupport {
  supported: boolean;
  reason: string | null;
}

export interface SshEnvLabFixtureState {
  kind: "ssh_openbsd";
  bindHost: string;
  host: string;
  port: number;
  username: string;
  rootDir: string;
  workspaceDir: string;
  statePath: string;
  pid: number;
  createdAt: string;
  clientPrivateKeyPath: string;
  clientPublicKeyPath: string;
  hostPrivateKeyPath: string;
  hostPublicKeyPath: string;
  authorizedKeysPath: string;
  knownHostsPath: string;
  sshdConfigPath: string;
  sshdLogPath: string;
}

interface LocalGitWorkspaceSnapshot {
  headCommit: string;
  branchName: string | null;
  deletedPaths: string[];
}

export function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function isValidShellEnvKey(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export function parseSshRemoteExecutionSpec(value: unknown): SshRemoteExecutionSpec | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const parsed = value as Record<string, unknown>;
  const host = typeof parsed.host === "string" ? parsed.host.trim() : "";
  const username = typeof parsed.username === "string" ? parsed.username.trim() : "";
  const remoteCwd = typeof parsed.remoteCwd === "string" ? parsed.remoteCwd.trim() : "";
  const portValue = typeof parsed.port === "number" ? parsed.port : Number(parsed.port);
  if (!host || !username || !remoteCwd || !Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
    return null;
  }

  return {
    host,
    port: portValue,
    username,
    remoteCwd,
    remoteWorkspacePath:
      typeof parsed.remoteWorkspacePath === "string" && parsed.remoteWorkspacePath.trim().length > 0
        ? parsed.remoteWorkspacePath.trim()
        : remoteCwd,
    privateKey: typeof parsed.privateKey === "string" && parsed.privateKey.length > 0 ? parsed.privateKey : null,
    knownHosts: typeof parsed.knownHosts === "string" && parsed.knownHosts.length > 0 ? parsed.knownHosts : null,
    strictHostKeyChecking:
      typeof parsed.strictHostKeyChecking === "boolean" ? parsed.strictHostKeyChecking : true,
  };
}

async function execFileText(
  file: string,
  args: string[],
  options: {
    timeout?: number;
    maxBuffer?: number;
  } = {},
): Promise<SshCommandResult> {
  return await new Promise<SshCommandResult>((resolve, reject) => {
    execFile(
      file,
      args,
      {
        timeout: options.timeout ?? 15_000,
        maxBuffer: options.maxBuffer ?? 1024 * 128,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout: stdout ?? "", stderr: stderr ?? "" }));
          return;
        }
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      },
    );
  });
}

async function spawnText(
  file: string,
  args: string[],
  options: {
    stdin?: string;
    timeout?: number;
    maxBuffer?: number;
  } = {},
): Promise<SshCommandResult> {
  return await new Promise<SshCommandResult>((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: [options.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
    });

    const maxBuffer = options.maxBuffer ?? 1024 * 128;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finishReject = (error: Error & { stdout?: string; stderr?: string; code?: number | null; killed?: boolean }) => {
      if (settled) return;
      settled = true;
      error.stdout = stdout;
      error.stderr = stderr;
      error.killed = timedOut;
      reject(error);
    };

    const append = (
      streamName: "stdout" | "stderr",
      chunk: unknown,
    ) => {
      const text = String(chunk);
      if (streamName === "stdout") {
        stdout += text;
      } else {
        stderr += text;
      }
      if (Buffer.byteLength(stdout, "utf8") > maxBuffer || Buffer.byteLength(stderr, "utf8") > maxBuffer) {
        child.kill("SIGTERM");
        finishReject(Object.assign(new Error(`Process output exceeded maxBuffer of ${maxBuffer} bytes.`), {
          code: null,
        }));
      }
    };

    let killEscalation: NodeJS.Timeout | null = null;
    const timeout = options.timeout && options.timeout > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          // Escalate to SIGKILL after a 5s grace window so a hung remote
          // command that ignores SIGTERM cannot keep the child alive
          // indefinitely.
          killEscalation = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // child may have already exited between the SIGTERM and the
              // escalation — that's fine.
            }
          }, 5_000);
          killEscalation.unref?.();
        }, options.timeout)
      : null;

    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (killEscalation) clearTimeout(killEscalation);
    };

    child.stdout?.on("data", (chunk) => {
      append("stdout", chunk);
    });
    child.stderr?.on("data", (chunk) => {
      append("stderr", chunk);
    });

    child.on("error", (error) => {
      clearTimers();
      finishReject(Object.assign(error, { code: null }));
    });

    child.on("close", (code, signal) => {
      clearTimers();
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(Object.assign(new Error(stderr.trim() || stdout.trim() || `Process exited with code ${code ?? -1}`), {
        stdout,
        stderr,
        code,
        signal,
        killed: timedOut,
      }));
    });

    if (options.stdin != null) {
      // Pipe-closed codes are left to the close handler; other codes reject.
      writeChildStdin(child, options.stdin, "ssh.spawnText", (error) => {
        child.kill("SIGTERM");
        finishReject(Object.assign(error, { code: null }));
      });
    }
  });
}

async function runLocalGit(
  localDir: string,
  args: string[],
  options: {
    timeout?: number;
    maxBuffer?: number;
  } = {},
): Promise<SshCommandResult> {
  return await execFileText("git", ["-C", localDir, ...args], options);
}

async function commandExists(command: string): Promise<boolean> {
  return (await resolveCommandPath(command)) !== null;
}

async function resolveCommandPath(command: string): Promise<string | null> {
  try {
    const result = await execFileText("sh", ["-c", `command -v ${shellQuote(command)}`], {
      timeout: 5_000,
      maxBuffer: 8 * 1024,
    });
    const resolved = result.stdout.trim().split("\n")[0]?.trim() ?? "";
    return resolved.length > 0 ? resolved : null;
  } catch {
    return null;
  }
}

async function withTempFile(
  prefix: string,
  contents: string,
  mode: number,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const filePath = path.join(dir, "payload");
  const normalizedContents = contents.endsWith("\n") ? contents : `${contents}\n`;
  await fs.writeFile(filePath, normalizedContents, { mode, encoding: "utf8" });
  return {
    path: filePath,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

async function createSshAuthArgs(
  config: Pick<SshConnectionConfig, "privateKey" | "knownHosts" | "strictHostKeyChecking">,
): Promise<{ args: string[]; cleanup: () => Promise<void> }> {
  const tempFiles: Array<() => Promise<void>> = [];
  const sshArgs = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    `StrictHostKeyChecking=${config.strictHostKeyChecking ? "yes" : "no"}`,
  ];

  if (config.strictHostKeyChecking) {
    if (config.knownHosts) {
      const knownHosts = await withTempFile("paperclip-ssh-known-hosts-", config.knownHosts, 0o600);
      tempFiles.push(knownHosts.cleanup);
      sshArgs.push("-o", `UserKnownHostsFile=${knownHosts.path}`);
    }
  } else {
    sshArgs.push("-o", "UserKnownHostsFile=/dev/null");
  }

  if (config.privateKey) {
    const privateKey = await withTempFile("paperclip-ssh-key-", config.privateKey, 0o600);
    tempFiles.push(privateKey.cleanup);
    sshArgs.push("-i", privateKey.path);
  }

  return {
    args: sshArgs,
    cleanup: async () => {
      await Promise.all(tempFiles.map((cleanup) => cleanup()));
    },
  };
}

function tarExcludeArgs(exclude: string[] | undefined): string[] {
  const combined = ["._*", ...(exclude ?? [])];
  return combined.flatMap((entry) => ["--exclude", entry]);
}

function tarSpawnEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Prevent macOS bsdtar from emitting AppleDouble metadata files like ._README.md.
    COPYFILE_DISABLE: "1",
  };
}

// Converts a tar `--exclude` pattern into a regexp for the local-size estimate.
// We only need approximate fidelity here (the estimate feeds a clamped percent),
// so we support the literal names and `*`/`?` globs used in practice.
function tarPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}

// Walks `localDir` summing regular-file sizes, mirroring tar's `--exclude`
// handling (plus the implicit `._*`) and `followSymlinks` so the to-ssh upload
// can report an estimated total before tar finishes producing the stream.
async function estimateLocalDirSize(input: {
  localDir: string;
  exclude?: string[];
  followSymlinks?: boolean;
}): Promise<number> {
  const regexes = ["._*", ...(input.exclude ?? [])].map(tarPatternToRegExp);
  const isExcluded = (relPath: string, base: string) =>
    regexes.some((regex) => regex.test(relPath) || regex.test(base));

  let total = 0;
  const walk = async (dir: string, relative: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (isExcluded(entryRelative, entry.name)) continue;
      const full = path.join(dir, entry.name);
      const stats = await (input.followSymlinks ? fs.stat(full) : fs.lstat(full)).catch(() => null);
      if (!stats) continue;
      if (stats.isDirectory()) {
        await walk(full, entryRelative);
      } else if (stats.isFile()) {
        total += stats.size;
      }
    }
  };
  await walk(input.localDir, "");
  return total;
}

// Best-effort remote size probe for the from-ssh restore. `du -sk` is POSIX and
// available on the BSD/Linux remotes we target; it over-counts (block-rounded,
// includes excluded dirs) which keeps the reported percent safely below 100
// until the stream actually closes. Returns null when unavailable so the caller
// falls back to MB-received mode.
async function probeRemoteDirSize(input: {
  spec: SshConnectionConfig;
  remoteDir: string;
}): Promise<number | null> {
  try {
    const result = await runSshScript(
      input.spec,
      `du -sk ${shellQuote(input.remoteDir)} 2>/dev/null | cut -f1`,
      { timeoutMs: 15_000, maxBuffer: 16 * 1024 },
    );
    const kilobytes = Number.parseInt(result.stdout.trim(), 10);
    return Number.isFinite(kilobytes) && kilobytes > 0 ? kilobytes * 1024 : null;
  } catch {
    return null;
  }
}

interface TransferProgress {
  // Backpressure-respecting counter to splice into a transport pipe.
  counter: Transform;
  // Last cumulative byte count observed by the counter.
  transferred: () => number;
  // Emit the terminal completion line. Idempotent.
  finish: () => Promise<void>;
  // Emit a terminal failure marker instead of a completion line. Idempotent.
  fail: () => Promise<void>;
}

// Wraps a throttled progress reporter behind a counting Transform so transports
// can `source.pipe(progress.counter).pipe(dest)`. When `totalBytes` is a known
// exact size (e.g. a git bundle) the reporter emits an exact percentage. When it
// is an estimate (tar upload / remote probe) we clamp the reported bytes to 99%
// of the estimate so an inaccurate total never shows a premature 100%; `finish`
// then emits the terminal 100% (or, in MB-only mode, the final MB) line.
//
// `totalBytes` may be a promise so an expensive size estimate (a local dir walk
// or a remote `du` probe) runs concurrently with the transfer instead of
// blocking the pipe from opening. Until it resolves the counter reports bytes in
// MB-only mode, then adopts the percentage once the total is known; `finish`
// awaits the estimate so the terminal 100% line is still guaranteed.
function createTransferProgress(input: {
  onProgress: RuntimeProgressSink;
  phase: RuntimeProgressPhase;
  direction: RuntimeProgressDirection;
  label?: string;
  totalBytes: number | null | Promise<number | null>;
  estimated: boolean;
}): TransferProgress {
  const reporter = createRuntimeProgressReporter({
    sink: input.onProgress,
    phase: input.phase,
    direction: input.direction,
    label: input.label,
    target: "ssh",
  });

  let total: number | null = null;
  let cap: number | null = null;
  const applyTotal = (value: number | null) => {
    total = value != null && value > 0 ? value : null;
    cap = total != null && input.estimated ? Math.floor(total * 0.99) : null;
  };
  const totalReady: Promise<void> =
    input.totalBytes != null && typeof (input.totalBytes as Promise<number | null>).then === "function"
      ? (input.totalBytes as Promise<number | null>).then(applyTotal, () => applyTotal(null))
      : (applyTotal(input.totalBytes as number | null), Promise.resolve());

  let transferred = 0;
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<void>) => {
    chain = chain.then(work).catch(() => undefined);
  };

  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      transferred += chunk.length;
      const reported = cap != null ? Math.min(transferred, cap) : transferred;
      const totalSnapshot = total;
      enqueue(() => reporter.report(reported, totalSnapshot));
      callback(null, chunk);
    },
  });

  return {
    counter,
    transferred: () => transferred,
    finish: async () => {
      await chain.catch(() => undefined);
      await totalReady.catch(() => undefined);
      await reporter.complete(total != null ? total : transferred, total).catch(() => undefined);
    },
    fail: async () => {
      await chain.catch(() => undefined);
      await reporter.fail(transferred, total).catch(() => undefined);
    },
  };
}

async function runSshScript(
  config: SshConnectionConfig,
  script: string,
  options: {
    timeoutMs?: number;
    maxBuffer?: number;
  } = {},
): Promise<SshCommandResult> {
  return await runSshCommand(
    config,
    script,
    options,
  );
}

async function clearLocalDirectory(
  localDir: string,
  preserveEntries: string[] = [],
): Promise<void> {
  await fs.mkdir(localDir, { recursive: true });
  const preserve = new Set(preserveEntries);
  const entries = await fs.readdir(localDir);
  await Promise.all(
    entries
      .filter((entry) => !preserve.has(entry))
      .map((entry) => fs.rm(path.join(localDir, entry), { recursive: true, force: true })),
  );
}

async function copyDirectoryContents(sourceDir: string, targetDir: string): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });
  const entries = await fs.readdir(sourceDir);
  await Promise.all(entries.map(async (entry) => {
    await fs.cp(path.join(sourceDir, entry), path.join(targetDir, entry), {
      recursive: true,
      force: true,
      preserveTimestamps: true,
    });
  }));
}

async function readLocalGitWorkspaceSnapshot(localDir: string): Promise<LocalGitWorkspaceSnapshot | null> {
  try {
    const insideWorkTree = await runLocalGit(localDir, ["rev-parse", "--is-inside-work-tree"], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    if (insideWorkTree.stdout.trim() !== "true") {
      return null;
    }

    const [headCommitResult, branchResult, deletedResult] = await Promise.all([
      runLocalGit(localDir, ["rev-parse", "HEAD"], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      }),
      runLocalGit(localDir, ["rev-parse", "--abbrev-ref", "HEAD"], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      }),
      runLocalGit(localDir, ["ls-files", "--deleted", "-z"], {
        timeout: 10_000,
        maxBuffer: 256 * 1024,
      }),
    ]);

    const branchName = branchResult.stdout.trim();
    return {
      headCommit: headCommitResult.stdout.trim(),
      branchName: branchName && branchName !== "HEAD" ? branchName : null,
      deletedPaths: deletedResult.stdout
        .split("\0")
        .map((entry) => entry.trim())
        .filter(Boolean),
    };
  } catch {
    return null;
  }
}

/** @internal Exported for tests only. */
export async function streamLocalFileToSsh(input: {
  spec: SshConnectionConfig;
  localFile: string;
  remoteScript: string;
  progress?: TransferProgress;
}): Promise<void> {
  const auth = await createSshAuthArgs(input.spec);
  const sshArgs = [
    ...auth.args,
    "-p",
    String(input.spec.port),
    `${input.spec.username}@${input.spec.host}`,
    `sh -c ${shellQuote(input.remoteScript)}`,
  ];

  await new Promise<void>((resolve, reject) => {
    const source = createReadStream(input.localFile);
    const ssh = spawn("ssh", sshArgs, {
      stdio: ["pipe", "ignore", "pipe"],
    });

    let sshStderr = "";
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      source.destroy();
      ssh.kill("SIGTERM");
      reject(error);
    };

    ssh.stderr?.on("data", (chunk) => {
      sshStderr += String(chunk);
    });
    source.on("error", fail);
    ssh.on("error", fail);
    if (input.progress) {
      input.progress.counter.on("error", fail);
      pipeIntoChildStdin(source.pipe(input.progress.counter), ssh, "ssh.streamLocalFileToSsh", fail);
    } else {
      pipeIntoChildStdin(source, ssh, "ssh.streamLocalFileToSsh", fail);
    }
    ssh.on("close", (code) => {
      // ssh may close before reading the whole file; free the read stream.
      source.destroy();
      if (settled) return;
      settled = true;
      if ((code ?? 0) !== 0) {
        reject(new Error(sshStderr.trim() || `ssh exited with code ${code ?? -1}`));
        return;
      }
      resolve();
    });
  }).finally(auth.cleanup);
}

async function streamSshToLocalFile(input: {
  spec: SshConnectionConfig;
  remoteScript: string;
  localFile: string;
  progress?: TransferProgress;
}): Promise<void> {
  const auth = await createSshAuthArgs(input.spec);
  const sshArgs = [
    ...auth.args,
    "-p",
    String(input.spec.port),
    `${input.spec.username}@${input.spec.host}`,
    `sh -c ${shellQuote(input.remoteScript)}`,
  ];

  await new Promise<void>((resolve, reject) => {
    const ssh = spawn("ssh", sshArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const sink = createWriteStream(input.localFile, { mode: 0o600 });

    let sshStderr = "";
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      ssh.kill("SIGTERM");
      sink.destroy();
      reject(error);
    };

    if (input.progress) {
      input.progress.counter.on("error", fail);
      ssh.stdout?.pipe(input.progress.counter).pipe(sink);
    } else {
      ssh.stdout?.pipe(sink);
    }
    ssh.stderr?.on("data", (chunk) => {
      sshStderr += String(chunk);
    });
    ssh.on("error", fail);
    sink.on("error", fail);
    ssh.on("close", (code) => {
      sink.end(() => {
        if (settled) return;
        settled = true;
        if ((code ?? 0) !== 0) {
          reject(new Error(sshStderr.trim() || `ssh exited with code ${code ?? -1}`));
          return;
        }
        resolve();
      });
    });
  }).finally(auth.cleanup);
}

async function importGitWorkspaceToSsh(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir: string;
  snapshot: LocalGitWorkspaceSnapshot;
  onProgress?: RuntimeProgressSink;
}): Promise<void> {
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-bundle-"));
  const bundlePath = path.join(bundleDir, "workspace.bundle");
  // Per-import unique ref so concurrent imports against the same local repo
  // can't race on `update-ref` between this run's update and bundle create.
  const tempRef = `refs/paperclip/ssh-sync/import/${randomUUID()}`;

  try {
    await runLocalGit(input.localDir, ["update-ref", tempRef, input.snapshot.headCommit], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    await runLocalGit(input.localDir, ["bundle", "create", bundlePath, tempRef], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    const originUrl = await readSanitizedOriginRemoteUrl(input.localDir);

    const remoteSetupScript = [
      "set -e",
      `mkdir -p ${shellQuote(path.posix.join(input.remoteDir, ".paperclip-runtime"))}`,
      `tmp_bundle=$(mktemp ${shellQuote(path.posix.join(input.remoteDir, ".paperclip-runtime", "import-XXXXXX.bundle"))})`,
      'trap \'rm -f "$tmp_bundle"\' EXIT',
      'cat > "$tmp_bundle"',
      `if [ ! -d ${shellQuote(path.posix.join(input.remoteDir, ".git"))} ]; then git init ${shellQuote(input.remoteDir)} >/dev/null; fi`,
      // Carry the workspace's (credential-scrubbed) origin into the transported
      // repo so branches there keep a publishable remote instead of reading as
      // remote-less snapshots. set-url covers a reused workspace whose origin
      // changed; add covers the fresh-init case. Best-effort under `set -e`.
      ...(originUrl
        ? [
          `{ git -C ${shellQuote(input.remoteDir)} remote set-url origin ${shellQuote(originUrl)} >/dev/null 2>&1 || git -C ${shellQuote(input.remoteDir)} remote add origin ${shellQuote(originUrl)} >/dev/null 2>&1; } || true`,
        ]
        : []),
      `git -C ${shellQuote(input.remoteDir)} fetch --force "$tmp_bundle" '${tempRef}:${tempRef}' >/dev/null`,
      input.snapshot.branchName
        ? `git -C ${shellQuote(input.remoteDir)} checkout --force -B ${shellQuote(input.snapshot.branchName)} ${shellQuote(input.snapshot.headCommit)} >/dev/null`
        : `git -C ${shellQuote(input.remoteDir)} -c advice.detachedHead=false checkout --force --detach ${shellQuote(input.snapshot.headCommit)} >/dev/null`,
      `git -C ${shellQuote(input.remoteDir)} reset --hard ${shellQuote(input.snapshot.headCommit)} >/dev/null`,
      `git -C ${shellQuote(input.remoteDir)} clean -fdx -e .paperclip-runtime >/dev/null`,
      // Drop the per-import ref on the remote side too so it can't accumulate.
      `git -C ${shellQuote(input.remoteDir)} update-ref -d ${shellQuote(tempRef)} >/dev/null 2>&1 || true`,
    ].join("\n");

    // The git bundle is a real local file of known size, so report an exact
    // percentage. No `workspace` label: the "Importing git history" phase is
    // already self-describing in the log line.
    const progress = input.onProgress
      ? createTransferProgress({
        onProgress: input.onProgress,
        phase: "Importing git history",
        direction: "to",
        totalBytes: (await fs.stat(bundlePath)).size,
        estimated: false,
      })
      : null;

    try {
      await streamLocalFileToSsh({
        spec: input.spec,
        localFile: bundlePath,
        remoteScript: remoteSetupScript,
        progress: progress ?? undefined,
      });
      await progress?.finish();
    } catch (error) {
      await progress?.fail();
      throw error;
    }
  } finally {
    await runLocalGit(input.localDir, ["update-ref", "-d", tempRef], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    }).catch(() => undefined);
    await fs.rm(bundleDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function exportGitWorkspaceFromSsh(input: {
  spec: SshRemoteExecutionSpec;
  remoteDir: string;
  localDir: string;
  importedRef?: string;
  resetLocalWorkspace?: boolean;
  onProgress?: RuntimeProgressSink;
}): Promise<string> {
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-bundle-"));
  const bundlePath = path.join(bundleDir, "workspace.bundle");
  const importedRef = input.importedRef ?? `refs/paperclip/ssh-sync/imported/${randomUUID()}`;

  try {
    const exportScript = [
      "set -e",
      `git -C ${shellQuote(input.remoteDir)} update-ref refs/paperclip/ssh-sync/export HEAD`,
      `mkdir -p ${shellQuote(path.posix.join(input.remoteDir, ".paperclip-runtime"))}`,
      `tmp_bundle=$(mktemp ${shellQuote(path.posix.join(input.remoteDir, ".paperclip-runtime", "export-XXXXXX.bundle"))})`,
      'cleanup() { rm -f "$tmp_bundle"; git -C ' + shellQuote(input.remoteDir) + ' update-ref -d refs/paperclip/ssh-sync/export >/dev/null 2>&1 || true; }',
      'trap cleanup EXIT',
      `git -C ${shellQuote(input.remoteDir)} bundle create "$tmp_bundle" refs/paperclip/ssh-sync/export >/dev/null`,
      'cat "$tmp_bundle"',
    ].join("\n");

    // The remote bundle size isn't known before streaming, so report bytes
    // received (MB mode) with a terminal completion line.
    const progress = input.onProgress
      ? createTransferProgress({
        onProgress: input.onProgress,
        phase: "Exporting git history",
        direction: "from",
        totalBytes: null,
        estimated: false,
      })
      : null;

    try {
      await streamSshToLocalFile({
        spec: input.spec,
        remoteScript: exportScript,
        localFile: bundlePath,
        progress: progress ?? undefined,
      });
      await progress?.finish();
    } catch (error) {
      await progress?.fail();
      throw error;
    }

    await runLocalGit(input.localDir, ["fetch", "--force", bundlePath, `refs/paperclip/ssh-sync/export:${importedRef}`], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    if (input.resetLocalWorkspace !== false) {
      await runLocalGit(input.localDir, ["reset", "--hard", importedRef], {
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      });
    }
    const importedHead = await runLocalGit(input.localDir, ["rev-parse", importedRef], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    return importedHead.stdout.trim();
  } finally {
    if (input.resetLocalWorkspace !== false) {
      await runLocalGit(input.localDir, ["update-ref", "-d", importedRef], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      }).catch(() => undefined);
    }
    await fs.rm(bundleDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function integrateImportedGitHead(input: {
  localDir: string;
  importedHead: string;
}): Promise<void> {
  const isConcurrentRefUpdateError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("cannot lock ref") && message.includes("expected");
  };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const snapshot = await readLocalGitWorkspaceSnapshot(input.localDir);
    if (!snapshot) return;

    const currentHead = snapshot.headCommit;
    if (!currentHead || currentHead === input.importedHead) return;

    const headRef = snapshot.branchName ? `refs/heads/${snapshot.branchName}` : "HEAD";
    // `git merge-base` exits 1 when the commits share no ancestor — the only
    // outcome that authorizes the graft fallback below. Every other failure
    // (timeout, missing object, repository error) must keep failing the
    // integration instead of silently rewriting the tip.
    let noCommonAncestor = false;
    const mergeBase = await runLocalGit(input.localDir, ["merge-base", currentHead, input.importedHead], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    }).catch((error: unknown) => {
      noCommonAncestor = (error as { code?: unknown } | null)?.code === 1;
      return null;
    });
    const mergeBaseHead = mergeBase?.stdout.trim() ?? "";

    if (mergeBaseHead === input.importedHead) {
      return;
    }

    if (mergeBaseHead === currentHead) {
      try {
        await runLocalGit(input.localDir, ["update-ref", headRef, input.importedHead, currentHead], {
          timeout: 10_000,
          maxBuffer: 16 * 1024,
        });
        return;
      } catch (error) {
        if (isConcurrentRefUpdateError(error) && attempt < 4) continue;
        throw error;
      }
    }

    if (noCommonAncestor) {
      // No common ancestor — merging is impossible and failing here would
      // discard the imported work. Graft it onto the current head instead;
      // see createUnrelatedHistoryGraftCommit.
      const graftCommit = await createUnrelatedHistoryGraftCommit({
        localDir: input.localDir,
        currentHead,
        importedHead: input.importedHead,
        syncLabel: "Paperclip SSH sync",
      });
      try {
        await runLocalGit(input.localDir, ["update-ref", headRef, graftCommit, currentHead], {
          timeout: 10_000,
          maxBuffer: 16 * 1024,
        });
        return;
      } catch (error) {
        if (isConcurrentRefUpdateError(error) && attempt < 4) continue;
        throw error;
      }
    }

    let mergedTree;
    try {
      mergedTree = await runLocalGit(input.localDir, ["merge-tree", "--write-tree", currentHead, input.importedHead], {
        timeout: 60_000,
        maxBuffer: 256 * 1024,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to merge concurrent SSH git histories for ${currentHead.slice(0, 12)} and ${input.importedHead.slice(0, 12)}: ${reason}`,
      );
    }
    const mergedTreeId = mergedTree.stdout.trim().split("\n")[0]?.trim() ?? "";
    if (!mergedTreeId) {
      throw new Error("Failed to compute a merged git tree for SSH workspace restore.");
    }

    const mergeCommit = await runLocalGit(
      input.localDir,
      [
        ...GIT_SYNC_COMMIT_IDENTITY_ARGS,
        "commit-tree",
        mergedTreeId,
        "-p",
        currentHead,
        "-p",
        input.importedHead,
        "-m",
        `Paperclip SSH sync merge ${input.importedHead.slice(0, 12)}`,
      ],
      {
        timeout: 60_000,
        maxBuffer: 64 * 1024,
      },
    );
    try {
      await runLocalGit(input.localDir, ["update-ref", headRef, mergeCommit.stdout.trim(), currentHead], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      });
      return;
    } catch (error) {
      if (isConcurrentRefUpdateError(error) && attempt < 4) continue;
      throw error;
    }
  }

  throw new Error(`Failed to integrate concurrent SSH git history for ${input.importedHead.slice(0, 12)} after multiple retries.`);
}

async function clearRemoteDirectory(input: {
  spec: SshConnectionConfig;
  remoteDir: string;
  preserveEntries?: string[];
}): Promise<void> {
  const preservePatterns = (input.preserveEntries ?? [])
    .map((entry) => `! -name ${shellQuote(entry)}`)
    .join(" ");
  const script = [
    "set -e",
    `mkdir -p ${shellQuote(input.remoteDir)}`,
    `find ${shellQuote(input.remoteDir)} -mindepth 1 -maxdepth 1 ${preservePatterns} -exec rm -rf -- {} +`,
  ].join("\n");
  await runSshScript(input.spec, script, {
    timeoutMs: 30_000,
    maxBuffer: 256 * 1024,
  });
}

async function removeDeletedPathsOnSsh(input: {
  spec: SshConnectionConfig;
  remoteDir: string;
  deletedPaths: string[];
}): Promise<void> {
  if (input.deletedPaths.length === 0) return;
  const quotedPaths = input.deletedPaths.map((entry) => shellQuote(entry)).join(" ");
  const script = `cd ${shellQuote(input.remoteDir)} && rm -rf -- ${quotedPaths}`;
  await runSshScript(input.spec, script, {
    timeoutMs: 30_000,
    maxBuffer: 256 * 1024,
  });
}

const PROJECT_REPOSITORY_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

async function isLocalGitRepositoryRoot(localDir: string): Promise<boolean> {
  try {
    const toplevel = await runLocalGit(localDir, ["rev-parse", "--show-toplevel"], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    const [directory, repository] = await Promise.all([
      fs.realpath(localDir),
      fs.realpath(toplevel.stdout.trim()),
    ]);
    return directory === repository;
  } catch {
    return false;
  }
}

export async function listLocalProjectRepositories(localDir: string): Promise<string[]> {
  const root = path.join(localDir, PROJECT_REPOSITORIES_DIR);
  const rootStat = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!rootStat) return [];
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Invalid project repositories directory");
  }
  const repositories: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && PROJECT_REPOSITORY_STAGING_PATTERN.test(entry.name)) continue;
    if (!entry.isDirectory() || !PROJECT_REPOSITORY_NAME_PATTERN.test(entry.name)) {
      throw new Error("Invalid project repository directory");
    }
    const relative = `${PROJECT_REPOSITORIES_DIR}/${entry.name}`;
    if (!(await isLocalGitRepositoryRoot(path.join(localDir, relative)))) {
      throw new Error(`Project repository is not a Git checkout: ${relative}`);
    }
    repositories.push(relative);
  }
  return repositories.sort();
}

async function transportGitWorkspaceToSsh(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir: string;
  snapshot: LocalGitWorkspaceSnapshot;
  exclude?: string[];
  onProgress?: RuntimeProgressSink;
  progressLabel: string;
}): Promise<void> {
  await importGitWorkspaceToSsh({
    spec: input.spec,
    localDir: input.localDir,
    remoteDir: input.remoteDir,
    snapshot: input.snapshot,
    onProgress: input.onProgress,
  });
  await syncDirectoryToSsh({
    spec: input.spec,
    localDir: input.localDir,
    remoteDir: input.remoteDir,
    exclude: [".git", ".paperclip-runtime", ...(input.exclude ?? [])],
    onProgress: input.onProgress,
    progressLabel: input.progressLabel,
  });
  await removeDeletedPathsOnSsh({
    spec: input.spec,
    remoteDir: input.remoteDir,
    deletedPaths: input.snapshot.deletedPaths,
  });
}

async function excludeProjectRepositoriesOnSsh(spec: SshConnectionConfig, remoteDir: string): Promise<void> {
  const pattern = `/${PROJECT_REPOSITORIES_DIR}/`;
  const excludeFile = path.posix.join(remoteDir, ".git", "info", "exclude");
  await runSshScript(
    spec,
    `mkdir -p ${shellQuote(path.posix.dirname(excludeFile))} && ` +
      `{ grep -qxF ${shellQuote(pattern)} ${shellQuote(excludeFile)} 2>/dev/null || ` +
      `printf '\\n%s\\n' ${shellQuote(pattern)} >> ${shellQuote(excludeFile)}; }`,
    { timeoutMs: 30_000 },
  );
}

async function allocateLoopbackPort(host: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a loopback port.")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForCondition(
  fn: () => Promise<void>,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
  } = {},
): Promise<void> {
  const timeoutAt = Date.now() + (options.timeoutMs ?? 10_000);
  const intervalMs = options.intervalMs ?? 200;
  let lastError: unknown = null;
  while (Date.now() < timeoutAt) {
    try {
      await fn();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Timed out waiting for SSH fixture readiness.");
}

async function isPidRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readProcessCommand(pid: number): Promise<string | null> {
  for (const format of ["command=", "args="]) {
    try {
      const result = await execFileText("ps", ["-o", format, "-p", String(pid)], {
        timeout: 5_000,
        maxBuffer: 16 * 1024,
      });
      const command = result.stdout.trim();
      if (command.length > 0) {
        return command;
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function isSshEnvLabFixtureProcess(state: Pick<SshEnvLabFixtureState, "pid" | "sshdConfigPath">): Promise<boolean> {
  if (!(await isPidRunning(state.pid))) {
    return false;
  }

  const command = await readProcessCommand(state.pid);
  if (!command) {
    return false;
  }

  return command.includes(state.sshdConfigPath);
}

export async function getSshEnvLabSupport(): Promise<SshEnvLabSupport> {
  if (process.platform === "darwin" && process.env.PAPERCLIP_ENABLE_DARWIN_SSH_ENV_LAB !== "1") {
    return {
      supported: false,
      reason: "SSH env-lab fixture is disabled on macOS; set PAPERCLIP_ENABLE_DARWIN_SSH_ENV_LAB=1 to opt in.",
    };
  }

  for (const command of ["ssh", "sshd", "ssh-keygen"]) {
    if (!(await commandExists(command))) {
      return {
        supported: false,
        reason: `Missing required command: ${command}`,
      };
    }
  }

  return {
    supported: true,
    reason: null,
  };
}

export function buildKnownHostsEntry(input: {
  host: string;
  port: number;
  publicKey: string;
}): string {
  return `[${input.host}]:${input.port} ${input.publicKey.trim()}`;
}

export async function runSshCommand(
  config: SshConnectionConfig,
  remoteCommand: string,
  options: {
    env?: Record<string, string>;
    stdin?: string;
    timeoutMs?: number;
    maxBuffer?: number;
  } = {},
): Promise<SshCommandResult> {
  let cleanup: () => Promise<void> = () => Promise.resolve();
  try {
    const auth = await createSshAuthArgs(config);
    cleanup = auth.cleanup;
    const sshArgs = [...auth.args];
    const envEntries = Object.entries(options.env ?? {})
      .filter((entry): entry is [string, string] => typeof entry[1] === "string");
    for (const [key] of envEntries) {
      if (!isValidShellEnvKey(key)) {
        throw new Error(`Invalid SSH environment variable key: ${key}`);
      }
    }

    // Mirror buildSshSpawnTarget: source the login profiles first, then run
    // `env KEY=VAL cmd` so user-supplied identity overrides win over anything a
    // profile re-exports. The SSH target is an operator-configured host, not a
    // Paperclip sandbox image, so it can expose `node` or an agent CLI only
    // through a login profile; a non-login SSH command would miss that PATH.
    // Source `/etc/profile` first so a host that exposes the PATH through
    // `/etc/profile.d` scripts still resolves node and the agent CLI.
    // The script no longer sources `nvm.sh`; a profile that adds nvm still runs.
    // .bash_profile typically sources .bashrc itself; only source .bashrc
    // directly when no .bash_profile exists, so a host that adds nvm in
    // .bashrc still resolves node without a double-run of the setup.
    const envArgs = envEntries.map(([key, value]) => `${key}=${shellQuote(value)}`);
    const remoteScript = [
      'if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi',
      'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
      'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1 || true; elif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc" >/dev/null 2>&1 || true; fi',
      'if [ -f "$HOME/.zprofile" ]; then . "$HOME/.zprofile" >/dev/null 2>&1 || true; fi',
      envArgs.length > 0
        ? `exec env ${envArgs.join(" ")} sh -c ${shellQuote(remoteCommand)}`
        : `exec sh -c ${shellQuote(remoteCommand)}`,
    ].join(" && ");

    sshArgs.push(
      "-p",
      String(config.port),
      `${config.username}@${config.host}`,
      `sh -c ${shellQuote(remoteScript)}`,
    );

    return options.stdin != null
      ? await spawnText("ssh", sshArgs, {
          stdin: options.stdin,
          timeout: options.timeoutMs ?? 15_000,
          maxBuffer: options.maxBuffer ?? 1024 * 128,
        })
      : await execFileText("ssh", sshArgs, {
          timeout: options.timeoutMs ?? 15_000,
          maxBuffer: options.maxBuffer ?? 1024 * 128,
        });
  } finally {
    await cleanup();
  }
}

// Run record, format version 1 (PAR-9960). The ssh spawn script writes it to
// `<remoteRunDir>/record` before `exec`, so after a server exit the host can
// find the remote process group. Three `key=value` lines, newline after each:
// `v=1`, `pgid=<decimal>` (from `ps -o pgid=`), `lstart=<text>` (from
// `ps -o lstart=`, compared as an exact string on the same machine, never
// parsed to a date). Readers: PAR-9917 (lease) and PAR-9399 (stopRemote).
export const SSH_RUN_RECORD_FILE = "record";
export const SSH_RUN_RECORD_VERSION = "1";
export const SSH_RUN_RECORD_EXCLUDE_PATTERN = "/.paperclip-runs/";
export const SSH_RUN_DIR_REFUSED_EXIT_CODE = 125;

export type SshRunRecordParseResult =
  | { status: "readable"; pgid: number; lstart: string }
  | { status: "unreadable" };

/** Pure parser of the version-1 run record. Never throws. */
export function parseSshRunRecord(text: unknown): SshRunRecordParseResult {
  const unreadable = { status: "unreadable" } as const;
  if (typeof text !== "string" || !text.endsWith("\n")) return unreadable;
  const lines = text.slice(0, -1).split("\n");
  if (lines.length !== 3) return unreadable;
  const fields = new Map<string, string>();
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq <= 0) return unreadable;
    const key = line.slice(0, eq);
    if (fields.has(key)) return unreadable;
    fields.set(key, line.slice(eq + 1));
  }
  const pgidText = fields.get("pgid");
  const lstart = fields.get("lstart");
  if (fields.get("v") !== SSH_RUN_RECORD_VERSION || pgidText == null || lstart == null) return unreadable;
  if (!/^[0-9]+$/.test(pgidText)) return unreadable;
  const pgid = Number(pgidText);
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return unreadable;
  if (lstart.trim().length === 0 || lstart !== lstart.trim()) return unreadable;
  return { status: "readable", pgid, lstart };
}

function trimTrailingSlashes(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : "/";
}

// POSIX sh block run in a subshell (so `umask` and `LC_ALL` do not reach the
// agent command). Exit 125 with one stderr line when the run dir is not
// confined to the workspace: lexically before `mkdir`, then physically
// (symlinks resolved) on the deepest existing ancestor and on the made dir.
function buildSshRunRecordScript(remoteWorkspacePath: string, remoteRunDir: string): string {
  const exclude = shellQuote(SSH_RUN_RECORD_EXCLUDE_PATTERN);
  return [
    "(",
    "export LC_ALL=C",
    `ws=${shellQuote(trimTrailingSlashes(remoteWorkspacePath))}`,
    `rd=${shellQuote(remoteRunDir)}`,
    `refuse() { printf '%s\\n' "paperclip: remote run dir refused: $1" >&2; exit ${SSH_RUN_DIR_REFUSED_EXIT_CODE}; }`,
    'case "$rd" in /*) ;; *) refuse "not absolute";; esac',
    'case "$rd/" in */./*|*/../*|*//*) refuse "dot or empty path part";; esac',
    'case "$rd" in "$ws"/?*) ;; *) refuse "outside workspace";; esac',
    'wsp=$(cd -P "$ws" 2>/dev/null && pwd -P) || refuse "workspace missing"',
    'inws() { r=$(cd -P "$1" 2>/dev/null && pwd -P) || return 1; case "$r" in "$wsp"|"$wsp"/*) return 0;; esac; return 1; }',
    'p=$rd; while [ -n "$p" ] && [ ! -d "$p" ]; do p=${p%/*}; done',
    'inws "${p:-/}" || refuse "outside workspace after resolving links"',
    'umask 077',
    'mkdir -p "$rd" || exit 1',
    'inws "$rd" || refuse "outside workspace after resolving links"',
    "pg=$(ps -o pgid= -p $$ | tr -d ' ')",
    "st=$(ps -o lstart= -p \"$pg\" | sed 's/^ *//;s/ *$//')",
    `printf 'v=${SSH_RUN_RECORD_VERSION}\\npgid=%s\\nlstart=%s\\n' "$pg" "$st" > "$rd/record.tmp.$$" || exit 1`,
    `mv -f "$rd/record.tmp.$$" "$rd/${SSH_RUN_RECORD_FILE}" || exit 1`,
    'if top=$(git -C "$ws" rev-parse --show-toplevel 2>/dev/null) && [ "$top" = "$wsp" ] &&',
    '  ex=$(git -C "$ws" rev-parse --git-path info/exclude 2>/dev/null); then',
    '  case "$ex" in /*) ;; *) ex="$ws/$ex";; esac',
    `  grep -qxF ${exclude} "$ex" 2>/dev/null || { mkdir -p "\${ex%/*}" && printf '\\n%s\\n' ${exclude} >> "$ex"; } || true`,
    "fi",
    ")",
  ].join("\n");
}

// The run directory layout of plan 13.9: `<remoteWorkspacePath>/.paperclip-runs/<runId>`.
// One function, so the adapter and the lease (PAR-9917) name the same path.
// Null for a run id that is not a plain token: no record, no stopRemote.
export const SSH_RUN_DIR_PARENT = ".paperclip-runs";
export function sshRemoteRunDirFor(remoteWorkspacePath: string, runId: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(runId) || !remoteWorkspacePath.startsWith("/")) return null;
  const ws = trimTrailingSlashes(remoteWorkspacePath);
  return `${ws === "/" ? "" : ws}/${SSH_RUN_DIR_PARENT}/${runId}`;
}

// PAR-9399: a signal to the local ssh client never reaches the remote process
// group. stopRemote reads the version-1 record over a second ssh connection
// and signals that group.
export type SshRemoteStopSignal = "TERM" | "KILL";
export type SshRemoteStopOutcome =
  | "signalled"
  | "gone"
  | "leader-gone"
  | "mismatch"
  | "refused"
  | "missing"
  | "unreadable"
  | "failed"
  | "error";
export type SshRemoteCommandRunner = (script: string, timeoutMs: number) => Promise<SshCommandResult>;

export const SSH_REMOTE_STOP_TIMEOUT_MS = 10_000;
const SSH_REMOTE_STOP_OUTCOMES = new Set<string>([
  "signalled", "gone", "leader-gone", "mismatch", "refused", "missing", "unreadable", "failed",
]);

// Reads `<runDir>/record` with the rules of parseSshRunRecord (exactly the
// three keys once each, newline-terminated, `v=1`, decimal pgid, lstart with
// no edge spaces; the shell is stricter on a leading zero or over 15 digits).
// Then: refuses group 0/1 and its own group, requires the group to exist and
// the leader's start time to equal the recorded one, so a reused id is never
// signalled. Prints one outcome token. `kill -s SIG -- -pgid`, because dash
// (Ubuntu's /bin/sh) rejects `kill -SIG -- -pgid`.
export function buildSshRemoteStopScript(remoteRunDir: string, signal: SshRemoteStopSignal): string {
  return [
    "export LC_ALL=C",
    `f=${shellQuote(`${remoteRunDir}/${SSH_RUN_RECORD_FILE}`)}`,
    'if [ ! -f "$f" ]; then echo missing; exit 0; fi',
    "bad() { echo unreadable; exit 0; }",
    "n=0; v=; pg=; want=; hv=; hp=; hl=",
    "while IFS= read -r l; do",
    "  n=$((n+1))",
    "  case \"$l\" in",
    "    v=*) [ -z \"$hv\" ] || bad; hv=1; v=${l#v=};;",
    "    pgid=*) [ -z \"$hp\" ] || bad; hp=1; pg=${l#pgid=};;",
    "    lstart=*) [ -z \"$hl\" ] || bad; hl=1; want=${l#lstart=};;",
    "    *) bad;;",
    "  esac",
    "done < \"$f\"",
    "[ -z \"$l\" ] || bad",
    `[ "$n" -eq 3 ] && [ "$v" = ${SSH_RUN_RECORD_VERSION} ] || bad`,
    "case \"$pg\" in ''|0?*|*[!0-9]*|????????????????*) bad;; esac",
    "case \"$want\" in ''|[[:space:]]*|*[[:space:]]) bad;; esac",
    'if [ "$pg" -le 1 ]; then echo refused; exit 0; fi',
    "self=$(ps -o pgid= -p $$ | tr -d ' ')",
    'if [ "$pg" = "$self" ]; then echo refused; exit 0; fi',
    'if ! kill -s 0 -- "-$pg" 2>/dev/null; then echo gone; exit 0; fi',
    "have=$(ps -o lstart= -p \"$pg\" 2>/dev/null | sed 's/^ *//;s/ *$//')",
    'if [ -z "$have" ]; then echo leader-gone; exit 0; fi',
    'if [ "$have" != "$want" ]; then echo mismatch; exit 0; fi',
    `if kill -s ${signal} -- "-$pg"; then echo signalled; else echo failed; fi`,
  ].join("\n");
}

// Run-end removal (AC 4, temporary until PAR-9961 moves it into the lease
// release). Deletes inside the user's workspace, so it removes only
// `<ws>/.paperclip-runs/<runId>` after resolving links: a `.paperclip-runs`
// that resolves outside the workspace, or a run dir that is a link, is left.
export function buildSshRunDirRemoveScript(remoteWorkspacePath: string, remoteRunDir: string): string {
  return [
    `ws=${shellQuote(trimTrailingSlashes(remoteWorkspacePath))}`,
    `rd=${shellQuote(remoteRunDir)}`,
    `case "$rd" in "$ws"/${SSH_RUN_DIR_PARENT}/?*) ;; *) echo refused; exit 0;; esac`,
    'name=${rd##*/}',
    `case "$name" in ''|*[!A-Za-z0-9_-]*) echo refused; exit 0;; esac`,
    `[ "$rd" = "$ws/${SSH_RUN_DIR_PARENT}/$name" ] || { echo refused; exit 0; }`,
    `base=$(cd -P "$ws/${SSH_RUN_DIR_PARENT}" 2>/dev/null && pwd -P) || { echo absent; exit 0; }`,
    'wsp=$(cd -P "$ws" 2>/dev/null && pwd -P) || { echo absent; exit 0; }',
    'case "$base" in "$wsp"/?*) ;; *) echo refused; exit 0;; esac',
    'if [ -L "$base/$name" ]; then echo refused; exit 0; fi',
    'if [ ! -e "$base/$name" ]; then echo absent; exit 0; fi',
    'rm -rf -- "$base/$name" && echo removed',
  ].join("\n");
}

export async function buildSshSpawnTarget(input: {
  spec: SshRemoteExecutionSpec;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Absolute run directory under `spec.remoteWorkspacePath`; absent: script unchanged. */
  remoteRunDir?: string;
  /** Test seam: runs a stop/removal script on the remote. Defaults to ssh. */
  remoteRunner?: SshRemoteCommandRunner;
}): Promise<{
  command: string;
  args: string[];
  cleanup: () => Promise<void>;
  stopRemote?: (signal: SshRemoteStopSignal) => Promise<SshRemoteStopOutcome>;
}> {
  for (const key of Object.keys(input.env)) {
    if (!isValidShellEnvKey(key)) {
      throw new Error(`Invalid SSH environment variable key: ${key}`);
    }
  }
  const auth = await createSshAuthArgs(input.spec);
  const sshArgs = [...auth.args];
  const envArgs = Object.entries(input.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  const remoteCommandParts = [shellQuote(input.command), ...input.args.map((arg) => shellQuote(arg))].join(" ");
  // Source the login profiles first, then run `env KEY=VAL cmd` so
  // user-supplied identity overrides win over anything a profile re-exports.
  // The SSH target is an operator-configured host, not a Paperclip sandbox
  // image, so it can expose `node` or an agent CLI only through a login
  // profile; a non-login SSH command would miss that PATH. Source
  // `/etc/profile` first so a host that exposes the PATH through
  // `/etc/profile.d` scripts still resolves node and the agent CLI. The script
  // no longer sources `nvm.sh`; a profile that adds nvm still runs.
  // .bash_profile typically sources .bashrc itself; only source .bashrc
  // directly when no .bash_profile exists, so a host that adds nvm in
  // .bashrc still resolves node without a double-run of the setup.
  const remoteScript = [
    'if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1 || true; elif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.zprofile" ]; then . "$HOME/.zprofile" >/dev/null 2>&1 || true; fi',
    ...(input.remoteRunDir != null
      ? [buildSshRunRecordScript(input.spec.remoteWorkspacePath, input.remoteRunDir)]
      : []),
    `cd ${shellQuote(input.spec.remoteCwd)}`,
    envArgs.length > 0
      ? `exec env ${envArgs.join(" ")} ${remoteCommandParts}`
      : `exec ${remoteCommandParts}`,
  ].join(" && ");

  const destination = ["-p", String(input.spec.port), `${input.spec.username}@${input.spec.host}`];
  sshArgs.push(...destination, `sh -c ${shellQuote(remoteScript)}`);

  const remoteRunDir = input.remoteRunDir;
  if (remoteRunDir == null) {
    return { command: "ssh", args: sshArgs, cleanup: auth.cleanup };
  }

  // Stop and removal connections reuse the spawn's auth files and skip the
  // login profiles. After cleanup the auth files are gone: stopRemote is "error".
  let authCleaned = false;
  let cleanupPromise: Promise<void> | null = null;
  const runRemote: SshRemoteCommandRunner =
    input.remoteRunner ??
    ((script, timeoutMs) =>
      execFileText("ssh", [...auth.args, ...destination, `sh -c ${shellQuote(script)}`], {
        timeout: timeoutMs,
      }));
  const stopRemote = async (signal: SshRemoteStopSignal): Promise<SshRemoteStopOutcome> => {
    if (authCleaned) return "error";
    try {
      const result = await runRemote(buildSshRemoteStopScript(remoteRunDir, signal), SSH_REMOTE_STOP_TIMEOUT_MS);
      const token = result.stdout.trim().split(/\s+/).at(-1) ?? "";
      return SSH_REMOTE_STOP_OUTCOMES.has(token) ? (token as SshRemoteStopOutcome) : "error";
    } catch {
      return "error";
    }
  };

  return {
    command: "ssh",
    args: sshArgs,
    stopRemote,
    cleanup: () =>
      (cleanupPromise ??= (async () => {
        authCleaned = true;
        try {
          await runRemote(
            buildSshRunDirRemoveScript(input.spec.remoteWorkspacePath, remoteRunDir),
            SSH_REMOTE_STOP_TIMEOUT_MS,
          );
        } catch {
          // Best effort: a leftover dir holds one small 0600 file, git-excluded.
        } finally {
          await auth.cleanup();
        }
      })()),
  };
}

// Remote run check (PAR-9917, plan 13.9 finding 2). The remote part only
// prints facts; `decideSshRunCheck` decides on the host.
export type SshRunCheckBasis =
  | "never_spawned" | "no_record" | "legacy_lease" | "group_empty"
  | "leader_gone_members_live" | "leader_live" | "group_reused" | "check_failed" | "refused";
export interface SshRunCheck {
  result: "alive" | "gone" | "unknown";
  basis: SshRunCheckBasis;
  pgid?: number;
  leaderStart?: string;
  checkedAt: string;
}
type SshRunCheckDecision = Omit<SshRunCheck, "checkedAt">;
const SSH_RUN_CHECK_HEADER = "paperclip-run-check 1\n";
const SSH_RUN_CHECK_TIMEOUT_MS = 10_000;

/** Lexical: absolute, no `.`/`..`/empty parts, strictly below the workspace. */
export function sshRunDirIsConfined(remoteWorkspacePath: string, remoteRunDir: string): boolean {
  if (!remoteRunDir.startsWith("/") || /(^|\/)\.{0,2}(\/|$)/.test(remoteRunDir.slice(1))) return false;
  const ws = trimTrailingSlashes(remoteWorkspacePath);
  return remoteRunDir.length > ws.length + 1 && remoteRunDir.startsWith(ws === "/" ? "/" : `${ws}/`);
}

export function buildSshRunCheckScript(remoteWorkspacePath: string, remoteRunDir: string): string {
  return [
    "export LC_ALL=C",
    `ws=${shellQuote(trimTrailingSlashes(remoteWorkspacePath))}`,
    `rd=${shellQuote(remoteRunDir)}`,
    `printf '${SSH_RUN_CHECK_HEADER.trim()}\\n'`,
    'wsp=$(cd -P "$ws" 2>/dev/null && pwd -P) || { printf "refused\\nend\\n"; exit 0; }',
    'if r=$(cd -P "$rd" 2>/dev/null && pwd -P); then case "$r" in "$wsp"/?*) ;; *) printf "refused\\nend\\n"; exit 0;; esac; fi',
    'if [ ! -f "$rd/record" ]; then printf "norecord\\nend\\n"; exit 0; fi',
    `printf 'record\\n'; cat "$rd/record" || exit 1; printf '\\037\\n'`,
    `pg=$(sed -n 's/^pgid=\\([0-9][0-9]*\\)$/\\1/p' "$rd/record" | head -n 1)`,
    'if [ -n "$pg" ]; then',
    "  all=$(ps -A -o pgid=) || exit 1",
    `  printf 'pgid=%s\\n' "$pg"`,
    `  printf '%s\\n' "$all" | awk -v g="$pg" '$1==g{n++} END{printf "members=%d total=%d\\n", n, NR}'`,
    `  printf 'leader=%s\\n' "$(ps -o lstart= -p "$pg" 2>/dev/null | sed 's/^ *//;s/ *$//')"`,
    "fi",
    "printf 'end\\n'",
  ].join("\n");
}

/** Pure decision over the lease facts and the remote output. Never throws. */
export function decideSshRunCheck(input: { spawnMarked: boolean; stdout: string | null }): SshRunCheckDecision {
  const failed = { result: "unknown", basis: "check_failed" } as const;
  const noRecord: SshRunCheckDecision = input.spawnMarked
    ? { result: "unknown", basis: "no_record" } : { result: "gone", basis: "never_spawned" };
  const at = input.stdout?.indexOf(SSH_RUN_CHECK_HEADER) ?? -1;
  if (input.stdout == null || at < 0 || (at > 0 && input.stdout[at - 1] !== "\n")) return failed;
  const out = input.stdout.slice(at + SSH_RUN_CHECK_HEADER.length);
  if (!out.endsWith("end\n")) return failed;
  if (out === "refused\nend\n") return { result: "unknown", basis: "refused" };
  if (out === "norecord\nend\n") return noRecord;
  const sep = out.indexOf("\x1f\n");
  if (!out.startsWith("record\n") || sep < 0) return failed;
  const record = parseSshRunRecord(out.slice("record\n".length, sep));
  if (record.status !== "readable") return noRecord;
  const facts = /^pgid=(\d+)\nmembers=(\d+) total=(\d+)\nleader=([^\n]*)\nend\n$/.exec(out.slice(sep + 2));
  if (!facts || Number(facts[1]) !== record.pgid || Number(facts[3]) === 0) return failed;
  const leaderStart = facts[4]!;
  const base = { pgid: record.pgid, ...(leaderStart ? { leaderStart } : {}) };
  if (Number(facts[2]) === 0) return { result: "gone", basis: "group_empty", ...base };
  if (!leaderStart) return { result: "alive", basis: "leader_gone_members_live", ...base };
  return leaderStart === record.lstart
    ? { result: "alive", basis: "leader_live", ...base }
    : { result: "gone", basis: "group_reused", ...base };
}

/** One ssh command, 10 s limit, never throws. `lease` is the ssh lease's metadata. */
export async function checkRemoteRun(
  config: SshConnectionConfig,
  lease: { remoteRunDir?: unknown; remoteSpawnStartedAt?: unknown } | null,
  options: { run?: typeof runSshCommand; now?: () => Date } = {},
): Promise<SshRunCheck> {
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  const runDir = lease?.remoteRunDir;
  if (typeof runDir !== "string" || runDir.length === 0) return { result: "unknown", basis: "legacy_lease", checkedAt };
  if (!sshRunDirIsConfined(config.remoteWorkspacePath, runDir)) return { result: "unknown", basis: "refused", checkedAt };
  let stdout: string | null = null;
  try {
    const result = await (options.run ?? runSshCommand)(
      config, buildSshRunCheckScript(config.remoteWorkspacePath, runDir), { timeoutMs: SSH_RUN_CHECK_TIMEOUT_MS });
    stdout = result.stdout;
  } catch {
    stdout = null;
  }
  const spawnMarked = typeof lease?.remoteSpawnStartedAt === "string" && lease.remoteSpawnStartedAt.length > 0;
  return { ...decideSshRunCheck({ spawnMarked, stdout }), checkedAt };
}

export async function syncDirectoryToSsh(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir: string;
  exclude?: string[];
  followSymlinks?: boolean;
  onProgress?: RuntimeProgressSink;
  progressLabel?: string;
}): Promise<void> {
  const auth = await createSshAuthArgs(input.spec);
  const sshArgs = [
    ...auth.args,
    "-p",
    String(input.spec.port),
    `${input.spec.username}@${input.spec.host}`,
    `sh -c ${shellQuote(`mkdir -p ${shellQuote(input.remoteDir)} && tar -xf - -C ${shellQuote(input.remoteDir)}`)}`,
  ];

  // tar's archive size isn't known until tar finishes, so estimate it from the
  // local file sizes and clamp the reported percent to 99% until the pipe closes.
  // The estimate walk runs concurrently with the transfer so it never delays the
  // pipe from opening on large workspaces.
  const progress = input.onProgress
    ? createTransferProgress({
      onProgress: input.onProgress,
      phase: "Syncing",
      direction: "to",
      label: input.progressLabel,
      totalBytes: estimateLocalDirSize({
        localDir: input.localDir,
        exclude: input.exclude,
        followSymlinks: input.followSymlinks,
      }),
      estimated: true,
    })
    : null;

  try {
    await new Promise<void>((resolve, reject) => {
    const tarArgs = [
      ...(input.followSymlinks ? ["-h"] : []),
      "-C",
      input.localDir,
      ...tarExcludeArgs(input.exclude),
      "-cf",
      "-",
      ".",
    ];
    const tar = spawn("tar", tarArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: tarSpawnEnv(),
    });
    const ssh = spawn("ssh", sshArgs, {
      stdio: ["pipe", "ignore", "pipe"],
    });

    let tarStderr = "";
    let sshStderr = "";
    let settled = false;
    let tarExited = false;
    let sshExited = false;
    let tarExitCode: number | null = null;
    let sshExitCode: number | null = null;

    const maybeFinish = () => {
      if (settled || !tarExited || !sshExited) {
        return;
      }
      settled = true;
      if (!tarStopped && (tarExitCode ?? 0) !== 0) {
        reject(new Error(tarStderr.trim() || `tar exited with code ${tarExitCode ?? -1}`));
        return;
      }
      if ((sshExitCode ?? 0) !== 0) {
        reject(new Error(sshStderr.trim() || `ssh exited with code ${sshExitCode ?? -1}`));
        return;
      }
      resolve();
    };

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      tar.kill("SIGTERM");
      ssh.kill("SIGTERM");
      reject(error);
    };

    // Peer-kill rule: when ssh stops reading, tar blocks on a full pipe and
    // never exits. Stop tar and let maybeFinish report ssh's own exit code and
    // stderr, rather than failing with a bare EPIPE. A tar whose output already
    // ended is exiting by itself and keeps its own exit code; a stopped one's
    // exit code is ignored.
    let tarStopped = false;
    const stopTar = () => {
      if (tarExited || tar.stdout?.readableEnded) return;
      tarStopped = true;
      tar.kill("SIGTERM");
    };
    if (tar.stdout) {
      const tarOut = progress ? tar.stdout.pipe(progress.counter) : tar.stdout;
      progress?.counter.on("error", fail);
      pipeIntoChildStdin(tarOut, ssh, "ssh.syncDirectoryToSsh", stopTar, { includePipeClosed: true });
    }
    tar.stderr?.on("data", (chunk) => {
      tarStderr += String(chunk);
    });
    ssh.stderr?.on("data", (chunk) => {
      sshStderr += String(chunk);
    });

    tar.on("error", fail);
    ssh.on("error", fail);
    tar.on("close", (code) => {
      tarExited = true;
      tarExitCode = code;
      maybeFinish();
    });
    ssh.on("close", (code) => {
      sshExited = true;
      sshExitCode = code;
      stopTar();
      maybeFinish();
    });
    }).finally(auth.cleanup);
    await progress?.finish();
  } catch (error) {
    await progress?.fail();
    throw error;
  }
}

export async function syncDirectoryFromSsh(input: {
  spec: SshRemoteExecutionSpec;
  remoteDir: string;
  localDir: string;
  exclude?: string[];
  preserveLocalEntries?: string[];
  onProgress?: RuntimeProgressSink;
  progressLabel?: string;
}): Promise<void> {
  const auth = await createSshAuthArgs(input.spec);
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-sync-back-"));
  const remoteTarScript = [
    `cd ${shellQuote(input.remoteDir)}`,
    `tar ${[...tarExcludeArgs(input.exclude).map(shellQuote), "-cf", "-", "."].join(" ")}`,
  ].join(" && ");
  const sshArgs = [
    ...auth.args,
    "-p",
    String(input.spec.port),
    `${input.spec.username}@${input.spec.host}`,
    `sh -c ${shellQuote(remoteTarScript)}`,
  ];

  // The remote tar size isn't known locally, so probe the remote directory for
  // an estimate (clamped to 99%). The probe runs concurrently with the transfer
  // so its round-trip never delays the restore; when it is unavailable we report
  // bytes received in MB mode with a terminal completion line.
  const progress = input.onProgress
    ? createTransferProgress({
      onProgress: input.onProgress,
      phase: "Restoring",
      direction: "from",
      label: input.progressLabel,
      totalBytes: probeRemoteDirSize({ spec: input.spec, remoteDir: input.remoteDir }),
      estimated: true,
    })
    : null;

  try {
    await new Promise<void>((resolve, reject) => {
      const ssh = spawn("ssh", sshArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const tar = spawn("tar", ["-xf", "-", "-C", stagingDir], {
        stdio: ["pipe", "ignore", "pipe"],
        env: tarSpawnEnv(),
      });

      let sshStderr = "";
      let tarStderr = "";
      let settled = false;
      let sshExited = false;
      let tarExited = false;
      let sshExitCode: number | null = null;
      let tarExitCode: number | null = null;

      const maybeFinish = () => {
        if (settled || !sshExited || !tarExited) return;
        settled = true;
        if (!sshStopped && (sshExitCode ?? 0) !== 0) {
          reject(new Error(sshStderr.trim() || `ssh exited with code ${sshExitCode ?? -1}`));
          return;
        }
        if ((tarExitCode ?? 0) !== 0) {
          reject(new Error(tarStderr.trim() || `tar exited with code ${tarExitCode ?? -1}`));
          return;
        }
        resolve();
      };

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        ssh.kill("SIGTERM");
        tar.kill("SIGTERM");
        reject(error);
      };

      // Peer-kill rule (see syncDirectoryToSsh): when tar stops reading, ssh
      // blocks on a full pipe. Stop ssh and let tar's exit decide: OpenSSH
      // exits 255 on SIGTERM, so a stopped ssh's exit code is ignored.
      let sshStopped = false;
      const stopSsh = () => {
        if (sshExited || ssh.stdout?.readableEnded) return;
        sshStopped = true;
        ssh.kill("SIGTERM");
      };
      if (ssh.stdout) {
        const sshOut = progress ? ssh.stdout.pipe(progress.counter) : ssh.stdout;
        progress?.counter.on("error", fail);
        pipeIntoChildStdin(sshOut, tar, "ssh.syncDirectoryFromSsh", stopSsh, { includePipeClosed: true });
      }
      ssh.stderr?.on("data", (chunk) => {
        sshStderr += String(chunk);
      });
      tar.stderr?.on("data", (chunk) => {
        tarStderr += String(chunk);
      });

      ssh.on("error", fail);
      tar.on("error", fail);
      ssh.on("close", (code) => {
        sshExited = true;
        sshExitCode = code;
        maybeFinish();
      });
      tar.on("close", (code) => {
        tarExited = true;
        tarExitCode = code;
        stopSsh();
        maybeFinish();
      });
    });
    await progress?.finish();

    await clearLocalDirectory(input.localDir, input.preserveLocalEntries);
    await copyDirectoryContents(stagingDir, input.localDir);
  } catch (error) {
    await progress?.fail();
    throw error;
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    await auth.cleanup();
  }
}

export async function prepareWorkspaceForSshExecution(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir?: string;
  onProgress?: RuntimeProgressSink;
  workspaceFileMode?: "all";
  workspaceExclude?: string[];
}): Promise<{ gitBacked: boolean; repositories?: string[]; excludedPaths?: string[] }> {
  const remoteDir = input.remoteDir ?? input.spec.remoteCwd;
  const gitSnapshot = input.workspaceFileMode === "all" ? null : await readLocalGitWorkspaceSnapshot(input.localDir);
  const excludedPaths = await listProjectRepositoryStagingPaths(input.localDir);
  const excludedResult = excludedPaths.length > 0 ? { excludedPaths } : {};

  if (gitSnapshot) {
    const repositories = await listLocalProjectRepositories(input.localDir);
    await transportGitWorkspaceToSsh({
      spec: input.spec,
      localDir: input.localDir,
      remoteDir,
      snapshot: gitSnapshot,
      // PAR-3341: never upload the local .paperclip/ instance directory.
      exclude: [".paperclip", ...(repositories.length > 0 ? [PROJECT_REPOSITORIES_DIR] : excludedPaths)],
      onProgress: input.onProgress,
      progressLabel: "workspace",
    });
    if (repositories.length > 0) {
      await excludeProjectRepositoriesOnSsh(input.spec, remoteDir);
    }
    for (const relative of repositories) {
      const localDir = path.join(input.localDir, relative);
      const snapshot = await readLocalGitWorkspaceSnapshot(localDir);
      if (!snapshot) throw new Error(`Cannot read the Git state of project repository: ${relative}`);
      await transportGitWorkspaceToSsh({
        spec: input.spec,
        localDir,
        remoteDir: path.posix.join(remoteDir, relative),
        snapshot,
        onProgress: input.onProgress,
        progressLabel: relative,
      });
    }
    return { gitBacked: true, ...(repositories.length > 0 ? { repositories } : {}), ...excludedResult };
  }

  await clearRemoteDirectory({
    spec: input.spec,
    remoteDir,
    preserveEntries: [".paperclip-runtime"],
  });
  await syncDirectoryToSsh({
    spec: input.spec,
    localDir: input.localDir,
    remoteDir,
    exclude: [".paperclip-runtime", ".paperclip", ...excludedPaths, ...(input.workspaceFileMode === "all" ? input.workspaceExclude ?? [] : [])],
    onProgress: input.onProgress,
    progressLabel: "workspace",
  });
  return { gitBacked: false, ...excludedResult };
}

export async function restoreWorkspaceFromSshExecution(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir?: string;
  baselineSnapshot?: DirectorySnapshot;
  restoreGitHistory?: boolean;
  onProgress?: RuntimeProgressSink;
  repositories?: Array<{ path: string; baselineSnapshot?: DirectorySnapshot }>;
}): Promise<void> {
  const remoteDir = input.remoteDir ?? input.spec.remoteCwd;
  const repositories = input.repositories ?? [];
  for (const repository of repositories) {
    if (
      path.posix.dirname(repository.path) !== PROJECT_REPOSITORIES_DIR ||
      !PROJECT_REPOSITORY_NAME_PATTERN.test(path.posix.basename(repository.path))
    ) {
      throw new Error(`Invalid project repository path: ${repository.path}`);
    }
    if (input.baselineSnapshot && !repository.baselineSnapshot) {
      throw new Error(`Project repository has no workspace baseline: ${repository.path}`);
    }
  }
  if (
    input.baselineSnapshot &&
    repositories.length > 0 &&
    !input.baselineSnapshot.exclude.includes(PROJECT_REPOSITORIES_DIR)
  ) {
    throw new Error(`Workspace baseline must exclude ${PROJECT_REPOSITORIES_DIR} when project repositories are restored separately`);
  }
  for (const repository of repositories) {
    await restoreWorkspaceRootFromSsh({
      spec: input.spec,
      localDir: path.join(input.localDir, repository.path),
      remoteDir: path.posix.join(remoteDir, repository.path),
      baselineSnapshot: repository.baselineSnapshot,
      restoreGitHistory: input.restoreGitHistory,
      onProgress: input.onProgress,
      progressLabel: repository.path,
    });
  }
  await restoreWorkspaceRootFromSsh({
    spec: input.spec,
    localDir: input.localDir,
    remoteDir,
    baselineSnapshot: input.baselineSnapshot,
    restoreGitHistory: input.restoreGitHistory,
    onProgress: input.onProgress,
    progressLabel: "workspace",
    hasProjectRepositories: repositories.length > 0,
  });
}

async function restoreWorkspaceRootFromSsh(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir: string;
  baselineSnapshot?: DirectorySnapshot;
  restoreGitHistory?: boolean;
  onProgress?: RuntimeProgressSink;
  progressLabel: string;
  hasProjectRepositories?: boolean;
}): Promise<void> {
  const remoteDir = input.remoteDir;
  if (input.baselineSnapshot) {
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-sync-back-"));
    const importedRef = input.restoreGitHistory
      ? `refs/paperclip/ssh-sync/imported/${randomUUID()}`
      : null;
    try {
      const importedHead = input.restoreGitHistory
        ? await exportGitWorkspaceFromSsh({
          spec: input.spec,
          remoteDir,
          localDir: input.localDir,
          importedRef: importedRef ?? undefined,
          resetLocalWorkspace: false,
          onProgress: input.onProgress,
        })
        : null;
      await syncDirectoryFromSsh({
        spec: input.spec,
        remoteDir,
        localDir: stagingDir,
        exclude: input.baselineSnapshot.exclude,
        onProgress: input.onProgress,
        progressLabel: input.progressLabel,
      });
      await mergeDirectoryWithBaseline({
        baseline: input.baselineSnapshot,
        sourceDir: stagingDir,
        targetDir: input.localDir,
        // Git history advances via integrateImportedGitHead; the working tree
        // still comes from the remote file snapshot so dirty remote edits win.
        beforeApply: importedHead
          ? async () => {
            await integrateImportedGitHead({
              localDir: input.localDir,
              importedHead,
            });
          }
          : undefined,
        // integrateImportedGitHead moves the branch with update-ref, which leaves the index
        // on the old tip. Reset it to HEAD as the sandbox restore does (#8595).
        afterApply: importedHead
          ? async () => {
            await resetLocalGitIndexToHead({ localDir: input.localDir });
          }
          : undefined,
      });
    } finally {
      if (importedRef) {
        await runLocalGit(input.localDir, ["update-ref", "-d", importedRef], {
          timeout: 10_000,
          maxBuffer: 16 * 1024,
        }).catch(() => undefined);
      }
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
    return;
  }
  const gitSnapshot = await readLocalGitWorkspaceSnapshot(input.localDir);

  if (gitSnapshot) {
    const projectRepositoryEntries = input.hasProjectRepositories ? [PROJECT_REPOSITORIES_DIR] : [];
    await exportGitWorkspaceFromSsh({
      spec: input.spec,
      remoteDir,
      localDir: input.localDir,
      onProgress: input.onProgress,
    });
    await syncDirectoryFromSsh({
      spec: input.spec,
      remoteDir,
      localDir: input.localDir,
      // PAR-3341: .paperclip is not synced, so keep the local copy on restore.
      exclude: [".git", ".paperclip-runtime", ".paperclip", ...projectRepositoryEntries],
      preserveLocalEntries: [".git", ".paperclip", ...projectRepositoryEntries],
      onProgress: input.onProgress,
      progressLabel: input.progressLabel,
    });
    return;
  }

  await syncDirectoryFromSsh({
    spec: input.spec,
    remoteDir,
    localDir: input.localDir,
    exclude: [".paperclip-runtime", ".paperclip"],
    preserveLocalEntries: [".paperclip"],
    onProgress: input.onProgress,
    progressLabel: input.progressLabel,
  });
}

export async function ensureSshWorkspaceReady(
  config: SshConnectionConfig,
): Promise<{ remoteCwd: string }> {
  const result = await runSshCommand(
    config,
    `mkdir -p ${shellQuote(config.remoteWorkspacePath)} && cd ${shellQuote(config.remoteWorkspacePath)} && pwd`,
  );
  return {
    remoteCwd: result.stdout.trim(),
  };
}

const SSH_ENV_LAB_FIXTURE_PATH_FIELDS = [
  "rootDir",
  "workspaceDir",
  "statePath",
  "clientPrivateKeyPath",
  "clientPublicKeyPath",
  "hostPrivateKeyPath",
  "hostPublicKeyPath",
  "authorizedKeysPath",
  "knownHostsPath",
  "sshdConfigPath",
  "sshdLogPath",
] as const satisfies readonly (keyof SshEnvLabFixtureState)[];

// True when candidate is an absolute path equal to rootDir or nested under
// it. Used to reject a state file whose paths point outside the fixture
// root it was read from.
function isPathRootedAt(candidate: string, rootDir: string): boolean {
  if (!path.isAbsolute(candidate)) return false;
  if (candidate === rootDir) return true;
  const relative = path.relative(rootDir, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

// The state file is untrusted input: any local process running as the same
// user can write one. A forged pid or an empty sshdConfigPath would weaken
// isSshEnvLabFixtureProcess's identity check — an empty string is a
// substring of every command line, so it would match any running process.
// Reject a state file that fails this check before any identity check or
// signal runs against it.
function isValidSshEnvLabFixtureState(
  raw: SshEnvLabFixtureState,
  expectedRootDir: string,
): boolean {
  if (!Number.isSafeInteger(raw.pid) || raw.pid <= 0) return false;
  if (raw.rootDir !== expectedRootDir) return false;

  for (const field of SSH_ENV_LAB_FIXTURE_PATH_FIELDS) {
    const value = raw[field];
    if (typeof value !== "string" || !isPathRootedAt(value, expectedRootDir)) {
      return false;
    }
  }

  const expectedSshdConfigPath = path.join(expectedRootDir, "sshd_config");
  if (raw.sshdConfigPath.length === 0 || raw.sshdConfigPath !== expectedSshdConfigPath) {
    return false;
  }

  return true;
}

export async function readSshEnvLabFixtureState(
  statePath: string,
): Promise<SshEnvLabFixtureState | null> {
  try {
    // Resolve a relative statePath against the current working directory
    // before use. The state validator below only accepts absolute paths, and
    // a relative statePath must resolve to the same absolute directory every
    // time a caller reads it, no matter the process working directory.
    const resolvedStatePath = path.resolve(statePath);
    const raw = JSON.parse(await fs.readFile(resolvedStatePath, "utf8")) as SshEnvLabFixtureState;
    if (!raw || raw.kind !== "ssh_openbsd") return null;
    if (!isValidSshEnvLabFixtureState(raw, path.dirname(resolvedStatePath))) return null;
    return raw;
  } catch {
    return null;
  }
}

async function waitUntilFixtureProcessExits(
  state: Pick<SshEnvLabFixtureState, "pid" | "sshdConfigPath">,
  timeoutMs: number,
  intervalMs = 100,
): Promise<boolean> {
  const timeoutAt = Date.now() + timeoutMs;
  while (true) {
    if (!(await isSshEnvLabFixtureProcess(state))) return true;
    if (Date.now() >= timeoutAt) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Sends a signal to a pid and treats an already-dead process as success.
// The identity check that runs before this call is not free: it spawns
// `ps`, which opens a real gap between the check and the signal. If the
// process exits inside that gap, `process.kill` throws ESRCH even though
// the outcome the caller wants (the process is gone) already holds. Any
// other error, such as EPERM for a pid that belongs to another user, must
// still propagate.
function signalFixtureProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

// Bounded shutdown escalation shared by every caller that must stop a
// fixture process: send SIGTERM, wait, re-check process identity (the pid
// can be reused in the gap between two signals), then SIGKILL, then wait
// again. Returns true only when the listener is confirmed gone.
async function escalateSshEnvLabFixtureShutdown(
  state: Pick<SshEnvLabFixtureState, "pid" | "sshdConfigPath">,
): Promise<boolean> {
  if (!(await isSshEnvLabFixtureProcess(state))) return true;

  if (!signalFixtureProcess(state.pid, "SIGTERM")) return true;
  if (await waitUntilFixtureProcessExits(state, 5_000)) return true;

  if (!(await isSshEnvLabFixtureProcess(state))) return true;
  if (!signalFixtureProcess(state.pid, "SIGKILL")) return true;
  if (await waitUntilFixtureProcessExits(state, 2_000)) return true;

  return !(await isSshEnvLabFixtureProcess(state));
}

// Accepts a state path or an already-read state so a caller that already
// holds the fixture state in memory does not have to depend on the state
// file, which a teardown step may have already removed.
export async function stopSshEnvLabFixture(
  stateOrPath: string | SshEnvLabFixtureState,
): Promise<boolean> {
  const state = typeof stateOrPath === "string"
    ? await readSshEnvLabFixtureState(stateOrPath)
    : stateOrPath;
  if (!state) return false;

  if (!(await escalateSshEnvLabFixtureShutdown(state))) {
    throw new Error(
      `SSH env-lab fixture did not stop: pid ${state.pid} on port ${state.port} is still running after SIGKILL.`,
    );
  }

  // Remove the root directory only after the listener process is confirmed
  // gone. Removing it earlier would delete the state file the process needs
  // for a later stop attempt to find and signal it.
  await fs.rm(state.rootDir, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

export async function startSshEnvLabFixture(input: {
  statePath: string;
  bindHost?: string;
  host?: string;
  // Test-only. Shortens the readiness wait below its 10 second default, so
  // a regression test can force the start-failure cleanup path without a
  // real 10 second wait.
  readinessTimeoutMs?: number;
}): Promise<SshEnvLabFixtureState> {
  // Resolve a relative statePath against the current working directory once,
  // up front. Every derived path (rootDir and the persisted statePath field)
  // must be absolute, so the state validator in readSshEnvLabFixtureState
  // accepts the file that this function writes.
  const statePath = path.resolve(input.statePath);
  const existing = await readSshEnvLabFixtureState(statePath);
  if (existing && await isSshEnvLabFixtureProcess(existing)) {
    return existing;
  }
  if (existing) {
    await fs.rm(existing.rootDir, { recursive: true, force: true }).catch(() => undefined);
  }

  const support = await getSshEnvLabSupport();
  if (!support.supported) {
    throw new Error(`SSH env-lab fixture is unavailable: ${support.reason}`);
  }
  const sshdPath = await resolveCommandPath("sshd");
  if (!sshdPath) {
    throw new Error("SSH env-lab fixture is unavailable: missing required command: sshd");
  }

  const bindHost = input.bindHost ?? "127.0.0.1";
  const host = input.host ?? bindHost;
  const rootDir = path.dirname(statePath);
  await fs.mkdir(rootDir, { recursive: true });

  const username = os.userInfo().username;
  const port = await allocateLoopbackPort(bindHost);
  const workspaceDir = path.join(rootDir, "workspace");
  const clientPrivateKeyPath = path.join(rootDir, "client_key");
  const clientPublicKeyPath = `${clientPrivateKeyPath}.pub`;
  const hostPrivateKeyPath = path.join(rootDir, "host_key");
  const hostPublicKeyPath = `${hostPrivateKeyPath}.pub`;
  const authorizedKeysPath = path.join(rootDir, "authorized_keys");
  const knownHostsPath = path.join(rootDir, "known_hosts");
  const sshdConfigPath = path.join(rootDir, "sshd_config");
  const sshdLogPath = path.join(rootDir, "sshd.log");
  const sshdPidPath = path.join(rootDir, "sshd.pid");

  await fs.mkdir(workspaceDir, { recursive: true });
  await execFileText("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", clientPrivateKeyPath], {
    timeout: 15_000,
  });
  await execFileText("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostPrivateKeyPath], {
    timeout: 15_000,
  });

  await fs.copyFile(clientPublicKeyPath, authorizedKeysPath);
  const hostPublicKey = (await execFileText("ssh-keygen", ["-y", "-f", hostPrivateKeyPath], {
    timeout: 15_000,
  })).stdout.trim();
  await fs.writeFile(
    knownHostsPath,
    `${buildKnownHostsEntry({ host, port, publicKey: hostPublicKey })}\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(
    sshdConfigPath,
    [
      `Port ${port}`,
      `ListenAddress ${bindHost}`,
      `HostKey ${hostPrivateKeyPath}`,
      `PidFile ${sshdPidPath}`,
      `AuthorizedKeysFile ${authorizedKeysPath}`,
      "PasswordAuthentication no",
      "ChallengeResponseAuthentication no",
      "KbdInteractiveAuthentication no",
      "PubkeyAuthentication yes",
      "PermitRootLogin no",
      "UsePAM no",
      "StrictModes no",
      `AllowUsers ${username}`,
      "LogLevel VERBOSE",
      "PrintMotd no",
      "UseDNS no",
      "Subsystem sftp internal-sftp",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const child = spawn(sshdPath, ["-D", "-f", sshdConfigPath, "-E", sshdLogPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const state: SshEnvLabFixtureState = {
    kind: "ssh_openbsd",
    bindHost,
    host,
    port,
    username,
    rootDir,
    workspaceDir,
    statePath,
    pid: child.pid ?? 0,
    createdAt: new Date().toISOString(),
    clientPrivateKeyPath,
    clientPublicKeyPath,
    hostPrivateKeyPath,
    hostPublicKeyPath,
    authorizedKeysPath,
    knownHostsPath,
    sshdConfigPath,
    sshdLogPath,
  };

  if (!state.pid) {
    throw new Error("Failed to start SSH env-lab fixture.");
  }

  try {
    await waitForCondition(async () => {
      if (!(await isPidRunning(state.pid))) {
        const logOutput = await fs.readFile(sshdLogPath, "utf8").catch(() => "");
        throw new Error(logOutput || "SSH env-lab fixture exited before becoming ready.");
      }
      const config = await buildSshEnvLabFixtureConfig(state);
      await ensureSshWorkspaceReady(config);
    }, { timeoutMs: input.readinessTimeoutMs ?? 10_000, intervalMs: 250 });
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    return state;
  } catch (error) {
    // No state file exists on this path yet, so a later stopSshEnvLabFixture
    // call can never find this pid. Escalate and wait for exit here, the
    // same way stopSshEnvLabFixture does, before the root directory goes
    // away — otherwise a slow-to-exit sshd survives as an orphan with its
    // root directory already gone.
    const stopped = await escalateSshEnvLabFixtureShutdown(state);
    if (stopped) {
      await fs.rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
    } else {
      const survivalNote =
        `SSH env-lab fixture pid ${state.pid} on port ${state.port} is still running after SIGKILL. ` +
        `Kept ${rootDir} for inspection; no state file exists to target it with a later stop call.`;
      if (error instanceof Error) {
        error.message = `${error.message}\n${survivalNote}`;
      } else {
        console.error(survivalNote);
      }
    }
    throw error;
  }
}

export async function buildSshEnvLabFixtureConfig(
  state: SshEnvLabFixtureState,
): Promise<SshConnectionConfig> {
  const [privateKey, knownHosts] = await Promise.all([
    fs.readFile(state.clientPrivateKeyPath, "utf8"),
    fs.readFile(state.knownHostsPath, "utf8"),
  ]);
  return {
    host: state.host,
    port: state.port,
    username: state.username,
    remoteWorkspacePath: state.workspaceDir,
    privateKey,
    knownHosts,
    strictHostKeyChecking: true,
  };
}

export async function readSshEnvLabFixtureStatus(statePath: string): Promise<{
  running: boolean;
  state: SshEnvLabFixtureState | null;
}> {
  const state = await readSshEnvLabFixtureState(statePath);
  if (!state) {
    return { running: false, state: null };
  }
  return {
    running: await isSshEnvLabFixtureProcess(state),
    state,
  };
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
