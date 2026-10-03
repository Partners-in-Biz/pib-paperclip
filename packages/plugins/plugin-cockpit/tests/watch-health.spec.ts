/**
 * The operations watch and routine health inside the Cockpit: the rules reach
 * the Cockpit's own snapshot, the Operator's brief and the System health issue
 * with stable keys, the Operator is woken once per new problem, and nothing is
 * commented again and again.
 */
import { describe, expect, it } from "vitest";
import { companyBrief } from "../src/brief.js";
import { ROUTINES } from "../src/constants.js";
import { collectProblems, refreshHealthIssue, WARN_ESCALATE_MS } from "../src/health.js";
import manifest from "../src/manifest.js";
import { ownSnapshot } from "../src/own.js";
import { createEnv } from "../src/register.js";
import { saveTeam } from "../src/roles.js";
import { fakeCtx, fixedClock, type FakeAgent } from "./helpers/fake-ctx.js";
import type { Row } from "./helpers/fake-db.js";

const A = "company-a";
const NOW = "2026-09-26T10:00:00.000Z";
const DAYS_AGO = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();

const agents: FakeAgent[] = [
  { id: "op", companyId: A, name: "Olive", status: "active", role: "general" },
  { id: "seo", companyId: A, name: "SEO Specialist", status: "idle", role: "general" },
  { id: "dev", companyId: A, name: "Developer", status: "paused", role: "general" },
];

function setup() {
  const fake = fakeCtx({ savedConfigs: { [A]: { healthIssue: true } }, prefixes: { [A]: "PIB" }, agents: agents.map((a) => ({ ...a })) });
  const clock = fixedClock(NOW);
  const env = createEnv(fake.ctx, clock.now);
  return { ...fake, env, clock };
}

type S = ReturnType<typeof setup>;

const seed = (s: S, name: string, rows: Row[] | Error) => {
  (s.store as Record<string, unknown>)[`watch_${name}`] = rows;
};

/** The live shapes of 2026-10-03: SEO Specialist failing 37%, PAR-545 in a spawn E2BIG loop, six issues blocked for days. */
function seedLiveShapes(s: S) {
  seed(s, "rate", [
    { agent_id: "seo", status: "succeeded", error_code: null, n: "57" },
    { agent_id: "seo", status: "failed", error_code: "adapter_failed", n: "29" },
    { agent_id: "seo", status: "timed_out", error_code: "timeout", n: "4" },
  ]);
  seed(s, "streak", [
    { agent_id: "seo", status: "failed", error_code: "adapter_failed", started_at: "2026-09-26T09:50:00.000Z", issue_id: "i-545", identifier: "PAR-545" },
    { agent_id: "seo", status: "failed", error_code: "adapter_failed", started_at: "2026-09-26T09:40:00.000Z", issue_id: "i-545", identifier: "PAR-545" },
    { agent_id: "seo", status: "failed", error_code: "adapter_failed", started_at: "2026-09-26T09:30:00.000Z", issue_id: "i-545", identifier: "PAR-545" },
  ]);
  seed(s, "storm", [
    { issue_id: "i-545", failed: "13", codes: "1", error_code: "adapter_failed", agent_id: "seo", first_failed_at: "2026-09-25T20:00:00.000Z", last_error: "spawn E2BIG", identifier: "PAR-545", title: "SEO W3 · Write the top 5 category pages" },
  ]);
  seed(s, "blocked", [
    { id: "b-59", identifier: "PAR-59", title: "Refresh LLM Wiki index", since: DAYS_AGO(5), total: "6" },
    { id: "b-84", identifier: "PAR-84", title: "Implement README wiki-path fix", since: DAYS_AGO(4), total: "6" },
  ]);
  seed(s, "stalled", [{ id: "s-9", identifier: "PAR-9", title: "Fix the sitemap", assignee_agent_id: "seo", updated_at: DAYS_AGO(2), last_run_at: DAYS_AGO(1.5), total: "1" }]);
}

const KEYS = ["run-rate:seo", "run-streak:seo:adapter_failed", "retry-storm:i-545", "blocked-no-way-out", "stalled-in-progress"];

