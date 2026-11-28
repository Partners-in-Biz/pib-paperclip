// PAR-15276 (G1 follow-up): the two lanes outside the PAR-15260 adapter list.
// Per lane a real child is spawned with every never-list key and a fake
// DATABASE_URL in the server env; the child holds none of them. The kill
// switch `off` restores today's full server env.
//   1. native runner (`paperclip_runner`): the env `executeNativeCodexRunner`
//      passes to `spawn`, built by `buildNativeRunnerChildEnv`.
//   2. server-side quota probes: `claude auth status` and the codex
//      app-server account read, run against fake CLIs on PATH.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_ENV_ALLOWLIST_FLAG, SERVER_SECRET_ENV_KEYS } from "@paperclipai/adapter-utils/server-utils";
import { readClaudeAuthStatus } from "@paperclipai/adapter-claude-local/server";
import { fetchCodexRpcQuota } from "@paperclipai/adapter-codex-local/server";
import { buildNativeRunnerChildEnv } from "../services/native-runtime/native-codex-runner.js";

const NEVER_KEYS = [...SERVER_SECRET_ENV_KEYS, "DATABASE_URL"];
const UNLISTED_SERVER_KEY = "PIB_WAKE_CAP_PER_AGENT_HOUR";

const saved = new Map<string, string | undefined>();
function setEnv(key: string, value: string | undefined) {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

let root = "";
let dumpPath = "";
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-child-env-lanes-"));
  dumpPath = path.join(root, "child-env.json");
  const bin = path.join(root, "bin");
  await fs.mkdir(bin, { recursive: true });
  // Fake CLIs: write their env, then answer like the real probe expects.
  const dump = `require("node:fs").writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify(process.env));`;
  await fs.writeFile(path.join(bin, "claude"),
    `#!${process.execPath}\n${dump}\nprocess.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }));\n`,
    { mode: 0o755 });
  await fs.writeFile(path.join(bin, "codex"),
    `#!${process.execPath}\n${dump}\n` +
    `let buf = "";\nprocess.stdin.on("data", c => { buf += c; let i; while ((i = buf.indexOf("\\n")) >= 0) {\n` +
    `  const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;\n` +
    `  const req = JSON.parse(line); if (req.id != null) process.stdout.write(JSON.stringify({ id: req.id, result: {} }) + "\\n"); } });\n`,
    { mode: 0o755 });
  setEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
  setEnv("HOME", path.join(root, "home"));
  setEnv("CODEX_HOME", path.join(root, "codex-home"));
  setEnv(AGENT_ENV_ALLOWLIST_FLAG, undefined);
  for (const key of SERVER_SECRET_ENV_KEYS) setEnv(key, `server-${key.toLowerCase()}`);
  setEnv("DATABASE_URL", "postgres://fake:fake@127.0.0.1:1/fake");
  setEnv(UNLISTED_SERVER_KEY, "5");
});

afterEach(async () => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
  await fs.rm(root, { recursive: true, force: true });
});

async function readDump(): Promise<Record<string, string>> {
  return JSON.parse(await fs.readFile(dumpPath, "utf8")) as Record<string, string>;
}

function spawnWithEnv(env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath,
      ["-e", `require("node:fs").writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify(process.env))`],
      { env, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", code => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))));
  });
}

function expectNoServerSecrets(env: Record<string, string>) {
  for (const key of NEVER_KEYS) expect(env, key).not.toHaveProperty(key);
  expect(env).not.toHaveProperty(UNLISTED_SERVER_KEY);
}

function expectFullServerEnv(env: Record<string, string>) {
  for (const key of NEVER_KEYS) expect(env[key], key).toBe(process.env[key]);
  expect(env[UNLISTED_SERVER_KEY]).toBe("5");
}

