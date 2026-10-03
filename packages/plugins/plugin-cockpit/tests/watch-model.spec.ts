/**
 * The operations watch rules (pure): failure rate, repeated errors, retry
 * storms, blocked and stalled issues. Fixtures follow the live 2026-10-03
 * shapes (SEO Specialist's adapter_failed streaks, PAR-545's E2BIG loop, the
 * PAR issues blocked since 28 Sep).
 */
import { describe, expect, it } from "vitest";
import {
  ageLabel,
  blockedCheck,
  blockedOwnerCheck,
  FINISHED_RUN,
  redactSecrets,
  retryStormChecks,
  runRateChecks,
  runStreakChecks,
  stalledCheck,
  unreadableCheck,
  WATCH,
  type RateRow,
  type StormRow,
  type StreakRun,
  type WatchAgent,
} from "../src/watch-model.js";

const NOW = new Date("2026-10-03T12:00:00.000Z");
const agents = new Map<string, WatchAgent>([
  ["seo", { id: "seo", name: "SEO Specialist", status: "idle", urlKey: "seo-specialist" }],
  ["rev", { id: "rev", name: "Reviewer", status: "idle" }],
  ["dev", { id: "dev", name: "Developer", status: "active" }],
]);

const rate = (agentId: string, status: string, count: number, errorCode: string | null = null): RateRow => ({ agentId, status, errorCode, count });

describe("the finished-run statuses", () => {
  it("are plain words safe to put in SQL, and include the host's failed and timed_out", () => {
    expect(FINISHED_RUN).toContain("succeeded");
    expect(FINISHED_RUN).toContain("failed");
    expect(FINISHED_RUN).toContain("timed_out");
    for (const status of FINISHED_RUN) expect(status).toMatch(/^[a-z_]+$/);
  });
});

describe("run rate: more than 15% failed over at least 20 runs in 24 hours", () => {
  it("flags an agent over the line, naming the most common error", () => {
    const [check, ...rest] = runRateChecks([rate("seo", "succeeded", 40), rate("seo", "failed", 31, "adapter_failed"), rate("seo", "failed", 2, "acpx_turn_failed")], agents);
    expect(rest).toEqual([]);
    expect(check).toMatchObject({
      key: "run-rate:seo",
      title: "SEO Specialist failed 45% of its runs",
      status: "warn",
      detail: "33 of 73 finished runs in the last 24 hours failed or timed out; most often adapter_failed (31).",
      href: "/agents/seo-specialist",
    });
    expect(check!.fix).toContain("retry storm");
  });

  it("is serious when half or more fail", () => {
    expect(runRateChecks([rate("rev", "succeeded", 10), rate("rev", "timed_out", 10, "timeout")], agents)[0]).toMatchObject({ status: "bad", title: "Reviewer failed 50% of its runs" });
  });

  it("needs at least 20 finished runs and strictly more than 15%", () => {
    expect(runRateChecks([rate("seo", "failed", 19)], agents)).toEqual([]);
    expect(runRateChecks([rate("seo", "succeeded", 17), rate("seo", "failed", 3)], agents)).toEqual([]); // exactly 15%
    expect(runRateChecks([rate("seo", "succeeded", 16), rate("seo", "failed", 4)], agents)).toHaveLength(1); // 20%
    expect(runRateChecks([rate("seo", "succeeded", 100), rate("seo", "failed", 15)], agents)).toEqual([]); // 13%
  });

  it("lists the worst agents first, at most five, and falls back to a generic name", () => {
    const rows: RateRow[] = [];
    for (let i = 0; i < 7; i += 1) rows.push(rate(`a${i}`, "succeeded", 20 - i), rate(`a${i}`, "failed", 10 + i));
    const checks = runRateChecks(rows, agents);
    expect(checks).toHaveLength(WATCH.perRule);
    expect(checks.map((c) => c.key)).toEqual(["run-rate:a6", "run-rate:a5", "run-rate:a4", "run-rate:a3", "run-rate:a2"]);
    expect(checks[0]!.title).toMatch(/^An agent failed /);
    expect(checks[0]!.href).toBe("/agents/a6");
  });

  it("has no error to name when the failures carry no code", () => {
    expect(runRateChecks([rate("dev", "succeeded", 10), rate("dev", "failed", 12)], agents)[0]!.detail).toBe("12 of 22 finished runs in the last 24 hours failed or timed out.");
  });
});