describe("the Cockpit's own snapshot carries the watch", () => {
  it("is quiet when there is nothing to report", async () => {
    const s = setup();
    const snapshot = await ownSnapshot(s.env, A);
    expect(snapshot.health.filter((c) => KEYS.includes(c.key) || c.key.startsWith("watch-unreadable") || c.key.startsWith("routine:"))).toEqual([]);
  });

  it("adds a check per rule, with the issue and error code named", async () => {
    const s = setup();
    seedLiveShapes(s);
    const snapshot = await ownSnapshot(s.env, A);
    const checks = Object.fromEntries(snapshot.health.map((c) => [c.key, c]));
    for (const key of KEYS) expect(checks[key], key).toBeTruthy();
    expect(checks["run-rate:seo"]).toMatchObject({ status: "warn", title: "SEO Specialist failed 37% of its runs" });
    expect(checks["run-streak:seo:adapter_failed"]).toMatchObject({ status: "bad", title: "SEO Specialist failed 3 times in a row with adapter_failed" });
    expect(checks["retry-storm:i-545"]).toMatchObject({ status: "bad", href: "/issues/PAR-545" });
    expect(checks["retry-storm:i-545"]!.detail).toContain("error adapter_failed");
    expect(checks["retry-storm:i-545"]!.detail).toContain("spawn E2BIG");
    expect(checks["blocked-no-way-out"]).toMatchObject({ status: "warn", title: "6 issues are blocked with no way out" });
    expect(checks["stalled-in-progress"]).toMatchObject({ status: "warn", title: "1 issue is in progress with nobody working on it" });
  });

  it("does not count a stalled issue whose assignee is paused, or whose agent list is unknown", async () => {
    const s = setup();
    seed(s, "stalled", [{ id: "s-1", identifier: "PAR-1", title: "Paused agent's issue", assignee_agent_id: "dev", updated_at: DAYS_AGO(2), last_run_at: null, total: "1" }]);
    expect((await ownSnapshot(s.env, A)).health.some((c) => c.key === "stalled-in-progress")).toBe(false);
  });

  it("says so when a rule cannot read, and keeps the rest", async () => {
    const s = setup();
    seedLiveShapes(s);
    seed(s, "blocked", new Error("relation public.issue_relations is not whitelisted"));
    const keys = (await ownSnapshot(s.env, A)).health.map((c) => c.key);
    expect(keys).toContain("watch-unreadable:blocked");
    expect(keys).toContain("retry-storm:i-545");
    expect(keys).not.toContain("blocked-no-way-out");
  });
});