describe("native runner child env (paperclip_runner)", () => {
  const runEnvironment = () => ({
    PAPERCLIP_API_URL: "http://127.0.0.1:3100",
    PAPERCLIP_RUN_ID: "run-1",
    // A server-secret name in the resolved run env is dropped too.
    PAPERCLIP_AGENT_JWT_SECRET: "config-jwt",
  });

  it("gets allowlisted server env, the run env and the ticket; no server secret", async () => {
    setEnv("RUST_BACKTRACE", "1");
    await spawnWithEnv(buildNativeRunnerChildEnv({ environment: runEnvironment(), bootstrapTicket: "ticket-1" }));
    const env = await readDump();
    expectNoServerSecrets(env);
    expect(env.PAPERCLIP_RUNNER_BOOTSTRAP_TICKET).toBe("ticket-1");
    expect(env.PAPERCLIP_API_URL).toBe("http://127.0.0.1:3100");
    expect(env.PAPERCLIP_RUN_ID).toBe("run-1");
    // Host names the runner reads itself (PATH, HOME, CODEX_HOME).
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe(process.env.HOME);
    expect(env.CODEX_HOME).toBe(process.env.CODEX_HOME);
    expect(env.RUST_BACKTRACE).toBe("1");
  });

  it("executeNativeCodexRunner spawns with this env, never the raw server env", async () => {
    // The real spawn needs a built runnerd and Postgres (covered by
    // native-codex-runner.integration.test.ts); this guard fails when the
    // spawn goes back to `{ ...process.env, ... }`.
    const source = await fs.readFile(
      path.resolve(import.meta.dirname, "../services/native-runtime/native-codex-runner.ts"), "utf8");
    const spawnCall = source.slice(source.indexOf("const child = spawn(binary"));
    expect(spawnCall.slice(0, spawnCall.indexOf("});") + 3)).toMatch(/env: buildNativeRunnerChildEnv\(/);
    const code = source.split("\n").filter(line => !/^\s*(\*|\/\/|\/\*)/.test(line)).join("\n");
    expect(code).not.toMatch(/\.\.\.process\.env\b/);
  });

  it("the run env cannot replace the bootstrap ticket", async () => {
    const env = buildNativeRunnerChildEnv({
      environment: { PAPERCLIP_RUNNER_BOOTSTRAP_TICKET: "forged" },
      bootstrapTicket: "ticket-1",
    });
    expect(env.PAPERCLIP_RUNNER_BOOTSTRAP_TICKET).toBe("ticket-1");
  });

  it("kill switch off restores the full server env", async () => {
    setEnv(AGENT_ENV_ALLOWLIST_FLAG, "off");
    await spawnWithEnv(buildNativeRunnerChildEnv({ environment: runEnvironment(), bootstrapTicket: "ticket-1" }));
    const env = await readDump();
    for (const key of NEVER_KEYS.filter(key => key !== "PAPERCLIP_AGENT_JWT_SECRET")) {
      expect(env[key], key).toBe(process.env[key]);
    }
    expect(env[UNLISTED_SERVER_KEY]).toBe("5");
    expect(env.PAPERCLIP_AGENT_JWT_SECRET).toBe("config-jwt");
    expect(env.PAPERCLIP_RUNNER_BOOTSTRAP_TICKET).toBe("ticket-1");
  });
});

describe("server-side quota probes", () => {
  it("claude auth status child holds no server secret", async () => {
    const status = await readClaudeAuthStatus();
    expect(status).toEqual({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" });
    const env = await readDump();
    expectNoServerSecrets(env);
    expect(env.HOME).toBe(process.env.HOME);
  });

  it("claude auth status: kill switch off restores the full server env", async () => {
    setEnv(AGENT_ENV_ALLOWLIST_FLAG, "off");
    await readClaudeAuthStatus();
    expectFullServerEnv(await readDump());
  });

  it("codex app-server account read child holds no server secret", async () => {
    await fetchCodexRpcQuota().catch(() => null);
    const env = await readDump();
    expectNoServerSecrets(env);
    expect(env.CODEX_HOME).toBe(process.env.CODEX_HOME);
  });

  it("codex app-server: kill switch off restores the full server env", async () => {
    setEnv(AGENT_ENV_ALLOWLIST_FLAG, "off");
    await fetchCodexRpcQuota().catch(() => null);
    expectFullServerEnv(await readDump());
  });
});
