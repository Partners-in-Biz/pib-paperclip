/**
 * The company's own model key (PAR-5158). Setup's Model key step saves three
 * settings in every plugin: `hostingProfile` (`client` or `pib`), and the
 * company secret's `modelKeySecretName` and `modelKeySecretId`. A `client`
 * company never runs an agent on PiB's subscription, so a hire without the key
 * is refused, and the hire task asks for the binding. A plugin cannot change an
 * agent after the hire, so a linked agent without the binding is a warning.
 */
import type { HealthCheck } from "./cockpit.js";

export const MODEL_KEY_ENV = "ANTHROPIC_API_KEY";

/** Present in every hire task that already carries the key section. */
export const MODEL_KEY_MARKER = "## Model key (client company)";

export interface Hosting {
  profile: "client" | "pib";
  secretName: string;
  secretId: string;
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** The hosting settings from a plugin's company config. Anything but an explicit `client` is `pib` (today's behaviour). */
export function hostingFromConfig(config: Record<string, unknown> | null | undefined): Hosting {
  const row = config ?? {};
  return { profile: row.hostingProfile === "client" ? "client" : "pib", secretName: text(row.modelKeySecretName), secretId: text(row.modelKeySecretId) };
}

/** A client company uses `claude_local` with its own key; the others keep the role's order. */
export function adapterPreferenceFor(preference: string[], hosting: Hosting | undefined): string[] {
  return hosting?.profile === "client" ? ["claude_local"] : preference;
}

/** Why a hire is refused, or null when it may go ahead. */
export function hireRefusal(hosting: Hosting): string | null {
  if (hosting.profile !== "client" || hosting.secretId) return null;
  return `This is a client company, so its agents run on the client's own Anthropic key, never on PiB's subscription. The company has no secret named ${MODEL_KEY_ENV} yet. Add the secret (Company > Secrets), then run Setup > New company > Model key, and hire again.`;
}

/** The hire task section that makes the new agent carry the key from its first run. */
export function modelKeyHireText(hosting: Hosting): string {
  return [
    "## Model key (client company)",
    "",
    `This company pays for its own model use. **Create the agent with the company key**: use \`claude_local\` and put this in the agent's adapter config. Do not leave the agent on the PiB subscription login.`,
    "",
    "```json",
    JSON.stringify({ env: { [MODEL_KEY_ENV]: { type: "secret_ref", secretId: hosting.secretId, version: "latest" } } }, null, 2),
    "```",
    "",
    "The key is the company secret " + (hosting.secretName || MODEL_KEY_ENV) + ". Setup > New company > Model key binds it again if an agent is missing it.",
  ].join("\n");
}

export interface KeyAgentLike {
  id: string;
  name: string;
  status?: string | null;
  adapterType?: string | null;
  adapterConfig?: Record<string, unknown> | null;
}

const GONE = new Set(["terminated", "archived"]);

/** `claude_local` agents of a client company with no key reference bound to the company secret. */
export function unboundKeyAgents(agents: KeyAgentLike[], hosting: Hosting): KeyAgentLike[] {
  if (hosting.profile !== "client") return [];
  return agents.filter((agent) => {
    if (agent.adapterType !== "claude_local" || GONE.has(String(agent.status ?? ""))) return false;
    const env = (agent.adapterConfig?.env ?? {}) as Record<string, unknown>;
    const binding = (env[MODEL_KEY_ENV] ?? {}) as Record<string, unknown>;
    return !(binding.type === "secret_ref" && (!hosting.secretId || binding.secretId === hosting.secretId));
  });
}

export function unboundModelKeyCheck(agents: KeyAgentLike[], hosting: Hosting): HealthCheck | null {
  const flagged = unboundKeyAgents(agents, hosting);
  if (flagged.length === 0) return null;
  const names = flagged.slice(0, 8).map((agent) => agent.name).join(", ");
  return {
    key: "agents:model-key",
    title: "Agents not on the company's own model key",
    status: "bad",
    detail: `${flagged.length} Claude agent${flagged.length === 1 ? "" : "s"} of this client company ${flagged.length === 1 ? "is" : "are"} not bound to the company key, so ${flagged.length === 1 ? "it runs" : "they run"} on PiB's subscription: ${names}${flagged.length > 8 ? ", ..." : ""}.`,
    fix: "Open Setup > New company and run the Model key step again. It binds the company secret to every Claude agent.",
    href: "/setup",
  };
}
