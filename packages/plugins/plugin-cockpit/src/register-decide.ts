/**
 * Registers the Decide tab's page actions (PAR-15315). T1: the queue. T2 adds the three that decide.
 */
import type { AccessGuard } from "@partnersinbiz/pib-plugin-kit";
import { decideQueue } from "./decide.js";
import type { Env } from "./env.js";

export function registerDecide(env: Env, guard: AccessGuard): void {
  // The owner's queue, most urgent first. Another member gets `notOwner: true`; an agent is refused.
  guard.action("decide.queue", async (_params, context) => decideQueue(env, context));
}
