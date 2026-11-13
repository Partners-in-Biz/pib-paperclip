/**
 * Managed skills are kept in step with the plugin as a side task of tool calls
 * and page loads. They must never wait long for it: on a company with many
 * skills the host can take more than 30 seconds to reconcile or reset one
 * (it refreshes the whole skill inventory once per skill file), and a call
 * that waits for that runs into the host's own 30-second limit. On
 * 13 Nov 2026 that made every Cockpit tool call and the Cockpit page time
 * out after a worker restart, and rolled a release back at its smoke test.
 *
 * So a caller waits a moment, then goes on while the sync finishes behind it.
 * After a failed sync the next try waits a few minutes: a retry on every call
 * only adds load to a host that is already slow.
 */
import { message, type Env } from "./env.js";

/** How long a tool call or a page load waits for the skill sync before it goes on without it. */
export const SKILL_SYNC_WAIT_MS = 2_000;
/** After a failed sync, the next try is not before this long. */
export const SKILL_SYNC_RETRY_MS = 5 * 60_000;

const failedAt = new WeakMap<Env["skills"], Map<string, number>>();

function failures(env: Env): Map<string, number> {
  let map = failedAt.get(env.skills);
  if (!map) {
    map = new Map();
    failedAt.set(env.skills, map);
  }
  return map;
}

/** Starts (or joins) the company's skill sync and waits at most {@link SKILL_SYNC_WAIT_MS} for it. Never throws. */
export async function skillsSoon(env: Env, companyId: string, waitMs: number = SKILL_SYNC_WAIT_MS): Promise<void> {
  const failed = failures(env);
  const last = failed.get(companyId);
  if (last !== undefined && env.now().getTime() - last < SKILL_SYNC_RETRY_MS) return;
  const sync = env.skills.ensure(companyId).then(
    (results) => {
      if (results.some((r) => r.action === "failed")) failed.set(companyId, env.now().getTime());
      else failed.delete(companyId);
    },
    (error) => {
      failed.set(companyId, env.now().getTime());
      env.ctx.logger.info("Managed skill sync failed", { companyId, error: message(error) });
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, waitMs);
  });
  try {
    await Promise.race([sync, wait]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
