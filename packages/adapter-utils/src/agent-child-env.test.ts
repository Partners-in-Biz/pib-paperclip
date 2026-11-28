import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_ENV_ALLOWLIST_FLAG,
  SERVER_SECRET_ENV_KEYS,
  buildAgentChildEnv,
  isServerSecretEnvKey,
  listServerSecretEnvKeys,
  projectAgentInheritedEnv,
  withoutServerSecretEnv,
} from "./agent-child-env.js";
import { runChildProcess, sanitizeInheritedPaperclipEnv } from "./server-utils.js";
import { finalizeLaunchEnvironment } from "./acpx-engine/execute.js";
// acpx bundles its client in a hashed chunk; the import pins the patched build.
// @ts-expect-error -- untyped dist chunk
import { k as AcpClient } from "acpx/dist/live-checkpoint-ClPCSdrW.js";

// Every never-list key, plus server keys on no list at all.
const NEVER_KEYS = [...SERVER_SECRET_ENV_KEYS, "PAPERCLIP_SECRETS_AWS_KMS_KEY_ID"];
const UNLISTED_SERVER_KEYS = ["PIB_WAKE_CAP_PER_AGENT_HOUR", "PAPERCLIP_SPEND_ALARM_MAX_RUNS_PER_HOUR", "DATABASE_POOL_MAX"];
const ADAPTER_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "HERMES_HOME", "GEMINI_API_KEY"];
const RUN_ENV = { PAPERCLIP_RUN_ID: "run-1", PAPERCLIP_AGENT_ID: "agent-1", PAPERCLIP_API_KEY: "run-token" };

const saved = new Map<string, string | undefined>();
function setServerEnv(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    process.env[key] = value;
  }
}

beforeEach(() => {
  setServerEnv(Object.fromEntries([
    ...NEVER_KEYS.map((key) => [key, `fake-${key.toLowerCase()}`]),
    ...UNLISTED_SERVER_KEYS.map((key) => [key, "1"]),
    ...ADAPTER_KEYS.map((key) => [key, `adapter-${key.toLowerCase()}`]),
    ["DATABASE_URL", "postgres://fake:fake@127.0.0.1:1/fake"],
    ["PAPERCLIP_API_URL", "http://127.0.0.1:3100"],
  ]));
  saved.set(AGENT_ENV_ALLOWLIST_FLAG, process.env[AGENT_ENV_ALLOWLIST_FLAG]);
  delete process.env[AGENT_ENV_ALLOWLIST_FLAG];
});

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

const configEnvWithSecrets = () => ({
  ...Object.fromEntries(NEVER_KEYS.map((key) => [key, "from-config"])),
  DATABASE_URL: "postgres://config",
  CRM_MARIADB_URL: "mysql://config",
});

async function spawnAndListEnv(env: Record<string, string>): Promise<string[]> {
  const result = await runChildProcess("agent-child-env-test", process.execPath, [
    "-e",
    "process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))",
  ], { cwd: process.cwd(), env, timeoutSec: 20, graceSec: 1, onLog: async () => {} });
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout) as string[];
}

describe("server-secret names", () => {
  it("covers the never-list, the secret-store prefix and the QA login, case-insensitively", () => {
    for (const key of [...NEVER_KEYS, "PAPERCLIP_QA_USER_EMAIL", "database_url"]) {
      expect(isServerSecretEnvKey(key)).toBe(true);
    }
    for (const key of ["CRM_MARIADB_URL", "PAPERCLIP_RUN_ID", "PAPERCLIP_GIT_TOKEN", "GITHUB_TOKEN"]) {
      expect(isServerSecretEnvKey(key)).toBe(false);
    }
  });

  it("lists stored names to refuse, and none when the switch is off", () => {
    expect(listServerSecretEnvKeys({ DATABASE_URL: "x", OK: "y", PAPERCLIP_AGENT_JWT_SECRET: "z" }))
      .toEqual(["DATABASE_URL", "PAPERCLIP_AGENT_JWT_SECRET"]);
    process.env[AGENT_ENV_ALLOWLIST_FLAG] = "off";
    expect(listServerSecretEnvKeys({ DATABASE_URL: "x" })).toEqual([]);
  });
});

