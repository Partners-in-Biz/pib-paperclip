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

/** Stock title. An import copy has no built-in origin, so this is how the copy is recognized. */
export const NIGHTLY_DREAMING_STOCK_TITLE =
  "Nightly dreaming — draft skill and memory proposals from run logs";

const NIGHTLY_DREAMING_DESCRIPTION_MARKERS = [
  "PAPERCLIP_NIGHTLY_DREAMING",
  "routine key `nightly-dreaming`",
  "routineKey: nightly-dreaming",
] as const;

export const NIGHTLY_DREAMING_STOCK_TRIGGER_LABEL = "Nightly dreaming draft";

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
 * A portable copy has no built-in origin. Match the stock title, the prompt
 * markers, or the stock trigger label. Do not match a bare origin id: that
 * would treat unrelated manual rows as this routine.
 */
export function portableRoutineIsNightlyDreaming(input: {
  title?: string | null;
  description?: string | null;
  triggerLabels?: ReadonlyArray<string | null | undefined> | null;
}): boolean {
  if (input.title?.trim() === NIGHTLY_DREAMING_STOCK_TITLE) return true;
  const description = input.description ?? "";
  if (NIGHTLY_DREAMING_DESCRIPTION_MARKERS.some((marker) => description.includes(marker))) return true;
  return input.triggerLabels?.some((label) => label?.trim() === NIGHTLY_DREAMING_STOCK_TRIGGER_LABEL) ?? false;
}

/**
 * True when this stored routine is nightly dreaming and the flag is off.
 * The live bundle is origin-keyed. An imported copy has no origin, so title
 * and description count too. That does not rewrite the live Reflection Coach row.
 */
export function nightlyDreamingRunBlocked(
  routine: {
    originKind?: string | null;
    originId?: string | null;
    title?: string | null;
    description?: string | null;
  },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const originMatch = routine.originKind === "built_in_agent_bundle"
    && Boolean(routine.originId?.endsWith(`:${NIGHTLY_DREAMING_ROUTINE_KEY}`));
  if (!originMatch && !portableRoutineIsNightlyDreaming(routine)) return false;
  return !nightlyDreamingEnabled(env);
}
