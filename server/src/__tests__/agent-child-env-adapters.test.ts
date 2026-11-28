// PAR-15260 (G1, G1b): per adapter, the real `execute` spawns a fake CLI with
// every never-list key and a fake DATABASE_URL in the server env and in the
// stored config env. The child holds none of them, and still holds the run
// keys and the adapter's own keys. Kill switch `off` restores today's env.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_ENV_ALLOWLIST_FLAG, SERVER_SECRET_ENV_KEYS } from "@paperclipai/adapter-utils/server-utils";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { execute as claudeExecute, testEnvironment as claudeTest } from "@paperclipai/adapter-claude-local/server";
import { execute as codexExecute, testEnvironment as codexTest } from "@paperclipai/adapter-codex-local/server";
import { execute as cursorExecute, testEnvironment as cursorTest } from "@paperclipai/adapter-cursor-local/server";
import { execute as geminiExecute, testEnvironment as geminiTest } from "@paperclipai/adapter-gemini-local/server";
import { execute as grokExecute, testEnvironment as grokTest } from "@paperclipai/adapter-grok-local/server";
import { execute as kimiExecute, testEnvironment as kimiTest } from "@paperclipai/adapter-kimi-local/server";
import { execute as opencodeExecute, testEnvironment as opencodeTest } from "@paperclipai/adapter-opencode-local/server";
import { execute as piExecute, testEnvironment as piTest } from "@paperclipai/adapter-pi-local/server";
import { execute as hermesExecute, testEnvironment as hermesTest } from "@paperclipai/hermes-paperclip-adapter/server";
import { execute as processExecute } from "../adapters/process/execute.js";
import { testEnvironment as processTest } from "../adapters/process/test.js";

type Execute = (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;

const NEVER_KEYS = [...SERVER_SECRET_ENV_KEYS, "PAPERCLIP_SECRETS_AWS_KMS_KEY_ID"];
const UNLISTED_SERVER_KEY = "PIB_WAKE_CAP_PER_AGENT_HOUR";

const ADAPTERS: Array<{ type: string; execute: Execute; adapterKey: string; commandKey?: string }> = [
  { type: "claude_local", execute: claudeExecute, adapterKey: "ANTHROPIC_BASE_URL" },
  { type: "codex_local", execute: codexExecute, adapterKey: "OPENAI_BASE_URL" },
  { type: "cursor", execute: cursorExecute, adapterKey: "CURSOR_TEST_FLAG" },
  { type: "gemini_local", execute: geminiExecute, adapterKey: "GEMINI_TEST_FLAG" },
  { type: "grok_local", execute: grokExecute, adapterKey: "GROK_TEST_FLAG" },
  { type: "kimi_local", execute: kimiExecute, adapterKey: "KIMI_TEST_FLAG" },
  { type: "opencode_local", execute: opencodeExecute, adapterKey: "OPENCODE_TEST_FLAG" },
  { type: "pi_local", execute: piExecute, adapterKey: "OPENROUTER_API_KEY" },
  { type: "hermes_local", execute: hermesExecute, adapterKey: "HERMES_TEST_FLAG", commandKey: "hermesCommand" },
  { type: "process", execute: processExecute as unknown as Execute, adapterKey: "PATH" },
];

const saved = new Map<string, string | undefined>();
function setEnv(key: string, value: string | undefined) {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

let root = "";
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-child-env-"));
  // Keep every adapter's home and instance writes inside the temp dir.
  setEnv("HOME", path.join(root, "home"));
  setEnv("PAPERCLIP_HOME", path.join(root, "paperclip-home"));
  setEnv("PAPERCLIP_INSTANCE_ID", "agent-child-env-test");
  setEnv(AGENT_ENV_ALLOWLIST_FLAG, undefined);
  for (const key of NEVER_KEYS) setEnv(key, `server-${key.toLowerCase()}`);
  setEnv("DATABASE_URL", "postgres://fake:fake@127.0.0.1:1/fake");
  setEnv(UNLISTED_SERVER_KEY, "5");
  for (const adapter of ADAPTERS) if (adapter.adapterKey !== "PATH") setEnv(adapter.adapterKey, "adapter-value");
  await fs.mkdir(path.join(root, "home"), { recursive: true });
});

afterEach(async () => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
  await fs.rm(root, { recursive: true, force: true });
});

async function writeFakeCli(file: string) {
  // Records every invocation; answers pi's model listing with the test model.
  await fs.writeFile(file, `#!/usr/bin/env node
const fs = require("node:fs");
const out = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
if (out) fs.appendFileSync(out, JSON.stringify({ argv: process.argv.slice(2), keys: Object.keys(process.env) }) + "\\n");
if (process.argv.includes("--list-models")) console.log("provider  model\\nopenrouter  test-model");
`, "utf8");
  await fs.chmod(file, 0o755);
}

