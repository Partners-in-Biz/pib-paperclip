import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { decisionsMigration } from "@partnersinbiz/pib-plugin-kit";
import { NAMESPACE } from "../src/namespace.js";
import { createEnv, type Actor } from "../src/service/common.js";
import { addKeywords, discoverKeywordsTool } from "../src/service/data.js";
import { classifyIntents, INTENT_CONCURRENCY } from "../src/service/intent.js";
import { validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./helpers/sql-guard.js";

type Row = Record<string, unknown>;

const SPRINT: Row = {
  id: "sp-1", company_id: "co-1", name: "Acme", site_url: "https://acme.co.za", site_name: "Acme Plumbing", client_ref: null, client_name: null,
  status: "active", start_date: "2026-09-01", template_id: "outrank-90", template_version: 2, autopilot_mode: "safe", owner_user_id: "user-1",
  project_id: "proj-1", root_issue_id: "root-1", root_issue_identifier: "PIB-1", agent_id: "agent-1", notes: null, paused_reason: null,
  health: {}, scoreboard: {}, today: {}, current_day: 25, current_week: 4, current_phase: 1, last_daily_on: null, last_weekly_on: null,
  audit_days_done: [0], seeded_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
};

const agent: Actor = { kind: "agent", agentId: "agent-1", runId: null, responsibleUserId: null };

/** Jev answers per keyword: [choice, confidence]. */
type Answers = Record<string, [string, number]>;

function host(options: { jev?: boolean; answers?: Answers; suggestions?: string[] } = {}) {
  const executes: Array<{ sql: string; params: unknown[] }> = [];
  const jevStates: unknown[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://suggestqueries.google.com")) {
      const q = new URL(url).searchParams.get("q") ?? "";
      const list = q === "plumber" ? options.suggestions ?? [] : [];
      return new Response(JSON.stringify([q, list]), { status: 200 });
    }
    if (url === "https://api.typesafe.ai/v1/systemone") {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      const body = JSON.parse(String(init?.body)) as { state: { keyword: string } };
      jevStates.push(body.state);
      const [choice, confidence] = options.answers?.[body.state.keyword] ?? ["solution", 0.9];
      return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { intent: { type: "choice", choice, probabilities: { [choice]: confidence }, confidence } } }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
  const ctx = {
    db: {
      namespace: NAMESPACE,
      async query(sql: string, params: unknown[] = []) {
        validateRuntimeQuery(sql, NAMESPACE, ["heartbeat_runs"]);
        validateParams(sql, params);
        if (/FROM \S+\.sprints WHERE id = \$1/.test(sql)) return [SPRINT];
        return [];
      },
      async execute(sql: string, params: unknown[] = []) {
        validateRuntimeExecute(sql, NAMESPACE);
        validateParams(sql, params);
        executes.push({ sql, params });
        return { rowCount: 1 };
      },
    },
    config: { get: vi.fn(async () => (options.jev === false ? { timezone: "Africa/Johannesburg" } : { timezone: "Africa/Johannesburg", jev: { apiKey: "test-key" } })) },
    secrets: { resolve: vi.fn(async () => "unused") },
    companies: { get: vi.fn(async () => ({ id: "co-1", issuePrefix: "PIB" })) },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    skills: { managed: { reconcile: vi.fn(), reset: vi.fn() } },
  } as unknown as PluginContext;
  const env = createEnv(ctx, { now: () => new Date("2026-09-26T08:00:00Z"), fetch: fetchMock as never, site: vi.fn() as never });
  const jevCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("typesafe")).length;
  return { env, executes, jevStates, jevCalls, maxInFlight: () => maxInFlight };
}

describe("keyword intent migration", () => {
  it("adds the kit decisions table", () => {
    const sql = readFileSync(new URL("../migrations/011_seo.sql", import.meta.url), "utf8");
    expect(sql).toContain(decisionsMigration(NAMESPACE).trim());
  });
});

