/**
 * Time budget for the company brief. One query that hangs must not stall the
 * whole call (the host answers 504 after about 30 s): each section gets a
 * limit, the whole brief a deadline, and a section that misses its limit gives
 * its empty value and is named in `degraded`.
 */

/** Longest one section may take. */
export const SECTION_MS = 8_000;
/** Deadline for all sections of one brief; later sections still get `MIN_SECTION_MS`. */
export const TOTAL_MS = 20_000;
const MIN_SECTION_MS = 250;

export interface BriefBudget {
  /** Names of the sections that timed out or failed, in the order they gave up. */
  degraded: string[];
  /** Run one section: its value, or `fallback` when it fails or runs out of time. */
  guard<T>(name: string, run: () => Promise<T>, fallback: T): Promise<T>;
}

export function briefBudget(
  log: (text: string, meta: Record<string, unknown>) => void,
  options: { sectionMs?: number; totalMs?: number } = {},
): BriefBudget {
  const sectionMs = options.sectionMs ?? SECTION_MS;
  const deadline = Date.now() + (options.totalMs ?? TOTAL_MS);
  const degraded: string[] = [];
  const give = (name: string, reason: string) => {
    if (!degraded.includes(name)) degraded.push(name);
    log("Brief: section unavailable", { section: name, reason });
  };
  return {
    degraded,
    async guard<T>(name: string, run: () => Promise<T>, fallback: T): Promise<T> {
      const limit = Math.min(sectionMs, Math.max(deadline - Date.now(), MIN_SECTION_MS));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), limit);
      });
      try {
        const value = await Promise.race([run(), late]);
        if (value === TIMED_OUT) {
          give(name, `no answer in ${limit} ms`);
          return fallback;
        }
        return value as T;
      } catch (error) {
        give(name, error instanceof Error ? error.message : String(error));
        return fallback;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

const TIMED_OUT = Symbol("timed-out");