async function runAdapter(adapter: (typeof ADAPTERS)[number]) {
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  const cli = path.join(root, "fake-cli");
  const capture = path.join(root, "capture.jsonl");
  await writeFakeCli(cli);
  const configEnv = {
    ...Object.fromEntries(NEVER_KEYS.map((key) => [key, "config-value"])),
    DATABASE_URL: "postgres://config",
    CRM_MARIADB_URL: "mysql://config",
    PAPERCLIP_TEST_CAPTURE_PATH: capture,
  };
  const config: Record<string, unknown> = {
    engine: "cli",
    command: cli,
    ...(adapter.commandKey ? { [adapter.commandKey]: cli } : {}),
    cwd: workspace,
    env: configEnv,
    timeoutSec: 20,
    graceSec: 1,
    promptTemplate: "Say ok.",
    model: adapter.type === "opencode_local" ? "openai/gpt-5" : adapter.type === "pi_local" ? "openrouter/test-model" : undefined,
  };
  await adapter.execute({
    runId: `run-${adapter.type}`,
    agent: { id: "agent-1", companyId: "company-1", name: "Env test", adapterType: adapter.type, adapterConfig: config },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config,
    context: {},
    authToken: "run-jwt-token",
    onLog: async () => {},
  } as unknown as AdapterExecutionContext).catch(() => undefined);
  const text = await fs.readFile(capture, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { argv: string[]; keys: string[] });
}

describe.each(ADAPTERS)("$type child env", (adapter) => {
  it("holds no server secret or unlisted server key, keeps run and adapter keys", async () => {
    const invocations = await runAdapter(adapter);
    expect(invocations.length).toBeGreaterThan(0);
    for (const { keys } of invocations) {
      for (const key of [...NEVER_KEYS, "DATABASE_URL", UNLISTED_SERVER_KEY]) expect(keys).not.toContain(key);
      for (const key of ["PAPERCLIP_RUN_ID", "PAPERCLIP_AGENT_ID", "PAPERCLIP_API_KEY", "CRM_MARIADB_URL", adapter.adapterKey]) {
        expect(keys).toContain(key);
      }
    }
  }, 60_000);

  it("switch off restores today's env (server keys reach the child again)", async () => {
    setEnv(AGENT_ENV_ALLOWLIST_FLAG, "off");
    const invocations = await runAdapter(adapter);
    expect(invocations.length).toBeGreaterThan(0);
    const keys = invocations[invocations.length - 1]!.keys;
    expect(keys).toContain("DATABASE_URL");
    expect(keys).toContain("BETTER_AUTH_SECRET");
    expect(keys).toContain(UNLISTED_SERVER_KEY);
  }, 60_000);
});

// The Test-environment route (`POST /companies/:id/adapters/:type/test-environment`)
// runs a request-supplied `command` before any agent exists. Every adapter's
// probe must give that command the same filtered env as a run.
type EnvTest = (ctx: AdapterEnvironmentTestContext) => Promise<AdapterEnvironmentTestResult>;
const ENV_TESTS: Array<{ type: string; test: EnvTest; commandKey?: string; mustSpawn?: boolean; extra?: Record<string, unknown> }> = [
  { type: "claude_local", test: claudeTest },
  { type: "codex_local", test: codexTest },
  { type: "cursor", test: cursorTest },
  { type: "gemini_local", test: geminiTest },
  { type: "grok_local", test: grokTest },
  { type: "kimi_local", test: kimiTest },
  { type: "opencode_local", test: opencodeTest, extra: { model: "openai/gpt-5" } },
  { type: "pi_local", test: piTest, extra: { model: "openrouter/test-model" } },
  { type: "hermes_local", test: hermesTest, commandKey: "hermesCommand", mustSpawn: true },
  { type: "hermes_local (connection probe)", test: hermesTest, commandKey: "hermesCommand", mustSpawn: true, extra: { managedAiRouting: { mode: "test" } } },
  { type: "process", test: processTest as unknown as EnvTest },
];

async function runEnvTest(entry: (typeof ENV_TESTS)[number]) {
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  const cli = path.join(root, "fake-cli");
  const capture = path.join(root, "capture-env-test.jsonl");
  // Fixed capture path: a probe may pass no config env at all.
  await fs.writeFile(cli, `#!/usr/bin/env node
require("node:fs").appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ keys: Object.keys(process.env) }) + "\\n");
if (process.argv.includes("--list-models")) console.log("provider  model\\nopenrouter  test-model");
console.log("hello");
`, "utf8");
  await fs.chmod(cli, 0o755);
  const config: Record<string, unknown> = {
    command: cli,
    ...(entry.commandKey ? { [entry.commandKey]: cli } : {}),
    cwd: workspace,
    env: { ...Object.fromEntries(NEVER_KEYS.map((key) => [key, "config-value"])), DATABASE_URL: "postgres://config" },
    ...entry.extra,
  };
  await entry.test({ companyId: "company-1", adapterType: entry.type.split(" ")[0]!, config } as AdapterEnvironmentTestContext)
    .catch(() => undefined);
  const text = await fs.readFile(capture, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { keys: string[] }).keys);
}

describe.each(ENV_TESTS)("$type test-environment probe", (entry) => {
  it("gives the configured command no server secret", async () => {
    const invocations = await runEnvTest(entry);
    if (entry.mustSpawn) expect(invocations.length).toBeGreaterThan(0);
    for (const keys of invocations) {
      for (const key of [...NEVER_KEYS, "DATABASE_URL", UNLISTED_SERVER_KEY]) expect(keys).not.toContain(key);
      expect(keys).toContain("PATH");
    }
  }, 60_000);

  if (entry.mustSpawn) {
    it("switch off restores today's env", async () => {
      setEnv(AGENT_ENV_ALLOWLIST_FLAG, "off");
      const invocations = await runEnvTest(entry);
      expect(invocations.length).toBeGreaterThan(0);
      expect(invocations.some((keys) => keys.includes("PAPERCLIP_AGENT_JWT_SECRET") && keys.includes(UNLISTED_SERVER_KEY))).toBe(true);
    }, 60_000);
  }
});
