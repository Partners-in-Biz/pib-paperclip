/**
 * PAR-11229: when the plugin call has ended, the company read is refused. The
 * health refresh then touches nothing (it used to read the tracked issue as
 * gone, delete the record and leave the issue open, or open a second issue).
 */
import { describe, expect, it, vi } from "vitest";
import { credentialsCheck } from "../src/credentials.js";
import { formatIncompleteParts, OWN_CHECKS_INCOMPLETE_KEY } from "../src/checks.js";
import { PLUGIN_KEY } from "../src/constants.js";
import { getHealthIssue, saveHealthIssue } from "../src/db.js";
import { healthResult } from "../src/done-checks.js";
import { collectProblems, healthAlerts, ownIncompleteParts, refreshHealthIssue, trackWarnings, type Problems } from "../src/health.js";
import type { CockpitSnapshot, HealthEntry } from "../src/merge.js";
import { createEnv, registerCockpit } from "../src/register.js";
import { saveTeam } from "../src/roles.js";
import { fakeCtx, fixedClock } from "./helpers/fake-ctx.js";

vi.mock("../src/checks.js", async (original) => ({ ...(await original<typeof import("../src/checks.js")>()), extraChecks: async () => ({ health: [], kpis: [], quality: [], waiting: [] }) }));

// The fake db has no credentials table; the seed rows are not what is tested here.
vi.mock("../src/credentials-seed.js", async (original) => ({ ...(await original<typeof import("../src/credentials-seed.js")>()), CLIENT_CREDENTIAL_TEMPLATE: [] }));

const A = "company-a";
const NOW = "2026-09-26T10:00:00.000Z";

async function setup() {
  const fake = fakeCtx({ savedConfigs: { [A]: { healthIssue: true } }, prefixes: { [A]: "PIB" } });
  const env = createEnv(fake.ctx, fixedClock(NOW).now);
  await saveTeam(env, A, {}, "user-1");
  const seen: string[] = [];
  const ctx = fake.ctx as unknown as {
    companies: { get: (id: string) => Promise<unknown> };
    issues: Record<string, (...args: unknown[]) => Promise<unknown>>;
    db: { execute: (sql: string, params?: unknown[]) => Promise<unknown> };
  };
  for (const name of ["get", "update", "create", "createComment"]) {
    const original = ctx.issues[name]!;
    ctx.issues[name] = async (...args) => {
      seen.push(`issues.${name}`);
      return original(...args);
    };
  }
  const execute = ctx.db.execute.bind(ctx.db);
  ctx.db.execute = async (sql, params) => {
    if (/DELETE/i.test(sql) && /health_issues/.test(sql)) seen.push("DELETE health_issues");
    return execute(sql, params);
  };
  const readable = ctx.companies.get;
  const refuse = () => {
    ctx.companies.get = async () => {
      throw new Error("plugin call has ended");
    };
  };
  const allow = () => {
    ctx.companies.get = readable;
  };
  return { ...fake, env, seen, refuse, allow };
}

const badSnapshot = () => ({ entries: [{ key: "x", title: "X", status: "bad" as const, plugin: "p", pluginTitle: "P" }], keys: ["p:x"] });

describe("health refresh without a readable company", () => {
  it("returns kept and touches nothing", async () => {
    const s = await setup();
    await saveHealthIssue(s.ctx, { companyId: A, issueId: "tracked", fingerprint: "f", problemKeys: [] }, NOW);
    s.refuse();
    s.seen.length = 0;
    for (const problems of [undefined, badSnapshot(), { entries: [], keys: [] }]) {
      const result = await refreshHealthIssue(s.env, A, problems);
      expect(result).toEqual({ action: "kept", reason: "company not readable", issueId: null });
    }
    expect(s.seen).toEqual([]);
    expect(s.issues.size).toBe(0);
    expect(s.updates).toEqual([]);
    expect(s.comments).toEqual([]);
  });

  it("keeps the stored record when nothing is found and the company read rejects", async () => {
    const s = await setup();
    await saveHealthIssue(s.ctx, { companyId: A, issueId: "tracked", fingerprint: "f", problemKeys: [] }, NOW);
    s.refuse();
    await refreshHealthIssue(s.env, A);
    expect(s.store.health_issues).toHaveLength(1);
  });

  it("behaves as before when the read succeeds: prefix in links, create then unchanged", async () => {
    const s = await setup();
    const created = await refreshHealthIssue(s.env, A, { entries: [{ key: "x", title: "X", status: "bad", plugin: "p", pluginTitle: "P", href: "/billing" }], keys: ["p:x"] });
    expect(created).toMatchObject({ action: "created", problems: 1 });
    expect([...s.issues.values()][0]!.description).toContain("[Open](/PIB/billing)");
    expect(await refreshHealthIssue(s.env, A, { entries: [{ key: "x", title: "X", status: "bad", plugin: "p", pluginTitle: "P", href: "/billing" }], keys: ["p:x"] })).toMatchObject({ action: "unchanged" });
  });

  it("reaches the four callers without an error", async () => {
    const s = await setup();
    registerCockpit(s.ctx, s.env);
    s.refuse();
    // Hourly job
    await expect(healthAlerts(s.env)).resolves.toMatchObject({ kept: 1 });
    // cockpit.refresh-health
    await expect(s.actions.get("cockpit.refresh-health")!({}, { companyId: A, actor: { type: "user", userId: "user-1" } })).resolves.toMatchObject({ action: "kept" });
    // cockpit.save-team
    s.allow();
    const refuseAfterSave = vi.spyOn(s.ctx.companies, "get");
    refuseAfterSave.mockRejectedValue(new Error("plugin call has ended"));
    await expect(s.actions.get("cockpit.save-team")!({}, { companyId: A, actor: { type: "user", userId: "user-1" } })).resolves.toMatchObject({ health: "kept" });
    // Credentials job
    s.refuse();
    const logged: string[] = [];
    (s.ctx.logger as { info: (...a: unknown[]) => void }).info = (...a) => void logged.push(String(a[0]));
    await expect(credentialsCheck(s.env)).resolves.toMatchObject({ companies: 1 });
    expect(logged.filter((line) => /health refresh failed/i.test(line))).toEqual([]);
    expect(s.seen).toEqual([]);
  });
});

