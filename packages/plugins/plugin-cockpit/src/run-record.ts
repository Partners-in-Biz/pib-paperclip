/**
 * The record of one run of the Cockpit's own checks (PAR-11071 rule 1): each
 * part and section by name, how it ended and how long it took, and the one
 * log line made from it. Measurement only: nothing the Cockpit does reads it.
 */
import type { RunTrigger } from "./run-trigger.js";

/** `ran`: finished. `failed`: threw (the run went on without it). */
export type PartState = "ran" | "failed";

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

export function ownRunMeta(input: { companyId: string; boot: string; trigger: RunTrigger; totalMs: number; sections: PartRecord[]; sectionsBeforeChecks: number; parts: PartRecord[] }): OwnRunMeta {
  const before = input.sections.slice(0, input.sectionsBeforeChecks);
  return {
    companyId: input.companyId,
    boot: input.boot,
    trigger: input.trigger,
    totalMs: Math.round(input.totalMs),
    sectionsMs: Math.round(before.reduce((sum, s) => sum + s.ms, 0)),
    // Always complete here; the stop (stage 1a-ii) fills these three without changing the line's shape.
    incomplete: false,
    lostPart: "",
    stopCode: 0,
    parts: recordString(input.parts),
    sections: recordString(input.sections),
  };
}
