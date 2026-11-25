/** PAR-11230: the health refresh adopts an open issue with its origin instead of creating a second one. */
import { describe, expect, it, vi } from "vitest";
import { getHealthIssue } from "../src/db.js";
import { refreshHealthIssue } from "../src/health.js";
import { ORIGIN, ORIGIN_ID } from "../src/constants.js";
import { createEnv } from "../src/register.js";
import { saveTeam } from "../src/roles.js";
import { fakeCtx, fixedClock } from "./helpers/fake-ctx.js";

vi.mock("../src/checks.js", async (original) => ({ ...(await original<typeof import("../src/checks.js")>()), extraChecks: async () => ({ health: [], kpis: [], quality: [], waiting: [] }) }));
vi.mock("../src/credentials-seed.js", async (original) => ({ ...(await original<typeof import("../src/credentials-seed.js")>()), CLIENT_CREDENTIAL_TEMPLATE: [] }));

const A = "company-a";
const NOW = "2026-09-26T10:00:00.000Z";
const bad = () => ({ entries: [{ key: "x", title: "X", status: "bad" as const, plugin: "p", pluginTitle: "P" }], keys: ["p:x"] });

async function setup() {
  const fake = fakeCtx({ savedConfigs: { [A]: { healthIssue: true } }, prefixes: { [A]: "PIB" } });
  const env = createEnv(fake.ctx, fixedClock(NOW).now);
  await saveTeam(env, A, {}, "user-1");
  const seed = (id: string, status: string, createdAt: string) =>
    fake.issues.set(id, { id, identifier: id, companyId: A, title: "old", description: "", status, originKind: ORIGIN.health, originId: `${ORIGIN_ID.health}${A}`, createdAt, updatedAt: createdAt } as never);
  return { ...fake, env, seed };
}

describe("health issue adoption by origin", () => {
  it("adopts the issue a failed save left behind", async () => {
    const s = await setup();
    const ctx = s.ctx as unknown as { db: { execute: (sql: string, params?: unknown[]) => Promise<unknown> } };
    const execute = ctx.db.execute.bind(ctx.db);
    let fail = true;
    ctx.db.execute = async (sql, params) => {
      if (fail && /INSERT/i.test(sql) && /health_issues/.test(sql)) throw new Error("save failed");
      return execute(sql, params);
    };
    await expect(refreshHealthIssue(s.env, A, bad())).rejects.toThrow("save failed");
    expect(s.issues.size).toBe(1);
    fail = false;
    const result = await refreshHealthIssue(s.env, A, bad());
    expect(result.action).toBe("updated");
    expect(s.issues.size).toBe(1);
    expect((await getHealthIssue(s.ctx, A))?.issueId).toBe([...s.issues.keys()][0]);
  });

  it("creates a new issue when the only one with the origin is done", async () => {
    const s = await setup();
    s.seed("old-done", "done", "2026-01-01T00:00:00.000Z");
    const result = await refreshHealthIssue(s.env, A, bad());
    expect(result.action).toBe("created");
    expect(s.issues.size).toBe(2);
  });

  it("adopts the oldest of several open issues and creates none", async () => {
    const s = await setup();
    s.seed("newer", "todo", "2026-03-01T00:00:00.000Z");
    s.seed("older", "todo", "2026-02-01T00:00:00.000Z");
    const result = await refreshHealthIssue(s.env, A, bad());
    expect(result).toMatchObject({ action: "updated", issueId: "older" });
    expect(s.issues.size).toBe(2);
    expect((await getHealthIssue(s.ctx, A))?.issueId).toBe("older");
  });

  it("creates as before when the list throws", async () => {
    const s = await setup();
    (s.ctx as unknown as { issues: { list: () => Promise<never> } }).issues.list = async () => {
      throw new Error("refused");
    };
    const result = await refreshHealthIssue(s.env, A, bad());
    expect(result.action).toBe("created");
    expect(s.issues.size).toBe(1);
  });
});
