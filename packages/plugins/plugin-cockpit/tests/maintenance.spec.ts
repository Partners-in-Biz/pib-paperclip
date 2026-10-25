import { describe, expect, it } from "vitest";
import { MAINTENANCE_WINDOW, parseReleaseNote } from "../src/maintenance.js";
import { saveHealthIssue } from "../src/db.js";
import { createEnv, registerCockpit } from "../src/register.js";
import { fakeCtx, fixedClock } from "./helpers/fake-ctx.js";

const A = "company-a";
const NOW = "2026-10-25T12:00:00.000Z";
const user = { companyId: A, actor: { type: "user", userId: "user-1" } };

function note(over: Record<string, unknown> = {}, v = "1"): string {
  const json = { id: "d1", phase: "planned", plugin: "billing", version: "0.11.0", reason: "migration", windowStartUtc: "2026-10-26T01:00:00.000Z", windowEndUtc: "2026-10-26T04:00:00.000Z", downtimeMinutes: 5, ...over };
  return `<!-- pib-release-note v${v} ${JSON.stringify(json)} -->\nBilling 0.11.0 goes live tonight.\nNo action needed.`;
}

async function load(bodies: string[] | null) {
  const fake = fakeCtx({ savedConfigs: { [A]: { healthIssue: true } } });
  const env = createEnv(fake.ctx, fixedClock(NOW).now);
  registerCockpit(fake.ctx, env);
  if (bodies) {
    await saveHealthIssue(fake.ctx, { companyId: A, issueId: "health-1", fingerprint: "", problemKeys: [] }, NOW);
    let n = 0;
    for (const body of bodies) {
      fake.comments.push({ id: `c${++n}`, issueId: "health-1", companyId: A, body, createdAt: new Date(Date.parse(NOW) - 1000 * (bodies.length - n)).toISOString() });
    }
  }
  return (await fake.actions.get("maintenance.load")!({}, user)) as any;
}

describe("maintenance.load", () => {
  it("states the 4.0 window", () => {
    expect(MAINTENANCE_WINDOW.stopFirst).toMatchObject({ startUtc: "01:00", endUtc: "04:00", startSast: "03:00", endSast: "06:00", days: "daily" });
    expect(MAINTENANCE_WINDOW.weekly).toMatchObject({ day: "Sunday", startUtc: "03:00", mode: "report-only" });
  });

  it("returns the planned note", async () => {
    const view = await load([note()]);
    expect(view.next).toMatchObject({ id: "d1", plugin: "billing", phase: "planned" });
    expect(view.recent).toHaveLength(1);
    expect(view.window.startUtc).toBe("01:00");
  });

  it("a later live note of the same id closes it", async () => {
    const view = await load([note(), note({ phase: "live" })]);
    expect(view.next).toBeNull();
    expect(view.recent.map((n: any) => n.phase)).toEqual(["live", "planned"]);
  });

  it("a later cancelled note closes it; another id does not", async () => {
    expect((await load([note(), note({ phase: "cancelled" })])).next).toBeNull();
    expect((await load([note(), note({ id: "d2", phase: "live" })])).next).toMatchObject({ id: "d1" });
  });

  it("ignores a window already past or more than 7 days out", async () => {
    expect((await load([note({ windowStartUtc: "2026-10-24T01:00:00.000Z", windowEndUtc: "2026-10-24T04:00:00.000Z" })])).next).toBeNull();
    expect((await load([note({ windowStartUtc: "2026-11-02T01:00:00.000Z", windowEndUtc: "2026-11-02T04:00:00.000Z" })])).next).toBeNull();
  });

  it("picks the latest of several planned notes", async () => {
    const view = await load([note(), note({ id: "d2", windowStartUtc: "2026-10-27T01:00:00.000Z", windowEndUtc: "2026-10-27T04:00:00.000Z" })]);
    expect(view.next.id).toBe("d2");
  });

  it("keeps only the last five, newest first", async () => {
    const view = await load(Array.from({ length: 7 }, (_, i) => note({ id: `x${i}`, phase: "live" })));
    expect(view.recent.map((n: any) => n.id)).toEqual(["x6", "x5", "x4", "x3", "x2"]);
  });

  it("ignores malformed JSON, unknown versions and comments without a marker", async () => {
    const view = await load(["<!-- pib-release-note v1 {not json} -->", note({}, "2"), "just a comment", note({ phase: "soon" }), note({ downtimeMinutes: 1.5 })]);
    expect(view).toMatchObject({ next: null, recent: [] });
  });

  it("gives an empty view when the company has no health issue", async () => {
    const view = await load(null);
    expect(view).toMatchObject({ next: null, recent: [] });
    expect(view.window.endUtc).toBe("04:00");
  });

  it("parseReleaseNote reads only the first line", () => {
    expect(parseReleaseNote(`intro\n${note()}`, NOW)).toBeNull();
    expect(parseReleaseNote(note(), NOW)?.downtimeMinutes).toBe(5);
  });
});