const run = (agentId: string, status: string, errorCode: string | null, minutesAgo: number, issueId: string | null = "i-545", identifier: string | null = "PAR-545"): StreakRun => ({
  agentId,
  status,
  errorCode,
  startedAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
  issueId,
  identifier,
});

describe("run streak: the same error code three or more times in a row", () => {
  it("flags three failures with one code on one issue", () => {
    const [check] = runStreakChecks([run("seo", "failed", "adapter_failed", 5), run("seo", "failed", "adapter_failed", 6), run("seo", "failed", "adapter_failed", 7), run("seo", "succeeded", null, 30)], agents);
    expect(check).toMatchObject({
      key: "run-streak:seo:adapter_failed",
      title: "SEO Specialist failed 3 times in a row with adapter_failed",
      status: "bad",
      detail: "Its last 3 runs all ended with adapter_failed on PAR-545. The same error each time means retrying will not help.",
      since: new Date(NOW.getTime() - 7 * 60_000).toISOString(),
    });
  });

  it("does not depend on the order of the rows", () => {
    const rows = [run("seo", "failed", "adapter_failed", 7), run("seo", "succeeded", null, 30), run("seo", "failed", "adapter_failed", 5), run("seo", "failed", "adapter_failed", 6)];
    expect(runStreakChecks(rows, agents)).toHaveLength(1);
  });

  it("is not a streak when a success, another code or a missing code interrupts it, or when there are only two", () => {
    expect(runStreakChecks([run("seo", "failed", "adapter_failed", 1), run("seo", "failed", "adapter_failed", 2), run("seo", "succeeded", null, 3), run("seo", "failed", "adapter_failed", 4)], agents)).toEqual([]);
    expect(runStreakChecks([run("seo", "failed", "adapter_failed", 1), run("seo", "failed", "acpx_turn_failed", 2), run("seo", "failed", "adapter_failed", 3)], agents)).toEqual([]);
    expect(runStreakChecks([run("seo", "failed", "adapter_failed", 1), run("seo", "failed", "adapter_failed", 2)], agents)).toEqual([]);
    expect(runStreakChecks([run("seo", "failed", null, 1), run("seo", "failed", null, 2), run("seo", "failed", null, 3)], agents)).toEqual([]);
  });

  it("counts timed_out runs as failures and names several issues without picking one", () => {
    const [check] = runStreakChecks([run("rev", "timed_out", "timeout", 1, "i-1", "PAR-1"), run("rev", "timed_out", "timeout", 2, "i-2", "PAR-2"), run("rev", "timed_out", "timeout", 3, "i-1", "PAR-1")], agents);
    expect(check!.detail).toContain("on 2 issues");
  });

  it("says 10 or more when the whole look-back failed", () => {
    const rows = Array.from({ length: WATCH.streakLookback }, (_, i) => run("seo", "failed", "adapter_failed", i + 1));
    expect(runStreakChecks(rows, agents)[0]!.title).toBe("SEO Specialist failed 10 or more times in a row with adapter_failed");
  });

  it("keeps agents apart", () => {
    const rows = [run("seo", "failed", "adapter_failed", 1), run("rev", "succeeded", null, 2), run("seo", "failed", "adapter_failed", 3), run("seo", "failed", "adapter_failed", 4)];
    expect(runStreakChecks(rows, agents).map((c) => c.key)).toEqual(["run-streak:seo:adapter_failed"]);
  });
});

const storm = (extra: Partial<StormRow> = {}): StormRow => ({
  issueId: "i-545",
  identifier: "PAR-545",
  title: "SEO W1 · Repair the Hunt and Gun category pages",
  failed: 13,
  errorCode: "adapter_failed",
  codes: 1,
  agentId: "seo",
  firstFailedAt: "2026-10-02T14:00:00.000Z",
  lastError: "spawn E2BIG",
  ...extra,
});