/**
 * PAR-11233: a run whose own checks did not all finish never closes the issue,
 * forgets a warning's first-seen time, or counts a returning problem as new.
 */
const entry = (key: string): HealthEntry => ({ key, title: key.toUpperCase(), status: "bad", plugin: "p", pluginTitle: "P" });
const problems = (keys: string[], ownIncomplete?: string[]): Problems => ({ entries: keys.map(entry), keys: keys.map((k) => `p:${k}`), ...(ownIncomplete ? { ownIncomplete } : {}) });
const SENTENCE = "Some checks did not finish this time: goals. Problems they find are not in this update.";
const own = (detail: string | null): CockpitSnapshot =>
  ({ plugin: PLUGIN_KEY, title: "Cockpit", checkedAt: NOW, kpis: [], waiting: [], activity: [], quality: [], health: [{ key: OWN_CHECKS_INCOMPLETE_KEY, title: "Cockpit checks incomplete", status: "warn", detail }] }) as unknown as CockpitSnapshot;
const other = (health: Array<{ key: string; status: "bad" | "warn"; title: string }>): CockpitSnapshot =>
  ({ plugin: "partnersinbiz.billing", title: "Billing", checkedAt: NOW, kpis: [], waiting: [], activity: [], quality: [], health }) as unknown as CockpitSnapshot;

async function withOperator() {
  const fake = fakeCtx({ savedConfigs: { [A]: { healthIssue: true } }, prefixes: { [A]: "PIB" }, agents: [{ id: "op", companyId: A, name: "Operator", status: "idle" }] });
  const env = createEnv(fake.ctx, fixedClock(NOW).now);
  await saveTeam(env, A, { operatorAgentId: "op" }, "user-1");
  return { ...fake, env };
}