describe("keyword intent with Jev", () => {
  it("classifies in parallel batches of 8 with only the phrase and site name", async () => {
    const { env, jevStates, maxInFlight, executes } = host();
    const items = Array.from({ length: 20 }, (_, i) => ({ phrase: `plumber ${i}`, fallback: "solution" as const }));
    const results = await classifyIntents(env, "co-1", items, { siteName: "Acme Plumbing", sprintId: "sp-1" });
    expect(results).toHaveLength(20);
    expect(results.every((result) => result.source === "jev")).toBe(true);
    expect(INTENT_CONCURRENCY).toBe(8);
    expect(maxInFlight()).toBeLessThanOrEqual(8);
    expect(maxInFlight()).toBeGreaterThan(1);
    expect(jevStates).toHaveLength(20);
    for (const state of jevStates) expect(Object.keys(state as object).sort()).toEqual(["keyword", "site"]);
    expect(jevStates[0]).toEqual({ keyword: "plumber 0", site: "Acme Plumbing" });
    const logged = executes.filter((call) => /INSERT INTO \S+\.decisions/.test(call.sql));
    expect(logged).toHaveLength(20);
    expect(logged[0]!.params).toContain("seo.keyword-intent");
    expect(executes.filter((call) => /SET acted = true/.test(call.sql))).toHaveLength(20);
  });

  it("discover-keywords uses Jev when sure and keeps the word-rule guess below the update threshold", async () => {
    const { env } = host({
      suggestions: ["plumber near me", "how to fix a leaking tap", "acme plumbing reviews"],
      answers: {
        "plumber near me": ["problem", 0.95],
        "how to fix a leaking tap": ["solution", 0.6],
        "acme plumbing reviews": ["brand", 0.88],
      },
    });
    const result = await discoverKeywordsTool(env, "co-1", { seeds: ["plumber"], sprintId: "sp-1", limit: 50 });
    const byPhrase = new Map(result.candidates.map((candidate) => [candidate.phrase, candidate]));
    expect(byPhrase.get("plumber near me")).toMatchObject({ intent: "problem", intentSource: "jev" });
    // 0.6 < 0.7: the regex guess stays.
    expect(byPhrase.get("how to fix a leaking tap")).toMatchObject({ intent: "problem", intentSource: "rules" });
    expect(byPhrase.get("acme plumbing reviews")).toMatchObject({ intent: "brand", intentSource: "jev" });
    expect(result.note).toMatch(/Jev/);
  });

  it("falls back to the word rules without a key", async () => {
    const { env, jevCalls } = host({ jev: false, suggestions: ["how to unblock a drain", "plumber prices"] });
    const result = await discoverKeywordsTool(env, "co-1", { seeds: ["plumber"], limit: 50 });
    expect(jevCalls()).toBe(0);
    expect(result.candidates.every((candidate) => candidate.intentSource === "rules")).toBe(true);
    expect(result.candidates.find((candidate) => candidate.phrase === "how to unblock a drain")!.intent).toBe("problem");
  });

  it("add-keywords asks Jev only for keywords without an intent", async () => {
    const { env, jevStates, executes } = host({ answers: { "emergency plumber": ["solution", 0.93], "why is my geyser leaking": ["problem", 0.5] } });
    const result = await addKeywords(env, "co-1", agent, {
      sprintId: "sp-1",
      keywords: [{ phrase: "emergency plumber" }, { phrase: "why is my geyser leaking" }, { phrase: "acme plumbing", intent: "brand" }],
    });
    expect(jevStates.map((state) => (state as { keyword: string }).keyword).sort()).toEqual(["emergency plumber", "why is my geyser leaking"]);
    expect(result.keywords).toEqual([
      expect.objectContaining({ phrase: "emergency plumber", intent: "solution", intentSource: "jev" }),
      expect.objectContaining({ phrase: "why is my geyser leaking", intent: "problem", intentSource: "rules" }),
      expect.objectContaining({ phrase: "acme plumbing", intent: "brand" }),
    ]);
    const inserts = executes.filter((call) => /INSERT INTO \S+\.keywords/.test(call.sql));
    expect(inserts.map((call) => call.params[5])).toEqual(["solution", "problem", "brand"]);
  });

  it("keeps the rules when Jev fails", async () => {
    const { env } = host();
    (env as { fetch: unknown }).fetch = vi.fn(async () => new Response("unauthorised", { status: 401 }));
    const results = await classifyIntents(env, "co-1", [{ phrase: "plumber", fallback: "solution" }], { siteName: null, sprintId: null });
    expect(results).toEqual([{ intent: "solution", source: "rules", confidence: null }]);
  });
});