describe("retry storm: one issue with four or more failed runs in 24 hours", () => {
  it("names the issue, the agent, the count and the error code", () => {
    const [check] = retryStormChecks([storm()], agents);
    expect(check).toMatchObject({
      key: "retry-storm:i-545",
      title: "PAR-545 keeps failing: 13 failed runs in 24 hours",
      status: "bad",
      href: "/issues/PAR-545",
      since: "2026-10-02T14:00:00.000Z",
    });
    expect(check!.detail).toBe('13 runs of SEO Specialist on PAR-545 "SEO W1 · Repair the Hunt and Gun category pages" failed in the last 24 hours, error adapter_failed, and the latest run failed too. Latest error: spawn E2BIG');
    expect(check!.fix).toContain("spawn E2BIG");
    expect(check!.fix).toContain("continuation issue");
  });

  it("says when the failures had several codes, and copes with a missing identifier, title, agent and error", () => {
    expect(retryStormChecks([storm({ codes: 3 })], agents)[0]!.detail).toContain("error adapter_failed (3 different errors in all)");
    const [bare] = retryStormChecks([storm({ identifier: null, title: null, agentId: null, errorCode: null, lastError: null })], agents);
    expect(bare).toMatchObject({ title: "an issue keeps failing: 13 failed runs in 24 hours", href: "/issues/i-545" });
    expect(bare!.detail).toBe("13 runs on an issue failed in the last 24 hours, and the latest run failed too.");
  });

  it("keeps the error text short and on one line, worst storms first, five at most", () => {
    const rows = Array.from({ length: 7 }, (_, i) => storm({ issueId: `i-${i}`, identifier: `PAR-${i}`, failed: 4 + i, lastError: `line one\nline two ${"x".repeat(300)}` }));
    const checks = retryStormChecks(rows, agents);
    expect(checks).toHaveLength(5);
    expect(checks[0]!.key).toBe("retry-storm:i-6");
    expect(checks[0]!.detail).not.toContain("\n");
    expect(checks[0]!.detail!.split("Latest error: ")[1]!.length).toBeLessThanOrEqual(160);
  });
});

describe("redaction of error text copied into the System health issue and the brief", () => {
  it("hides credentials an adapter error can echo, and leaves the rest readable", () => {
    const cases: Array<[string, string]> = [
      ["git clone https://peet:s3cr3tpass@github.com/Partners-in-Biz/x.git failed", "git clone https://[redacted]@github.com/Partners-in-Biz/x.git failed"],
      ["git clone https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/x failed", "git clone https://[redacted]@github.com/x failed"],
      ["push rejected for ghp_abcdefghijklmnopqrstuvwxyz0123456789", "push rejected for [redacted]"],
      ["token github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz was rejected", "token [redacted] was rejected"],
      ["401 from api with sk-ant-api03-abcdefghijklmnopqrstuvwx", "401 from api with [redacted]"],
      ["Authorization: Bearer abcdefghijklmnop1234567890.abc", "Authorization: Bearer [redacted]"],
      ["spawn E2BIG with GITHUB_TOKEN=abc123 and PGPASSWORD='hunter two' set", "spawn E2BIG with GITHUB_TOKEN=[redacted] and PGPASSWORD=[redacted] set"],
      ["xoxb-1234567890-abcdefghij failed; AKIAABCDEFGHIJKLMNOP denied", "[redacted] failed; [redacted] denied"],
    ];
    for (const [input, expected] of cases) expect(redactSecrets(input), input).toBe(expected);
    for (const plain of ["spawn E2BIG", "workspace_validation_failed: project has no workspace", "Failed query: select routine_revision_id from routine_runs where id = $1", "risk-assessment-for-customers-tomorrow"]) expect(redactSecrets(plain)).toBe(plain);
  });

  it("is applied to the latest error of a retry storm and to an unreadable rule", () => {
    const [check] = retryStormChecks([storm({ lastError: "fatal: could not read from https://ci:pa55w0rd@github.com/x.git" })], agents);
    expect(check!.detail).toContain("https://[redacted]@github.com/x.git");
    expect(check!.detail).not.toContain("pa55w0rd");
    const rule = unreadableCheck("blocked", "blocked issues", "connect failed: postgres://app:hunter2@db/paperclip");
    expect(rule.detail).not.toContain("hunter2");
  });
});