describe("an incomplete run (own checks did not all finish)", () => {
  it("reads the parts from the own row and fails closed when none parse", () => {
    expect(ownIncompleteParts([own(formatIncompleteParts(["goals", "watch"]))])).toEqual(["goals", "watch"]);
    expect(ownIncompleteParts([own("something else entirely")])).toEqual(["unknown"]);
    expect(ownIncompleteParts([own(null)])).toEqual(["unknown"]);
    expect(ownIncompleteParts([other([{ key: OWN_CHECKS_INCOMPLETE_KEY, status: "warn", title: "x" }])])).toBeNull();
    expect(ownIncompleteParts([])).toBeNull();
  });

  it("keeps first-seen rows when incomplete and deletes them as before when complete", async () => {
    const s = await withOperator();
    await trackWarnings(s.env, A, ["p:gone"], "2026-09-20T00:00:00.000Z");
    const base = { agents: [], listeningSince: null, trackWarnings: true };
    const incomplete = await collectProblems(s.env, A, { ...base, snapshots: [own("unreadable")] });
    expect(incomplete.ownIncomplete).toEqual(["unknown"]);
    expect((s.store.health_warnings ?? []).map((row) => row.key)).toContain("p:gone");
    const complete = await collectProblems(s.env, A, { ...base, snapshots: [] });
    expect(complete.ownIncomplete).toBeUndefined();
    expect(s.store.health_warnings ?? []).toEqual([]);
  });

  it("an unparseable own row: no close, no first-seen delete", async () => {
    const s = await withOperator();
    await refreshHealthIssue(s.env, A, problems(["x"]));
    await trackWarnings(s.env, A, ["p:gone"], "2026-09-20T00:00:00.000Z");
    const found = await collectProblems(s.env, A, { agents: [], listeningSince: null, trackWarnings: true, snapshots: [own("??")] });
    expect(await refreshHealthIssue(s.env, A, found)).toMatchObject({ action: "kept" });
    expect([...s.issues.values()][0]!.status).not.toBe("done");
    expect((s.store.health_warnings ?? []).map((row) => row.key)).toContain("p:gone");
  });

  it("empty with an open issue: kept, not closed, no comment, record kept", async () => {
    const s = await withOperator();
    const created = await refreshHealthIssue(s.env, A, problems(["x"]));
    const issueId = (created as { issueId: string }).issueId;
    const before = await getHealthIssue(s.ctx, A);
    s.updates.length = 0;
    const result = await refreshHealthIssue(s.env, A, problems([], ["goals"]));
    expect(result).toEqual({ action: "kept", reason: "checks incomplete", issueId });
    expect(s.issues.get(issueId)!.status).not.toBe("done");
    expect(s.updates).toEqual([]);
    expect(s.comments).toEqual([]);
    expect(await getHealthIssue(s.ctx, A)).toEqual(before);
    // A complete empty run closes it as before.
    expect(await refreshHealthIssue(s.env, A, problems([]))).toMatchObject({ action: "closed" });
  });

  it("with content: the sentence is added, and a problem of the unfinished part that returns does not wake", async () => {
    const s = await withOperator();
    await refreshHealthIssue(s.env, A, problems(["x", "y"]));
    const issueId = [...s.issues.keys()][0]!;
    const wakes = s.wakeups.length;
    expect(await refreshHealthIssue(s.env, A, problems(["x"], ["goals"]))).toMatchObject({ action: "updated" });
    expect(s.issues.get(issueId)!.description).toContain(SENTENCE);
    expect((await getHealthIssue(s.ctx, A))?.problemKeys.sort()).toEqual(["p:x", "p:y"]);
    // Complete again with y back: updated (sentence gone), not new, no wake.
    expect(await refreshHealthIssue(s.env, A, problems(["x", "y"]))).toMatchObject({ action: "updated" });
    expect(s.issues.get(issueId)!.description).not.toContain("did not finish");
    expect(s.wakeups.length).toBe(wakes);
  });

  it("with content, then a complete run with the same problems: updated, not unchanged", async () => {
    const s = await withOperator();
    await refreshHealthIssue(s.env, A, problems(["x"], ["goals"]));
    const issueId = [...s.issues.keys()][0]!;
    expect(s.issues.get(issueId)!.description).toContain(SENTENCE);
    expect(await refreshHealthIssue(s.env, A, problems(["x"]))).toMatchObject({ action: "updated" });
    expect(s.issues.get(issueId)!.description).not.toContain("did not finish");
    expect(await refreshHealthIssue(s.env, A, problems(["x"]))).toMatchObject({ action: "unchanged" });
  });

  it("with content and no open issue: one issue is created, with the sentence", async () => {
    const s = await withOperator();
    expect(await refreshHealthIssue(s.env, A, problems(["x"], ["goals"]))).toMatchObject({ action: "created", problems: 1 });
    expect(s.issues.size).toBe(1);
    expect([...s.issues.values()][0]!.description).toContain(SENTENCE);
    expect((await getHealthIssue(s.ctx, A))?.problemKeys).toEqual(["p:x"]);
  });

  it("update succeeds and the record save throws: the next run updates once more and wakes at most once", async () => {
    const s = await withOperator();
    await refreshHealthIssue(s.env, A, problems(["x"]));
    const wakes = s.wakeups.length;
    const ctx = s.ctx as unknown as { db: { execute: (sql: string, params?: unknown[]) => Promise<unknown> } };
    const execute = ctx.db.execute.bind(ctx.db);
    let fail = true;
    ctx.db.execute = async (sql, params) => {
      if (fail && /INSERT/i.test(sql) && /health_issues/.test(sql)) throw new Error("save failed");
      return execute(sql, params);
    };
    await expect(refreshHealthIssue(s.env, A, problems(["x", "z"], ["goals"]))).rejects.toThrow("save failed");
    expect(s.wakeups.length).toBe(wakes);
    fail = false;
    expect(await refreshHealthIssue(s.env, A, problems(["x", "z"], ["goals"]))).toMatchObject({ action: "updated" });
    expect(await refreshHealthIssue(s.env, A, problems(["x", "z"], ["goals"]))).toMatchObject({ action: "unchanged" });
    expect(s.wakeups.length - wakes).toBeLessThanOrEqual(1);
  });

  it("leaves the done-check result unchanged", async () => {
    const s = await withOperator();
    const bad = other([{ key: "outbox", status: "bad", title: "Deliveries" }]);
    const base = { agents: [], listeningSince: null };
    const complete = await collectProblems(s.env, A, { ...base, snapshots: [bad] });
    const incomplete = await collectProblems(s.env, A, { ...base, snapshots: [bad, own(formatIncompleteParts(["goals"]))] });
    expect(incomplete.ownIncomplete).toEqual(["goals"]);
    expect(healthResult(incomplete.entries)).toEqual(healthResult(complete.entries));
    expect(healthResult((await collectProblems(s.env, A, { ...base, snapshots: [own(formatIncompleteParts(["goals"]))] })).entries)).toEqual({ done: true });
  });
});
