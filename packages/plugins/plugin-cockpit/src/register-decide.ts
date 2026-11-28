/**
 * Registers the Decide tab's page actions (PAR-15315). T1: the queue. T2: the three that decide, acting as the owner
 * (`decide-actions.ts`; each checks the caller is the owner before any host call).
 */
import type { AccessGuard } from "@partnersinbiz/pib-plugin-kit";
import { decideQueue } from "./decide.js";
import { decideApproval, decideAsk, decideCard } from "./decide-actions.js";
import type { Env } from "./env.js";

export function registerDecide(env: Env, guard: AccessGuard): void {
  // The owner's queue, most urgent first. Another member gets `notOwner: true`; an agent is refused.
  guard.action("decide.queue", async (_params, context) => decideQueue(env, context));
  // Answer an ask with one of its options, as the owner.
  guard.action("decide.ask", async (params, context) => decideAsk(env, params, context));
  // Approve or reject a request_board_approval or approve_ceo_strategy approval, as the owner.
  guard.action("decide.approval", async (params, context) => decideApproval(env, params, context));
  // Accept or reject a request_confirmation card addressed to nobody or the owner, as the owner.
  guard.action("decide.card", async (params, context) => decideCard(env, params, context));
}
