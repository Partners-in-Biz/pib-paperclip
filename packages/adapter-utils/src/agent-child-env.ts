/**
 * The environment an agent child process starts with (PAR-15260; gaps G1, G1b).
 *
 * The server's own `process.env` holds secrets that sign run tokens and tool
 * actions, open the database and decrypt company secrets. An agent shell that
 * can read them can mint a run token for any agent and any person, so none of
 * them may reach a child.
 *
 * A child env is built in three layers:
 * 1. inherited server env, only the names on the allowlist below (OS basics,
 *    the run keys the server sets on its own process, and the keys each
 *    adapter's provider CLI reads);
 * 2. the agent's resolved config env, minus every server-secret name;
 * 3. the run keys the adapter sets for this run.
 * A server-secret name is dropped from every layer.
 *
 * Rollback without a revert: server env `PAPERCLIP_AGENT_ENV_ALLOWLIST=off`
 * (restart needed) restores the full inherited env and the old config-env
 * filter. It reopens G1, so only an operator with the owner told turns it off.
 */

export const AGENT_ENV_ALLOWLIST_FLAG = "PAPERCLIP_AGENT_ENV_ALLOWLIST";

/** On unless the server env sets `PAPERCLIP_AGENT_ENV_ALLOWLIST=off`. */
export function isAgentEnvAllowlistOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[AGENT_ENV_ALLOWLIST_FLAG] ?? "").trim().toLowerCase() !== "off";
}

/**
 * Server-held secrets and server config that never reach an agent child,
 * whether inherited or set in a stored config env. Saving one of these in an
 * agent's config env is refused (422).
 */
export const SERVER_SECRET_ENV_KEYS: ReadonlySet<string> = new Set([
  // Run-token, tool-action and decision signing.
  "PAPERCLIP_AGENT_JWT_SECRET",
  "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET",
  "PAPERCLIP_DECISION_SIGNING_SECRET",
  "PAPERCLIP_WORKSPACE_HANDOFF_SECRET",
  // Secret store (exact names; every `PAPERCLIP_SECRETS_*` is also covered).
  "PAPERCLIP_SECRETS_MASTER_KEY",
  "PAPERCLIP_SECRETS_MASTER_KEY_FILE",
  "PAPERCLIP_SECRETS_PROVIDER",
  "PAPERCLIP_SECRETS_STRICT_MODE",
  "OP_SERVICE_ACCOUNT_TOKEN",
  // Instance config and the QA login.
  "PAPERCLIP_CONFIG",
  "PAPERCLIP_QA_USER",
  "PAPERCLIP_QA_USER_PASSWORD",
  // Database and auth.
  "DATABASE_URL",
  "DATABASE_MIGRATION_URL",
  "PAPERCLIP_BACKUP_WORKER_DATABASE_URL",
  "BETTER_AUTH_SECRET",
  // Cloud connector and backend tokens the server holds.
  "PAPERCLIP_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY",
  "PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY",
  "PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN",
  "PAPERCLIP_DEV_SERVER_STATUS_TOKEN",
  "PAPERCLIP_EPHEMERAL_MIGRATION_TOKEN",
  "PAPERCLIP_FEEDBACK_EXPORT_BACKEND_TOKEN",
  "PAPERCLIP_TELEMETRY_BACKEND_TOKEN",
  "PAPERCLIP_TOOL_OAUTH_CLIENT_SECRET",
]);

const SERVER_SECRET_ENV_KEY_PREFIXES = ["PAPERCLIP_SECRETS_", "PAPERCLIP_QA_USER"] as const;

export function isServerSecretEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return SERVER_SECRET_ENV_KEYS.has(normalized) ||
    SERVER_SECRET_ENV_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** OS and network basics a child needs to find programs, homes and certs. */
const AGENT_INHERITED_OS_ENV_KEYS: ReadonlySet<string> = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  "USER", "USERNAME", "LOGNAME", "SHELL",
  "LANG", "LANGUAGE", "TZ", "TERM", "COLORTERM",
  "TMPDIR", "TEMP", "TMP",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "SSH_AUTH_SOCK",
]);

/**
 * Run keys the server sets on its own process at boot (`server/src/index.ts`)
 * and a child reads to reach the API. Every other run key is set per run by
 * the adapter or delivered through the resolved config env.
 */
const AGENT_INHERITED_RUN_ENV_KEYS: ReadonlySet<string> = new Set([
  "PAPERCLIP_API_URL",
  "PAPERCLIP_RUNTIME_API_URL",
  "PAPERCLIP_RUNTIME_API_CANDIDATES_JSON",
  "PAPERCLIP_LISTEN_HOST",
  "PAPERCLIP_LISTEN_PORT",
  "PAPERCLIP_INSTANCE_ID",
  "PAPERCLIP_HOME",
]);

