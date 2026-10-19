/**
 * Claude auth required card: when N agents fail with `claude_auth_required` in a row,
 * opens one Cockpit-originated ask per company to inform the owner that the server
 * login has expired and must be re-logged.
 *
 * Deduped per company: at most one card per 24 hours.
 */
import { type AskEffect } from "./ask-model.js";
import { openCockpitAsk } from "./effects.js";
import { message, type Env } from "./env.js";
import { NAMESPACE } from "./namespace.js";

const AUTH_CARD_KEY = "auth-login-expired";
const AUTH_CARD_COOLDOWN_MS = 24 * 3_600_000;

/** Open a Cockpit ask about Claude login expiry if no ask opened in the last 24 hours. */
export async function ensureAuthCard(env: Env, companyId: string, agentIds: string[]): Promise<{ action: "opened" | "exists" | "skipped"; reason?: string }> {
  if (agentIds.length === 0) return { action: "skipped", reason: "No agents with auth failures" };

  const now = env.now();
  const key = `${AUTH_CARD_KEY}:${companyId}`;

  // Check if there's a recent card open or recently asked (dedupe per 24 h).
  const lastAsked = await checkLastAuthCard(env, companyId);
  if (lastAsked && now.getTime() - lastAsked.getTime() < AUTH_CARD_COOLDOWN_MS) {
    return { action: "exists", reason: "Auth card asked recently" };
  }

  // Prepare the ask card.
  const agentCount = agentIds.length;
  const agentPhrase = agentCount === 1 ? "1 agent" : `${agentCount} agents`;
  const effect: AskEffect = { key: "cockpit.auth-card-noted" };

  const result = await openCockpitAsk(env, companyId, {
    originKey: AUTH_CARD_KEY,
    title: `Re-login on the server (${agentPhrase} failing)`,
    card: {
      kind: "grant",
      question: `The Claude login on the Paperclip server has expired. ${agentPhrase} cannot run until it is renewed.`,
      why: "When the server's Paperclip account loses its login session, every agent that runs through it fails with 'claude_auth_required'. Agents cannot recover until the login is renewed.",
      options: ["I will re-login now"],
      links: [{ label: "Server", href: "/settings/team" }],
      steps: [
        "On the Paperclip server: `su - paperclip` (or `sudo -u paperclip bash`)",
        "Run: `claude /login` or `claude login`",
        "Authenticate with your Anthropic account",
        "Reply here when done, or the agents will resume on their next run",
      ],
      effect,
    },
  });

  return result;
}

/** Returns the time when an auth card was last opened or asked (within cooldown). */
async function checkLastAuthCard(env: Env, companyId: string): Promise<Date | null> {
  try {
    const rows = await env.ctx.db.query<Record<string, unknown>>(
      `SELECT asked_at FROM ${getAsksTable()} WHERE company_id = $1 AND source = 'cockpit' AND effect ->> 'key' = $2 AND status IN ('open', 'answered') ORDER BY asked_at DESC LIMIT 1`,
      [companyId, "cockpit.auth-card-noted"],
    );
    if (rows[0]) {
      const askedAt = rows[0].asked_at;
      const t = Date.parse(String(askedAt ?? ""));
      return Number.isFinite(t) ? new Date(t) : null;
    }
  } catch (error) {
    env.ctx.logger.info("Auth card: could not check recent asks", { companyId, error: message(error) });
  }
  return null;
}

function getAsksTable(): string {
  return `${NAMESPACE}.asks`;
}
