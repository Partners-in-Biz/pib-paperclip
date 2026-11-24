/**
 * The record of one run of the Cockpit's own checks (PAR-11071 rule 1): each
 * part and section by name, how it ended and how long it took, and the one
 * log line made from it. Since stage 1a-ii (PAR-11232) the snapshot also reads
 * it for the "Cockpit checks incomplete" row (`lost`, `held` and `notRun` parts).
 */
import type { RunTrigger } from "./run-trigger.js";

/**
 * `ran`: finished. `failed`: threw (the run went on without it). `cached`:
 * served from the 10-minute cache. `lost`: ran, then the company read after it
 * was refused, so its result is dropped. `held`: lost twice in a row, left
 * alone for 10 minutes. `notRun`: due, but the run had stopped.
 */
export type PartState = "ran" | "failed" | "cached" | "lost" | "held" | "notRun";

/** The states that leave a part's problems unseen this time. */
export const UNFINISHED: ReadonlySet<PartState> = new Set<PartState>(["lost", "held", "notRun"]);

/** The parts that did not finish, in run order. */
export function unfinishedParts(records: PartRecord[]): string[] {
  return records.filter((r) => UNFINISHED.has(r.state)).map((r) => r.name);
}

export interface PartRecord {
  name: string;
  state: PartState;
  ms: number;
}

/** A monotonic clock in ms (not `env.now()`: tests fix that one). */
export const clockMs = (): number => performance.now();

/** Times `run` and adds its record to `into`; a throw is recorded as `failed` and thrown on. */
export async function timed<T>(into: PartRecord[], name: string, run: () => Promise<T>): Promise<T> {
  const start = clockMs();
  try {
    const value = await run();
    into.push({ name, state: "ran", ms: clockMs() - start });
    return value;
  } catch (error) {
    into.push({ name, state: "failed", ms: clockMs() - start });
    throw error;
  }
}

/** `name:state:ms,...` in run order, whole ms. */
export function recordString(records: PartRecord[]): string {
  return records.map((r) => `${r.name}:${r.state}:${Math.round(r.ms)}`).join(",");
}

/** The meta of the "Cockpit own checks" line: every value a string, number or boolean, no key `error`. */
export type OwnRunMeta = Record<string, string | number | boolean>;

export function ownRunMeta(input: { companyId: string; boot: string; trigger: RunTrigger; totalMs: number; sections: PartRecord[]; sectionsBeforeChecks: number; parts: PartRecord[]; stop?: { lostPart: string; code: number } }): OwnRunMeta {
  const before = input.sections.slice(0, input.sectionsBeforeChecks);
  return {
    companyId: input.companyId,
    boot: input.boot,
    trigger: input.trigger,
    totalMs: Math.round(input.totalMs),
    sectionsMs: Math.round(before.reduce((sum, s) => sum + s.ms, 0)),
    incomplete: unfinishedParts(input.parts).length > 0,
    lostPart: input.stop?.lostPart ?? "",
    stopCode: input.stop?.code ?? 0,
    parts: recordString(input.parts),
    sections: recordString(input.sections),
  };
}