describe("routine health of the Cockpit's own routines", () => {
  /** The fake host returns the routine row; a failed firing leaves lastEnqueuedAt behind lastTriggeredAt. */
  async function withFailedDaily(s: S, fired = "2026-09-26T05:00:11.000Z") {
    (s.ctx as unknown as { manifest: unknown }).manifest = manifest;
    await s.ctx.routines.managed.reconcile(ROUTINES.daily, A, { assigneeAgentId: "op" });
    Object.assign(s.routines.get(`${A}:${ROUTINES.daily}`)!, { title: "Daily operations review", lastTriggeredAt: fired, lastEnqueuedAt: null, updatedAt: "2026-09-26T05:00:11.600Z", activityGatePolicy: "always" });
  }

  it("flags a routine whose last firing created no issue, naming the plugin and routine", async () => {
    const s = setup();
    await withFailedDaily(s);
    const check = (await ownSnapshot(s.env, A)).health.find((c) => c.key === `routine:${ROUTINES.daily}`);
    expect(check).toMatchObject({ status: "bad", title: 'Cockpit routine "Daily operations review" failed its last run', since: "2026-09-26T05:00:11.000Z" });
    expect(check!.detail).toContain("26 Sep 05:00 UTC");
    expect(check!.href).toMatch(/^\/routines\//);
  });

  it("clears once a firing creates its issue", async () => {
    const s = setup();
    await withFailedDaily(s);
    (s.routines.get(`${A}:${ROUTINES.daily}`) as unknown as Record<string, unknown>).lastEnqueuedAt = "2026-09-26T05:00:11.000Z";
    expect((await ownSnapshot(s.env, A)).health.some((c) => c.key.startsWith("routine:"))).toBe(false);
  });

  it("reaches the System health issue at once (a bad check) and wakes the Operator", async () => {
    const s = setup();
    await withFailedDaily(s);
    await saveTeam(s.env, A, { operatorAgentId: "op" }, "user-1");
    const result = await refreshHealthIssue(s.env, A);
    expect(result).toMatchObject({ action: "created", problems: 1 });
    const issue = s.issues.get((result as { issueId: string }).issueId)!;
    expect(issue.description).toContain('Cockpit routine "Daily operations review" failed its last run');
    expect(s.wakeups).toContain(issue.id);
  });
});

describe("System health issue with the watch", () => {
  it("lists the problems, wakes the Operator once per new problem and never comments", async () => {
    const s = setup();
    await saveTeam(s.env, A, { operatorAgentId: "op" }, "user-1");
    seedLiveShapes(s);
    const created = await refreshHealthIssue(s.env, A);
    const id = (created as { issueId: string }).issueId;
    // Bad checks and the warnings that are already over a day old (blocked, since 4-5 days; stalled, 1.5 days) are in; the fresh rate warning is not yet.
    expect(created).toMatchObject({ action: "created", problems: 4 });
    const description = s.issues.get(id)!.description;
    expect(description).toContain("PAR-545");
    expect(description).toContain("adapter_failed");
    expect(description).toContain("6 issues are blocked with no way out");
    expect(description).not.toContain("failed 37% of its runs");
    expect(s.issues.get(id)).toMatchObject({ assigneeAgentId: "op", priority: "high" });
    expect(s.wakeups.filter((w) => w === id)).toHaveLength(1);

    // Same problems an hour later: nothing changes, nobody is woken, nothing is commented.
    expect(await refreshHealthIssue(s.env, A)).toMatchObject({ action: "unchanged" });
    expect(s.wakeups.filter((w) => w === id)).toHaveLength(1);

    // The numbers move but the problems are the same: the issue is updated in place, still no wake.
    seed(s, "storm", [{ issue_id: "i-545", failed: "14", codes: "1", error_code: "adapter_failed", agent_id: "seo", first_failed_at: "2026-09-25T20:00:00.000Z", last_error: "spawn E2BIG", identifier: "PAR-545", title: "SEO W3 · Write the top 5 category pages" }]);
    expect(await refreshHealthIssue(s.env, A)).toMatchObject({ action: "updated", problems: 4 });
    expect(s.issues.get(id)!.description).toContain("14 failed runs");
    expect(s.wakeups.filter((w) => w === id)).toHaveLength(1);

    // A new problem wakes it again, once.
    seed(s, "storm", [
      { issue_id: "i-545", failed: "14", codes: "1", error_code: "adapter_failed", agent_id: "seo", first_failed_at: "2026-09-25T20:00:00.000Z", last_error: "spawn E2BIG", identifier: "PAR-545", title: "SEO W3" },
      { issue_id: "i-528", failed: "11", codes: "1", error_code: "adapter_failed", agent_id: "seo", first_failed_at: "2026-09-25T21:00:00.000Z", last_error: "spawn E2BIG", identifier: "PAR-528", title: "SEO W3 products" },
    ]);
    expect(await refreshHealthIssue(s.env, A)).toMatchObject({ action: "updated", problems: 5 });
    expect(s.wakeups.filter((w) => w === id)).toHaveLength(2);
    expect(s.comments).toEqual([]);

    // Fixed: all clear, closed with one comment.
    for (const name of ["rate", "streak", "storm", "blocked", "stalled"]) seed(s, name, []);
    expect(await refreshHealthIssue(s.env, A)).toMatchObject({ action: "closed" });
    expect(s.comments).toHaveLength(1);
  });

  it("holds a failure-rate warning back for a day, then lists it", async () => {
    const s = setup();
    await saveTeam(s.env, A, { operatorAgentId: "op" }, "user-1");
    seed(s, "rate", [
      { agent_id: "seo", status: "succeeded", error_code: null, n: "20" },
      { agent_id: "seo", status: "failed", error_code: "adapter_failed", n: "6" },
    ]);
    expect(await refreshHealthIssue(s.env, A)).toMatchObject({ action: "none" });
    expect((await ownSnapshot(s.env, A)).health.some((c) => c.key === "run-rate:seo")).toBe(true);
    s.clock.set(new Date(Date.parse(NOW) + WARN_ESCALATE_MS + 3_600_000).toISOString());
    const later = await refreshHealthIssue(s.env, A);
    expect(later).toMatchObject({ action: "created", problems: 1 });
    expect(s.issues.get((later as { issueId: string }).issueId)!.description).toContain("SEO Specialist failed 23% of its runs");
  });

  it("is one check list for the Operator's brief and the page too", async () => {
    const s = setup();
    seedLiveShapes(s);
    const brief = await companyBrief(s.env, A);
    const titles = brief.health.problems.map((p) => p.title);
    expect(titles).toContain("SEO Specialist failed 3 times in a row with adapter_failed");
    expect(titles).toContain("PAR-545 keeps failing: 13 failed runs in 24 hours");
    expect(titles).toContain("6 issues are blocked with no way out");
    expect(brief.health.status).toBe("bad");
    const problems = await collectProblems(s.env, A);
    expect(problems.keys).toEqual(expect.arrayContaining(KEYS.slice(1, 4).map((k) => `partnersinbiz.cockpit:${k}`)));
  });
});