describe("blocked with no way out", () => {
  const issue = (n: number, daysAgo: number) => ({ id: `b-${n}`, identifier: `PAR-${n}`, title: `Blocked thing ${n}`, since: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString() });

  it("is nothing when nothing is stuck", () => {
    expect(blockedCheck([], 0, NOW)).toBeNull();
  });

  it("lists the oldest first with how long, and counts the rest", () => {
    const check = blockedCheck([issue(70, 5), issue(59, 8), issue(64, 1.5)], 9, NOW)!;
    expect(check).toMatchObject({ key: "blocked-no-way-out", title: "9 issues are blocked with no way out", status: "warn", href: "/issues/PAR-59", since: issue(59, 8).since });
    expect(check.detail).toBe('Blocked for more than 24 hours with no unblock owner, no blocker issue and no question to the owner, so nothing will wake them: PAR-59 "Blocked thing 59" (8 days), PAR-70 "Blocked thing 70" (5 days), PAR-64 "Blocked thing 64" (36 h) and 6 more.');
    expect(check.fix).toContain("unblock owner and action");
  });

  it("says issue in the singular and escalates at once (its own since is more than a day old)", () => {
    const check = blockedCheck([issue(1, 2)], 1, NOW)!;
    expect(check.title).toBe("1 issue is blocked with no way out");
    expect(NOW.getTime() - Date.parse(check.since!)).toBeGreaterThanOrEqual(WATCH.blockedHours * 3_600_000);
  });

  it("names at most five issues", () => {
    const items = Array.from({ length: 8 }, (_, i) => issue(i + 1, i + 2));
    expect((blockedCheck(items, 8, NOW)!.detail!.match(/PAR-\d+/g) ?? []).length).toBe(WATCH.named);
  });

  it("says exactly what is missing, and that an issue whose blockers are all done only has to be moved on", () => {
    const one = blockedCheck([{ ...issue(5, 3), closedBlockers: 1 }], 1, NOW)!;
    expect(one.detail).toContain("(3 days; its blocker is done, so nothing keeps it blocked)");
    const two = blockedCheck([{ ...issue(5, 3), closedBlockers: 2 }, issue(6, 4)], 2, NOW)!;
    expect(two.detail).toContain("PAR-6 \"Blocked thing 6\" (4 days), PAR-5 \"Blocked thing 5\" (3 days; its 2 blockers are done, so nothing keeps it blocked)");
    // the line is about the three ways out the host honours: an unblock descriptor, a blocker issue, or a question to the owner
    expect(one.detail).toContain("no unblock owner, no blocker issue and no question to the owner");
    expect(one.fix).toBe("Give each one a way out: an unblock owner and action on the issue, a blocker issue, or a question to the owner. If nothing is left to wait for, set it back to todo or cancel it with a reason.");
    // zero closed blockers adds nothing to the line
    expect(blockedCheck([{ ...issue(7, 3), closedBlockers: 0 }], 1, NOW)!.detail).not.toContain("blocker is done");
  });
});

