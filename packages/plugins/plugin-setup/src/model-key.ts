/**
 * The company's own model key (PAR-5158). A `claude_local` agent uses PiB's
 * subscription login unless its adapter config carries an env secret reference
 * for ANTHROPIC_API_KEY. Pure helpers: the Model key step reads the secret
 * catalog and the agents, and these decide what to bind. No secret value is
 * ever read, only the id of the company secret.
 */

export const MODEL_KEY_ENV = "ANTHROPIC_API_KEY";
/** The exact name the owner is told to give the secret. */
export const MODEL_KEY_SECRET_NAME = "ANTHROPIC_API_KEY";
export type HostingProfile = "client" | "pib";

export interface SecretLite {
  id: string;
  name: string;
  key: string;
  status: string | null;
}

export interface AgentLite {
  id: string;
  name: string;
  adapterType: string;
  status: string | null;
  /** Null when the list did not return the config (never overwrite what was not read). */
  adapterConfig: Record<string, unknown> | null;
}

export interface EnvRef {
  type: "secret_ref";
  secretId: string;
  version: "latest";
}

const norm = (value: string) => value.trim().toLowerCase().replace(/[-\s]+/g, "_");
const WANTED = new Set([norm(MODEL_KEY_SECRET_NAME), "anthropic_api_key"]);

const rec = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** Every usable company secret named `ANTHROPIC_API_KEY` or `anthropic-api-key` (by name or key), in list order. */
export function keySecretMatches(catalog: SecretLite[]): SecretLite[] {
  return catalog.filter((secret) => (secret.status === null || secret.status === "active") && (WANTED.has(norm(secret.key)) || WANTED.has(norm(secret.name))));
}

/** The first match. Two matches are reported by the step, not guessed between silently. */
export function findKeySecret(catalog: SecretLite[]): SecretLite | null {
  return keySecretMatches(catalog)[0] ?? null;
}

export function parseSecretCatalog(body: unknown): SecretLite[] | null {
  const list = Array.isArray(body) ? body : Array.isArray(rec(body).data) ? (rec(body).data as unknown[]) : null;
  if (!list) return null;
  const out: SecretLite[] = [];
  for (const raw of list) {
    const row = rec(raw);
    if (typeof row.id !== "string") continue;
    out.push({ id: row.id, name: typeof row.name === "string" ? row.name : "", key: typeof row.key === "string" ? row.key : "", status: typeof row.status === "string" ? row.status : null });
  }
  return out;
}

export function parseAgents(raw: unknown[]): AgentLite[] {
  const out: AgentLite[] = [];
  for (const entry of raw) {
    const row = rec(entry);
    if (typeof row.id !== "string") continue;
    const config = row.adapterConfig && typeof row.adapterConfig === "object" && !Array.isArray(row.adapterConfig) ? (row.adapterConfig as Record<string, unknown>) : null;
    out.push({ id: row.id, name: typeof row.name === "string" ? row.name : row.id, adapterType: typeof row.adapterType === "string" ? row.adapterType : "", status: typeof row.status === "string" ? row.status : null, adapterConfig: config });
  }
  return out;
}

export const envRef = (secretId: string): EnvRef => ({ type: "secret_ref", secretId, version: "latest" });

/** Whether the agent's config already binds the key to this secret. */
export function isBound(config: Record<string, unknown> | null, secretId: string): boolean {
  const binding = rec(rec(config?.env)[MODEL_KEY_ENV]);
  return binding.type === "secret_ref" && binding.secretId === secretId;
}

/** Whether the agent has any ANTHROPIC_API_KEY entry at all (a plain value is replaced, never kept). */
export function hasKeyEntry(config: Record<string, unknown> | null): boolean {
  return rec(config?.env)[MODEL_KEY_ENV] !== undefined;
}

/**
 * The `env` to send: the agent's env as read plus the key reference. The host
 * merges `adapterConfig` shallowly (every other key stays as stored) but replaces
 * `env` as a whole and restores redacted plain env values from what it stored.
 * Nothing but `env` is ever sent, because the read view redacts other keys.
 */
export function withKeyEnv(config: Record<string, unknown>, secretId: string): Record<string, unknown> {
  return { ...rec(config.env), [MODEL_KEY_ENV]: envRef(secretId) };
}

/** A caller without config access gets `{}`, not null: an empty view is "not read", never "no settings". */
export function isReadableConfig(config: Record<string, unknown> | null): config is Record<string, unknown> {
  return !!config && Object.keys(config).length > 0;
}

/** The agents this step binds: `claude_local`, not terminated. */
export function claudeAgents(agents: AgentLite[]): AgentLite[] {
  return agents.filter((agent) => agent.adapterType === "claude_local" && agent.status !== "terminated");
}

export function ownerSecretSteps(): string[] {
  return [`Open the company's Secrets page and add a secret named ${MODEL_KEY_SECRET_NAME} with the client's Anthropic API key.`, "Run the Model key step again. It binds the key to every Claude agent of the company."];
}
