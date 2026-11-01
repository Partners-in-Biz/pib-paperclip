/**
 * Nightly dreaming (PAR-6228).
 *
 * Default off. Turn on only after the stock routine's tests have passed on
 * development. `1`, `true`, and `on` enable it. Anything else, including an
 * unset variable, stays off so a deploy cannot start the job by accident.
 *
 * The schedule key is separate from the older weekly reflection routine so a
 * stock update cannot rewrite that live row.
 */
export const NIGHTLY_DREAMING_ROUTINE_KEY = "nightly-dreaming";

export function nightlyDreamingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.PAPERCLIP_NIGHTLY_DREAMING?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

/** Other routines are unaffected. This key may be enabled or run only when the flag is on. */
export function nightlyDreamingMaySchedule(
  routineKey: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (routineKey !== NIGHTLY_DREAMING_ROUTINE_KEY) return true;
  return nightlyDreamingEnabled(env);
}

/**
 * True when this stored routine is the nightly dreaming bundle and the flag is off.
 * Generic routes and the scheduler see origin, not the built-in routine key.
 */
export function nightlyDreamingRunBlocked(
  routine: { originKind?: string | null; originId?: string | null },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (routine.originKind !== "built_in_agent_bundle") return false;
  if (!routine.originId?.endsWith(`:${NIGHTLY_DREAMING_ROUTINE_KEY}`)) return false;
  return !nightlyDreamingEnabled(env);
}
