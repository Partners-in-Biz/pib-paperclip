/**
 * PAR-11229: when the plugin call has ended, the company read is refused. The
 * health refresh then touches nothing (it used to read the tracked issue as
 * gone, delete the record and leave the issue open, or open a second issue).
 */
import { describe, expect, it, vi } from "vitest";
import { credentialsCheck } from "../src/credentials.js";
import { saveHealthIssue } from "../src/db.js";
import { healthAlerts, refreshHealthIssue } from "../src/health.js";
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
