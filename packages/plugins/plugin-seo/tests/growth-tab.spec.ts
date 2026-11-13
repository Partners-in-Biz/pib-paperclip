/** PAR-10101: Growth tab words and rules. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { GROWTH_UNLINKED_TEXT, canStart, growthDecider, growthScopeLabel, playbookPointer, splitExperiments } from "../src/ui/growth-words.js";
import type { GrowthExperimentRow } from "../src/ui/types.js";

const x = (status: GrowthExperimentRow["status"]): GrowthExperimentRow => ({ experimentId: status, status, hypothesis: "h", hypothesisType: "title", arms: [], minPerArm: 3, windowDays: 14, startedAt: null, measuredAt: null, verdict: null, reason: null, note: null, playbookDiff: null, counts: null, createdAt: null });

describe("growth tab", () => {
  it("sits after Playbook so ?tab=growth opens it", () => {
    const src = readFileSync(new URL("../src/ui/sprint.tsx", import.meta.url), "utf8");
    const ids = [...src.matchAll(/^  \{ id: "(\w+)", label:/gm)].map((m) => m[1]);
    expect(ids.indexOf("growth")).toBe(ids.indexOf("playbook") + 1);
    expect(src).toContain('<GrowthTab sprintId={sprintId} onMessage={onMessage} onOpenTab={selectTab} />');
  });
  it("names the scope shown", () => {
    expect(growthScopeLabel({ scope: "own" })).toBe("Our own sites (shared by every own sprint)");
    expect(growthScopeLabel({ scope: "client", clientName: "Acme Ltd" })).toBe("Acme Ltd");
    expect(GROWTH_UNLINKED_TEXT).toContain("not linked to a CRM record");
  });
  it("says who decides", () => {
    expect(growthDecider("safe")).toContain("a person approves");
    expect(growthDecider(null)).toContain("a person approves");
    expect(growthDecider("full")).toContain("agent approves");
  });
  it("blocks approve at the running cap", () => {
    expect(canStart({ running: 1, maxRunning: 2 })).toBe(true);
    expect(canStart({ running: 2, maxRunning: 2 })).toBe(false);
  });
  it("splits experiments into the three sections", () => {
    const s = splitExperiments([x("proposed"), x("running"), x("measured"), x("rejected"), x("abandoned")]);
    expect([s.proposed.length, s.running.length, s.finished.length]).toEqual([1, 1, 3]);
  });
  it("shows the playbook pointer only above 0", () => {
    expect(playbookPointer(0)).toBeNull();
    expect(playbookPointer(null)).toBeNull();
    expect(playbookPointer(1)).toBe("1 playbook change waits on the Playbook tab");
    expect(playbookPointer(3)).toBe("3 playbook changes wait on the Playbook tab");
  });
});