export type AgentInheritedEnvAllowance = {
  readonly keys?: readonly string[];
  readonly prefixes?: readonly string[];
};

/**
 * Server env each adapter's provider CLI reads, by adapter type. The union is
 * applied to every local child: one run can start another provider's CLI
 * (Hermes can call Claude Code), and `runChildProcess` cannot tell which
 * adapter called it. A key that is not here and not in the run's config env
 * does not reach the child.
 */
export const AGENT_ADAPTER_INHERITED_ENV: Readonly<Record<string, AgentInheritedEnvAllowance>> = {
  claude_local: {
    prefixes: ["ANTHROPIC_", "CLAUDE_"],
    keys: [
      "AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
      "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_PROFILE", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE",
    ],
  },
  codex_local: { prefixes: ["OPENAI_", "CODEX_"] },
  cursor: { prefixes: ["CURSOR_"] },
  gemini_local: {
    prefixes: ["GEMINI_", "GOOGLE_GENAI_"],
    keys: ["GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"],
  },
  grok_local: { prefixes: ["XAI_", "GROK_"] },
  hermes_local: { prefixes: ["HERMES_"], keys: ["OPENROUTER_API_KEY"] },
  kimi_local: { prefixes: ["KIMI_", "MOONSHOT_"] },
  opencode_local: { prefixes: ["OPENCODE_"], keys: ["OPENROUTER_API_KEY"] },
  pi_local: { keys: ["OPENROUTER_API_KEY"] },
};

const ADAPTER_INHERITED_KEYS = new Set(
  Object.values(AGENT_ADAPTER_INHERITED_ENV).flatMap((entry) => entry.keys ?? []),
);
const ADAPTER_INHERITED_PREFIXES = [
  ...new Set(Object.values(AGENT_ADAPTER_INHERITED_ENV).flatMap((entry) => entry.prefixes ?? [])),
];

export function isAgentInheritedEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();
  if (isServerSecretEnvKey(normalized)) return false;
  return AGENT_INHERITED_OS_ENV_KEYS.has(normalized) ||
    /^LC_[A-Z0-9_]{1,32}$/.test(normalized) ||
    AGENT_INHERITED_RUN_ENV_KEYS.has(normalized) ||
    ADAPTER_INHERITED_KEYS.has(normalized) ||
    ADAPTER_INHERITED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** The allowlisted part of `inherited`, whatever the kill switch says. */
export function projectAgentInheritedEnv(inherited: NodeJS.ProcessEnv): Record<string, string> {
  const projected: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (typeof value === "string" && isAgentInheritedEnvKey(key)) projected[key] = value;
  }
  return projected;
}

/**
 * The server env a local child may inherit: the allowlist, or (kill switch
 * `off`) a copy of the whole env as before.
 */
export function agentInheritedEnv(inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return isAgentEnvAllowlistOn() ? projectAgentInheritedEnv(inherited) : { ...inherited };
}

/**
 * `env` without server-secret names. Kill switch `off`: the same object,
 * untouched.
 */
export function withoutServerSecretEnv<T extends Record<string, string | undefined>>(env: T): T {
  if (!isAgentEnvAllowlistOn()) return env;
  let copy: T | null = null;
  for (const key of Object.keys(env)) {
    if (!isServerSecretEnvKey(key)) continue;
    copy ??= { ...env };
    delete copy[key];
  }
  return copy ?? env;
}

/** Names in a stored config env that may not be saved (sorted, names only). */
export function listServerSecretEnvKeys(env: Record<string, unknown> | null | undefined): string[] {
  if (!env || !isAgentEnvAllowlistOn()) return [];
  return Object.keys(env).filter(isServerSecretEnvKey).sort();
}

/**
 * Build a local agent child's env: allowlisted inherited env (none when the
 * run is remote), then the config env without server secrets, then the run
 * keys. Kill switch `off`: `{ ...inherited, ...configEnv, ...runEnv }`.
 */
export function buildAgentChildEnv(input: {
  inherited?: NodeJS.ProcessEnv;
  configEnv?: Record<string, unknown> | null;
  runEnv?: Record<string, string>;
  remote?: boolean;
}): Record<string, string> {
  const inherited = input.remote ? {} : (input.inherited ?? process.env);
  if (!isAgentEnvAllowlistOn()) {
    return {
      ...(inherited as Record<string, string>),
      ...((input.configEnv ?? {}) as Record<string, string>),
      ...(input.runEnv ?? {}),
    };
  }
  const configEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.configEnv ?? {})) {
    if (typeof value === "string" && !isServerSecretEnvKey(key)) configEnv[key] = value;
  }
  return {
    ...projectAgentInheritedEnv(inherited),
    ...configEnv,
    ...(input.runEnv ?? {}),
  };
}