describe("buildAgentChildEnv", () => {
  it("inherits only allowlisted names, drops server secrets from config, keeps run keys last", () => {
    const env = buildAgentChildEnv({ configEnv: configEnvWithSecrets(), runEnv: RUN_ENV });
    for (const key of [...NEVER_KEYS, "DATABASE_URL", ...UNLISTED_SERVER_KEYS]) expect(env).not.toHaveProperty(key);
    for (const key of [...ADAPTER_KEYS, "PATH", "PAPERCLIP_API_URL", "CRM_MARIADB_URL"]) expect(env).toHaveProperty(key);
    expect(env).toMatchObject(RUN_ENV);
  });

  it("inherits nothing for a remote run", () => {
    const env = buildAgentChildEnv({ remote: true, configEnv: { A: "1" }, runEnv: RUN_ENV });
    expect(env).toEqual({ A: "1", ...RUN_ENV });
  });

  it("switch off: today's spread, byte for byte", () => {
    process.env[AGENT_ENV_ALLOWLIST_FLAG] = "off";
    const configEnv = configEnvWithSecrets();
    const env = buildAgentChildEnv({ configEnv, runEnv: RUN_ENV });
    expect(JSON.stringify(env)).toBe(JSON.stringify({ ...process.env, ...configEnv, ...RUN_ENV }));
    expect(withoutServerSecretEnv(configEnv)).toBe(configEnv);
  });

  it("projection never lets a server secret through even under an adapter prefix", () => {
    expect(projectAgentInheritedEnv({ CLAUDE_X: "1", PAPERCLIP_SECRETS_PROVIDER: "local", PATH: "/bin" }))
      .toEqual({ CLAUDE_X: "1", PATH: "/bin" });
  });
});

describe("runChildProcess child env (every local adapter and process)", () => {
  it("child holds no never-list or unlisted server key from the parent or the config env", async () => {
    const keys = await spawnAndListEnv({ ...configEnvWithSecrets(), ...RUN_ENV });
    for (const key of [...NEVER_KEYS, "DATABASE_URL", ...UNLISTED_SERVER_KEYS]) expect(keys).not.toContain(key);
    for (const key of [...Object.keys(RUN_ENV), ...ADAPTER_KEYS, "PATH", "CRM_MARIADB_URL"]) expect(keys).toContain(key);
  });

  it("switch off: the child gets today's env (sanitized parent + explicit env)", async () => {
    process.env[AGENT_ENV_ALLOWLIST_FLAG] = "off";
    const explicit = { ...configEnvWithSecrets(), ...RUN_ENV };
    const keys = await spawnAndListEnv(explicit);
    const expected = Object.keys({ ...sanitizeInheritedPaperclipEnv(process.env), ...explicit })
      .filter((key) => !["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION", "CLAUDE_CODE_PARENT_SESSION"].includes(key));
    // The child itself may add a few runtime names (for example `_` from a shell); compare the parent-defined set.
    expect(keys.filter((key) => expected.includes(key)).sort()).toEqual([...new Set(expected)].sort());
    expect(keys).toContain("DATABASE_URL");
  });
});

describe("ACPX launch env and client terminals", () => {
  it("drops server secrets that arrive through the explicit (config) env", () => {
    const { env } = finalizeLaunchEnvironment({ ...configEnvWithSecrets(), ...RUN_ENV }, [], {
      acpxAgent: "claude",
      inheritHostEnvironment: true,
    }) as unknown as { env: Record<string, string> };
    for (const key of [...NEVER_KEYS, "DATABASE_URL", ...UNLISTED_SERVER_KEYS]) expect(env).not.toHaveProperty(key);
    expect(env).toMatchObject({ ...RUN_ENV, ANTHROPIC_API_KEY: "adapter-anthropic_api_key", CRM_MARIADB_URL: "mysql://config" });
  });

  async function terminalEnvKeys(inheritProcessEnv: boolean | undefined): Promise<string[]> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-terminal-env-"));
    const out = path.join(dir, "keys.json");
    const client = new AcpClient({
      agentCommand: "unused",
      cwd: dir,
      permissionMode: "approve-all",
      inheritProcessEnv,
      sessionOptions: { env: { PATH: process.env.PATH ?? "", ...RUN_ENV } },
    });
    await client.handleCreateTerminal({
      sessionId: "s1",
      command: process.execPath,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(Object.keys(process.env)))`],
      cwd: dir,
    });
    for (let i = 0; i < 200; i += 1) {
      const text = await fs.readFile(out, "utf8").catch(() => "");
      if (text) {
        await fs.rm(dir, { recursive: true, force: true });
        return JSON.parse(text) as string[];
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("terminal child did not write its env");
  }

  it("a terminal the agent opens gets the launch env, not the server env", async () => {
    const keys = await terminalEnvKeys(false);
    for (const key of [...NEVER_KEYS, "DATABASE_URL", ...UNLISTED_SERVER_KEYS]) expect(keys).not.toContain(key);
    for (const key of Object.keys(RUN_ENV)) expect(keys).toContain(key);
  });

  it("acpx default (inherit on) is unchanged: the terminal inherits the server env", async () => {
    const keys = await terminalEnvKeys(undefined);
    expect(keys).toContain("DATABASE_URL");
  });
});
