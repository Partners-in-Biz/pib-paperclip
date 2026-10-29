/**
 * Nightly dreaming (PAR-6228).
 *
 * Default off. Turn on only after the stock routine's tests have passed on
 * development. `1`, `true`, and `on` enable it. Anything else, including an
 * unset variable, stays off so a deploy cannot start the job by accident.
 */
export function nightlyDreamingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.PAPERCLIP_NIGHTLY_DREAMING?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}