describe("blocked on an agent that cannot act", () => {
  const dead = (n: number, daysAgo: number, why: string, name: string | null = "Developer") => ({
    id: `d-${n}`,
    identifier: `PAR-${n}`,
    title: `Waiting thing ${n}`,
    since: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(),
    ownerAgentId: `agent-${n}`,
    ownerName: name,
    why,
  });

  it("is nothing when every named owner can act", () => {
    expect(blockedOwnerCheck([], 0, NOW)).toBeNull();
  });

  it("names each issue, how long, who it waits on and why that agent cannot act, oldest first", () => {
    const check = blockedOwnerCheck([dead(8, 2, "paused"), dead(3, 6, "removed", null), dead(9, 1.5, "in error", "Writer")], 7, NOW)!;
    expect(check).toMatchObject({ key: "blocked-owner-cannot-act", title: "7 blocked issues wait on an agent that cannot act", status: "warn", href: "/issues/PAR-3", since: dead(3, 6, "removed").since });
    expect(check.detail).toBe('Each names who must unblock it, but that agent is removed, paused or in error, so the way out leads nowhere: PAR-3 "Waiting thing 3" (6 days, waits on an agent, removed), PAR-8 "Waiting thing 8" (2 days, waits on Developer, paused), PAR-9 "Waiting thing 9" (36 h, waits on Writer, in error) and 4 more.');
    expect(check.fix).toContain("unblockDescriptor");
  });

  it("says issue in the singular", () => {
    expect(blockedOwnerCheck([dead(1, 2, "paused")], 1, NOW)!.title).toBe("1 blocked issue waits on an agent that cannot act");
  });
});

describe("stalled in progress", () => {
  const stalled = (n: number, hoursSinceUpdate: number, lastRunHoursAgo: number | null, assigneeAgentId = "seo") => ({
    id: `s-${n}`,
    identifier: `PAR-${n}`,
    title: `Working on ${n}`,
    assigneeAgentId,
    updatedAt: new Date(NOW.getTime() - hoursSinceUpdate * 3_600_000).toISOString(),
    lastRunAt: lastRunHoursAgo === null ? null : new Date(NOW.getTime() - lastRunHoursAgo * 3_600_000).toISOString(),
  });

  it("is nothing when nothing is stalled", () => {
    expect(stalledCheck([], 0, agents, NOW)).toBeNull();
  });

  it("names the assignee and how long it has been quiet, longest stall first", () => {
    const check = stalledCheck([stalled(2, 20, 15), stalled(1, 40, 30, "dev"), stalled(3, 14, null)], 3, agents, NOW)!;
    expect(check).toMatchObject({ key: "stalled-in-progress", title: "3 issues are in progress with nobody working on them", status: "warn", href: "/issues/PAR-1" });
    expect(check.detail).toBe('The idle assignee has had no run for more than 12 hours: PAR-1 "Working on 1" (Developer, last run 30 hours ago), PAR-2 "Working on 2" (SEO Specialist, last run 15 hours ago), PAR-3 "Working on 3" (SEO Specialist, never ran).');
    // The stall began at the later of the last update and the last run.
    expect(check.since).toBe(new Date(NOW.getTime() - 30 * 3_600_000).toISOString());
  });

  it("says it in the singular and counts what it does not name", () => {
    expect(stalledCheck([stalled(9, 20, 13)], 1, agents, NOW)!.title).toBe("1 issue is in progress with nobody working on it");
    const many = Array.from({ length: 7 }, (_, i) => stalled(i + 1, 20 + i, 13 + i));
    expect(stalledCheck(many, 7, agents, NOW)!.detail).toContain("and 2 more");
  });
});

describe("helpers", () => {
  it("labels ages in hours then days", () => {
    expect(ageLabel("2026-10-03T11:30:00.000Z", NOW)).toBe("1 h");
    expect(ageLabel("2026-10-02T00:00:00.000Z", NOW)).toBe("36 h");
    expect(ageLabel("2026-09-28T12:00:00.000Z", NOW)).toBe("5 days");
  });

  it("says plainly when a rule could not read its rows", () => {
    const check = unreadableCheck("blocked", "blocked issues", "relation public.issue_relations is not whitelisted\nfor this plugin");
    expect(check).toMatchObject({ key: "watch-unreadable:blocked", title: "The Cockpit could not check blocked issues", status: "warn" });
    expect(check.detail).toBe("Reading blocked issues failed: relation public.issue_relations is not whitelisted for this plugin");
    expect(check.fix).toContain("Upgrade");
  });
});
