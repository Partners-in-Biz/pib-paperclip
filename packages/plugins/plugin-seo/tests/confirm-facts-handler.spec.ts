/**
 * Handler tests for confirmClientFacts: verify all say-wordings still appear on their source pages,
 * then lock the sheet. Tests cover all validation, fetch failure, CAS race, concurrency, and
 * interaction with setClientFacts.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { readFileSync } from "fs";
import { resolve } from "path";
import { NAMESPACE } from "../src/namespace.js";
import { createEnv, type Actor } from "../src/service/common.js";
import { confirmClientFacts, setClientFacts } from "../src/service/facts.js";
import { normalizeVisibleText } from "../src/service/page-text.js";
import type { ClientFact } from "../src/engine/claims.js";

// Mock safeFetch before importing anything that uses it
vi.mock("@partnersinbiz/pib-plugin-kit", async (importOriginal) => {
  const original = await importOriginal<typeof import("@partnersinbiz/pib-plugin-kit")>();
  return {
    ...original,
    safeFetch: vi.fn(),
  };
});

import * as kit from "@partnersinbiz/pib-plugin-kit";

type Row = Record<string, unknown>;

const SPRINT: Row = {
  id: "sp-1",
  company_id: "co-1",
  name: "Acme",
  site_url: "https://acme.co.za",
  site_name: "Acme",
  client_ref: null,
  client_name: "Acme Ltd",
  status: "active",
  start_date: "2026-09-01",
  template_id: "outrank-90",
  template_version: 2,
  autopilot_mode: "safe",
  owner_user_id: "user-1",
  project_id: "proj-1",
  root_issue_id: "root-1",
  root_issue_identifier: "PIB-1",
  agent_id: "agent-1",
  site_access: "wordpress",
  site_id: "site-1",
  change_policy: "pr_only",
  notes: null,
  paused_reason: null,
  health: {},
  scoreboard: {},
  today: {},
  current_day: 25,
  current_week: 4,
  current_phase: 1,
  last_daily_on: null,
  last_weekly_on: null,
  audit_days_done: [0],
  seeded_at: "2026-09-01T00:00:00Z",
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
};

const agent: Actor = { kind: "agent", agentId: "agent-1", runId: "run-1", responsibleUserId: "user-1" };
const user: Actor = { kind: "user", userId: "user-peet" };

// Read faq.html fixture and normalize it
const faqFixtureHtml = readFileSync(resolve("tests/fixtures/faq.html"), "utf-8");
const faqNormalizedText = normalizeVisibleText(faqFixtureHtml);

interface ClientFactsStore {
  sprintId: string;
  facts: ClientFact[];
  status: "draft" | "confirmed";
  updated_by: string | null;
  updated_at: string;
}

/**
 * A fake DB that implements real CAS semantics for client_facts:
 * - UPDATE checks facts match exactly (jsonb deep-equal)
 * - INSERT ... ON CONFLICT applies EXCLUDED values
 * - SELECT returns only requested columns
 * - Tracks every execute for assertions
 */
function createHost() {
  const store = new Map<string, ClientFactsStore>();
  const executes: Array<{ sql: string; params: unknown[] }> = [];

  const ctx = {
    db: {
      namespace: NAMESPACE,
      async query(sql: string, params: unknown[] = []) {
        // getSprint
        if (/FROM plugin_seo_8099f8879a\.sprints WHERE id = \$1 AND company_id = \$2/.test(sql)) {
          if (String(params[0]) === "sp-1" && String(params[1]) === "co-1") return [SPRINT];
          return [];
        }
        // client_facts SELECT
        if (/FROM plugin_seo_8099f8879a\.client_facts WHERE sprint_id = \$1 AND company_id = \$2/.test(sql)) {
          const row = store.get(String(params[0]));
          if (!row) return [];
          // Parse column list from SELECT
          const selectMatch = sql.match(/SELECT\s+(.+?)\s+FROM/i);
          if (!selectMatch) return [row];
          const cols = selectMatch[1].split(",").map((c) => c.trim());
          const result: Record<string, unknown> = {};
          for (const col of cols) {
            if (col === "facts") result.facts = row.facts;
            else if (col === "status") result.status = row.status;
            else if (col === "updated_at") result.updated_at = row.updated_at;
          }
          return [result];
        }
        return [];
      },

      async execute(sql: string, params: unknown[] = []) {
        executes.push({ sql, params });

        // INSERT ... ON CONFLICT ... DO UPDATE
        if (/INSERT INTO plugin_seo_8099f8879a\.client_facts/.test(sql)) {
          const sprintId = String(params[0]);
          const companyId = String(params[1]);
          const facts = typeof params[2] === "string" ? JSON.parse(params[2]) : params[2];
          const status = String(params[3]) as "draft" | "confirmed";
          const updated_by = String(params[4]);
          const now = new Date().toISOString();

          store.set(sprintId, { sprintId, facts, status, updated_by, updated_at: now });
          return { rowCount: 1 };
        }

        // UPDATE with CAS: check both status='draft' AND facts match
        if (/UPDATE plugin_seo_8099f8879a\.client_facts SET status = 'confirmed'/.test(sql)) {
          const sprintId = String(params[1]);
          const companyId = String(params[2]);
          const rawJsonb = params[3];
          const updated_by = String(params[0]);

          const row = store.get(sprintId);
          if (!row) return { rowCount: 0 };

          // CAS: check both status is 'draft' AND facts match
          if (row.status !== "draft") {
            return { rowCount: 0 }; // Row already confirmed or in other state
          }

          const storedFacts = JSON.stringify(row.facts);
          const rawFacts = typeof rawJsonb === "string" ? rawJsonb : JSON.stringify(rawJsonb);

          if (storedFacts !== rawFacts) {
            return { rowCount: 0 }; // CAS failed: facts changed
          }

          // CAS succeeded
          const now = new Date().toISOString();
          store.set(sprintId, { ...row, status: "confirmed", updated_by, updated_at: now });
          return { rowCount: 1 };
        }

        return { rowCount: 1 };
      },
    },
    config: { get: vi.fn(async () => ({})) },
    companies: { get: vi.fn(async () => ({ id: "co-1", issuePrefix: "PAR" })) },
    state: { get: vi.fn(async () => null), set: vi.fn() },
    issues: { create: vi.fn(async () => ({ id: "rev-1" })), createComment: vi.fn(), requestWakeup: vi.fn(), update: vi.fn() },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  } as unknown as PluginContext;

  return { store, executes, ctx };
}

describe("confirmClientFacts handler", () => {
  beforeEach(() => {
    vi.mocked(kit.safeFetch).mockClear();
  });

  describe("case 1: all say-wordings match", () => {
    it("confirms sheet, sets status=confirmed, returns confirmed:true with checkedUrls and wordingsHash", async () => {
      const { store, executes, ctx } = createHost();
      const wordings: ClientFact[] = [
        {
          kind: "say",
          text: "We deliver within 5 business days.",
          source: "https://acme.co.za/faq",
        },
        {
          kind: "say",
          text: "Refunds are processed within 14 days after cancellation.",
          source: "https://acme.co.za/faq",
        },
      ];

      // Set up draft sheet
      store.set("sp-1", {
        sprintId: "sp-1",
        facts: wordings,
        status: "draft",
        updated_by: "user-peet",
        updated_at: "2026-10-01T10:00:00Z",
      });

      // Mock safeFetch to return the fixture
      vi.mocked(kit.safeFetch).mockResolvedValue({
        status: 200,
        url: "https://acme.co.za/faq",
        redirects: [],
        headers: { "content-type": "text/html; charset=utf-8" },
        text: faqFixtureHtml,
        ms: 50,
      });

      const env = createEnv(ctx, { now: () => new Date("2026-10-02T12:00:00Z") });
      const result = await confirmClientFacts(env, "co-1", agent, { sprintId: "sp-1" });

      expect(result).toMatchObject({
        sprintId: "sp-1",
        status: "confirmed",
        confirmed: true,
        checked: 2,
      });
      expect(result.checkedUrls).toEqual(["https://acme.co.za/faq"]);
      expect(result.wordingsHash).toMatch(/^[a-f0-9]{64}$/); // SHA256 hex
      expect(result.confirmedBy).toMatchObject({ agentId: "agent-1" });

      // Verify row state
      const row = store.get("sp-1")!;
      expect(row.status).toBe("confirmed");
      expect(row.updated_by).toBe("agent-1");
    });
  });

  describe("case 2: one wording missing from page", () => {
    it("returns draft status with mismatches, row unchanged", async () => {
      const { store, executes, ctx } = createHost();
      const wordings: ClientFact[] = [
        {
          kind: "say",
          text: "We deliver within 5 business days.",
          source: "https://acme.co.za/faq",
        },
        {
          kind: "say",
          text: "This wording does not appear anywhere on the page.",
          source: "https://acme.co.za/faq",
        },
      ];

      store.set("sp-1", {
        sprintId: "sp-1",
        facts: wordings,
        status: "draft",
        updated_by: "user-peet",
        updated_at: "2026-10-01T10:00:00Z",
      });

      vi.mocked(kit.safeFetch).mockResolvedValue({
        status: 200,
        url: "https://acme.co.za/faq",
        redirects: [],
        headers: { "content-type": "text/html" },
        text: faqFixtureHtml,
        ms: 50,
      });

      const env = createEnv(ctx, { now: () => new Date("2026-10-02T12:00:00Z") });
      const result = await confirmClientFacts(env, "co-1", agent, { sprintId: "sp-1" });

      expect(result).toMatchObject({
        sprintId: "sp-1",
        status: "draft",
        confirmed: false,
      });
      expect(result.mismatches).toHaveLength(1);
      expect(result.mismatches![0]!.index).toBe(1);
      expect(result.mismatches![0]!.reason).toBe("cannot verify");

      // Verify row unchanged
      const row = store.get("sp-1")!;
      expect(row.status).toBe("draft");
      expect(row.updated_by).toBe("user-peet");
    });
  });

  describe("case 3: various error conditions", () => {
    it("fetch rejects -> draft status with generic reason, no hostname/status in message", async () => {
      const { store, ctx } = createHost();
      store.set("sp-1", {
        sprintId: "sp-1",
        facts: [
          {
            kind: "say",
            text: "We deliver within 5 business days.",
            source: "https://acme.co.za/faq",
          },
        ],
        status: "draft",
        updated_by: "user-peet",
        updated_at: "2026-10-01T10:00:00Z",
      });

      // Mock rejection with details that must be hidden
      vi.mocked(kit.safeFetch).mockRejectedValue(new Error("Connect timeout: 203.0.113.1:443 took 5000ms"));

      const env = createEnv(ctx, { now: () => new Date("2026-10-02T12:00:00Z") });
      const result = await confirmClientFacts(env, "co-1", agent, { sprintId: "sp-1" });

      expect(result.confirmed).toBe(false);
      expect(result.mismatches).toBeDefined();
      expect(result.mismatches![0]!.reason).toBe("fetch failed");
      // Assertion proves that the IP address is not in the reason
      expect(result.mismatches![0]!.reason).not.toContain("203.0.113.1");
    });

    it("say-fact without source -> throws SeoError, row unchanged, no execute", async () => {
      const { store, executes, ctx } = createHost();
      store.set("sp-1", {
        sprintId: "sp-1",
        facts: [
          {
            kind: "say",
            text: "We deliver within 5 business days.",
            // no source
          } as unknown as ClientFact,
        ],
        status: "draft",
        updated_by: "user-peet",
        updated_at: "2026-10-01T10:00:00Z",
      });

      const env = createEnv(ctx, { now: () => new Date("2026-10-02T12:00:00Z") });

      await expect(confirmClientFacts(env, "co-1", agent, { sprintId: "sp-1" })).rejects.toThrow(/missing source/i);

      // Verify no UPDATE attempted
      const updateCount = executes.filter((e) => /UPDATE.*client_facts/.test(e.sql)).length;
      expect(updateCount).toBe(0);

      const row = store.get("sp-1")!;
      expect(row.status).toBe("draft");
    });

    it("zero say-facts (refused) -> throws SeoError, row unchanged", async () => {
      const { store, executes, ctx } = createHost();
      store.set("sp-1", {
        sprintId: "sp-1",
        facts: [
          { kind: "avoid", text: "never say this" }, // only avoid, no say
        ],
        status: "draft",
        updated_by: "user-peet",
        updated_at: "2026-10-01T10:00:00Z",
      });

      const env = createEnv(ctx, { now: () => new Date("2026-10-02T12:00:00Z") });

      await expect(confirmClientFacts(env, "co-1", agent, { sprintId: "sp-1" })).rejects.toThrow(/no say-facts/i);

      const updateCount = executes.filter((e) => /UPDATE.*client_facts/.test(e.sql)).length;
      expect(updateCount).toBe(0);
    });

    it("wording shorter than 8 chars -> throws SeoError", async () => {
      const { store, executes, ctx } = createHost();
      store.set("sp-1", {
        sprintId: "sp-1",
        facts: [
          {
            kind: "say",
            text: "Short",
            source: "https://acme.co.za/faq",
          },
        ],
        status: "draft",
        updated_by: "user-peet",
        updated_at: "2026-10-01T10:00:00Z",
      });

      const env = createEnv(ctx, { now: () => new Date("2026-10-02T12:00:00Z") });

      await expect(confirmClientFacts(env, "co-1", agent, { sprintId: "sp-1" })).rejects.toThrow(/too short/i);

      const updateCount = executes.filter((e) => /UPDATE.*client_facts/.test(e.sql)).length;
      expect(updateCount).toBe(0);
    });

    it("source on different host -> returns draft with mismatches before fetching", async () => {
      const { store, ctx } = createHost();
      store.set("sp-1", {
        sprintId: "sp-1",
        facts: [
          {
            kind: "say",
            text: "We deliver within 5 business days.",
            source: "https://example.com/other", // different host
          },
        ],
        status: "draft",
        updated_by: "user-peet",
        updated_at: "2026-10-01T10:00:00Z",
      });

      const env = createEnv(ctx, { now: () => new Date("2026-10-02T12:00:00Z") });
      const result = await confirmClientFacts(env, "co-1", agent, { sprintId: "sp-1" });

      expect(result.confirmed).toBe(false);
      expect(result.mismatches).toHaveLength(1);
      expect(result.mismatches![0]!.reason).toBe("source not on client site");

      // safeFetch was not called
      expect(vi.mocked(kit.safeFetch)).not.toHaveBeenCalled();
    });

    it("source http://127.0.0.1/... (off-host) -> returns draft before fetching", async () => {
      const { store, ctx } = createHost();
      store.set("sp-1", {
        sprintId: "sp-1",
        facts: [
          {
            kind: "say",
            text: "We deliver within 5 business days.",
            source: "http://127.0.0.1/internal", // localhost
          },
        ],
        status: "draft",
        updated_by: "user-peet",
        updated_at: "2026-10-01T10:00:00Z",
      });

      const env = createEnv(ctx, { now: () => new Date("2026-10-02T12:00:00Z") });
      const result = await confirmClientFacts(env, "co-1", agent, { sprintId: "sp-1" });

      expect(result.confirmed).toBe(false);
      expect(result.mismatches![0]!.reason).toBe("source not on client site");
      expect(vi.mocked(kit.safeFetch)).not.toHaveBeenCalled();
    });

    it("non-html content-type -> returns draft with generic reason", async () => {
      const { store, ctx } = createHost();
      store.set("sp-1", {
        sprintId: "sp-1",
        facts: [
          {
            kind: "say",
            text: "We deliver within 5 business days.",
            source: "https://acme.co.za/data.json",
          },
        ],
        status: "draft",
        updated_by: "user-peet",
        updated_at: "2026-10-01T10:00:00Z",
      });

      vi.mocked(kit.safeFetch).mockResolvedValue({
        status: 200,
        url: "https://acme.co.za/data.json",
        redirects: [],
        headers: { "content-type": "application/json" },
        text: '{"data":"json"}',
        ms: 50,
      });

      const env = createEnv(ctx, { now: () => new Date("2026-10-02T12:00:00Z") });
      const result = await confirmClientFacts(env, "co-1", agent, { sprintId: "sp-1" });

      expect(result.confirmed).toBe(false);
      expect(result.mismatches![0]!.reason).toBe("not html");
      // Reason should not contain content-type value
      expect(result.mismatches![0]!.reason).not.toContain("application/json");
    });

    it("body over 2MB -> returns draft with mismatches", async () => {
      const { store, ctx } = createHost();
      store.set("sp-1", {
        sprintId: "sp-1",
        facts: [
          {
            kind: "say",
            text: "We deliver within 5 business days.",
            source: "https://acme.co.za/huge",
          },
        ],
        status: "draft",
        updated_by: "user-peet",
        updated_at: "2026-10-01T10:00:00Z",
      });

      // Create a body over 2MB
      const hugeBody = "x".repeat(2_100_000);
      vi.mocked(kit.safeFetch).mockResolvedValue({
        status: 200,
        url: "https://acme.co.za/huge",
        redirects: [],
        headers: { "content-type": "text/html" },
        text: hugeBody,
        ms: 50,
      });

      const env = createEnv(ctx, { now: () => new Date("2026-10-02T12:00:00Z") });
      const result = await confirmClientFacts(env, "co-1", agent, { sprintId: "sp-1" });

      expect(result.confirmed).toBe(false);
      expect(result.mismatches![0]!.reason).toBe("too large");
    });

    it("safeFetch rejecting as redirect to internal address -> returns draft", async () => {
      const { store, ctx } = createHost();
      store.set("sp-1", {
        sprintId: "sp-1",
        facts: [
          {
            kind: "say",
            text: "We deliver within 5 business days.",
            source: "https://acme.co.za/faq",
          },
        ],
        status: "draft",
        updated_by: "user-peet",
        updated_at: "2026-10-01T10:00:00Z",
      });

      // safeFetch rejects with details about the internal redirect
      vi.mocked(kit.safeFetch).mockRejectedValue(
        new Error("Redirect to internal address: 192.168.1.1:8080 (status 302)"),
      );

      const env = createEnv(ctx, { now: () => new Date("2026-10-02T12:00:00Z") });
      const result = await confirmClientFacts(env, "co-1", agent, { sprintId: "sp-1" });

      expect(result.confirmed).toBe(false);
      // reason should be generic, not expose the IP or status
      expect(result.mismatches).toBeDefined();
      expect(result.mismatches![0]!.reason).not.toContain("192.168.1.1");
      expect(result.mismatches![0]!.reason).not.toContain("302");
    });

    it("source on client host redirects to different PUBLIC host -> stays draft, no DB write, reason generic", async () => {
      const { store, executes, ctx } = createHost();
      store.set("sp-1", {
        sprintId: "sp-1",
        facts: [
          {
            kind: "say",
            text: "We deliver within 5 business days.",
            source: "https://acme.co.za/faq",
          },
        ],
        status: "draft",
        updated_by: "user-peet",
        updated_at: "2026-10-01T10:00:00Z",
      });

      // safeFetch returns 200 OK with content that would match,
      // but the final URL is on a different host (attacker.example.net)
      vi.mocked(kit.safeFetch).mockResolvedValue({
        status: 200,
        url: "https://attacker.example.net/faq",
        redirects: [],
        headers: { "content-type": "text/html; charset=utf-8" },
        text: faqFixtureHtml, // Content matches, so host check is the only thing that blocks it
        ms: 50,
      });

      const env = createEnv(ctx, { now: () => new Date("2026-10-02T12:00:00Z") });
      const result = await confirmClientFacts(env, "co-1", agent, { sprintId: "sp-1" });

      expect(result.confirmed).toBe(false);
      expect(result.mismatches).toHaveLength(1);
      expect(result.mismatches![0]!.reason).toBe("source not on client site");
      // Verify the attacker host is not leaked in the JSON
      expect(JSON.stringify(result)).not.toContain("attacker.example.net");
      // Verify source in mismatch is the original URL, not the redirect target
      expect(result.mismatches![0]!.source).toBe("https://acme.co.za/faq");

      // Verify no UPDATE was attempted
      const updateCount = executes.filter((e) => /UPDATE.*client_facts/.test(e.sql)).length;
      expect(updateCount).toBe(0);

      // Verify row is still draft with original author
      const row = store.get("sp-1")!;
      expect(row.status).toBe("draft");
      expect(row.updated_by).toBe("user-peet");
    });

    it("source on client host redirects to same host (http->https or www) -> confirms", async () => {
      const { store, executes, ctx } = createHost();
      store.set("sp-1", {
        sprintId: "sp-1",
        facts: [
          {
            kind: "say",
            text: "We deliver within 5 business days.",
            source: "http://acme.co.za/faq",
          },
          {
            kind: "say",
            text: "Refunds are processed within 14 days after cancellation.",
            source: "http://acme.co.za/faq",
          },
        ],
        status: "draft",
        updated_by: "user-peet",
        updated_at: "2026-10-01T10:00:00Z",
      });

      // safeFetch returns the HTTPS + www version (same host, different scheme/subdomain)
      vi.mocked(kit.safeFetch).mockResolvedValue({
        status: 200,
        url: "https://www.acme.co.za/faq", // Redirected to HTTPS with www
        redirects: [],
        headers: { "content-type": "text/html; charset=utf-8" },
        text: faqFixtureHtml,
        ms: 50,
      });

      const env = createEnv(ctx, { now: () => new Date("2026-10-02T12:00:00Z") });
      const result = await confirmClientFacts(env, "co-1", agent, { sprintId: "sp-1" });

      // Should succeed: www-insensitive comparison allows the redirect
      expect(result.confirmed).toBe(true);
      expect(result.status).toBe("confirmed");
      expect(result.checked).toBe(2);

      // Verify UPDATE was executed
      const updateCount = executes.filter((e) => /UPDATE.*client_facts/.test(e.sql)).length;
      expect(updateCount).toBe(1);

      // Verify row is confirmed
      const row = store.get("sp-1")!;
      expect(row.status).toBe("confirmed");
      expect(row.updated_by).toBe("agent-1");
    });

    it("safeFetch returns empty/unparseable final URL -> returns draft with generic reason", async () => {
      const { store, ctx } = createHost();
      store.set("sp-1", {
        sprintId: "sp-1",
        facts: [
          {
            kind: "say",
            text: "We deliver within 5 business days.",
            source: "https://acme.co.za/faq",
          },
        ],
        status: "draft",
        updated_by: "user-peet",
        updated_at: "2026-10-01T10:00:00Z",
      });

      // safeFetch returns with empty URL (or it could be invalid)
      vi.mocked(kit.safeFetch).mockResolvedValue({
        status: 200,
        url: "", // Empty final URL
        redirects: [],
        headers: { "content-type": "text/html" },
        text: faqFixtureHtml,
        ms: 50,
      });

      const env = createEnv(ctx, { now: () => new Date("2026-10-02T12:00:00Z") });
      const result = await confirmClientFacts(env, "co-1", agent, { sprintId: "sp-1" });

      expect(result.confirmed).toBe(false);
      expect(result.mismatches).toHaveLength(1);
      expect(result.mismatches![0]!.reason).toBe("source not on client site");
    });
  });

  describe("case 4: CAS race (facts modified during fetch)", () => {
    it("returns confirmed:false with 'sheet changed, retry' when facts change inside fetch", async () => {
      const { store, ctx } = createHost();
      const initialWordings: ClientFact[] = [
        {
          kind: "say",
          text: "We deliver within 5 business days.",
          source: "https://acme.co.za/faq",
        },
      ];

      store.set("sp-1", {
        sprintId: "sp-1",
        facts: initialWordings,
        status: "draft",
        updated_by: "user-peet",
        updated_at: "2026-10-01T10:00:00Z",
      });

      // During safeFetch, person edits facts (simulated by setClientFacts)
      vi.mocked(kit.safeFetch).mockImplementation(async () => {
        // Simulate person edit while fetching
        await setClientFacts(
          createEnv(ctx),
          "co-1",
          user,
          {
            sprintId: "sp-1",
            text: "+ Different wording now | https://acme.co.za/faq\n",
            confirm: false,
          },
        );

        return {
          status: 200,
          url: "https://acme.co.za/faq",
          redirects: [],
          headers: { "content-type": "text/html" },
          text: faqFixtureHtml,
          ms: 50,
        };
      });

      const env = createEnv(ctx, { now: () => new Date("2026-10-02T12:00:00Z") });
      const result = await confirmClientFacts(env, "co-1", agent, { sprintId: "sp-1" });

      expect(result.confirmed).toBe(false);
      expect(result.reason).toBe("sheet changed, retry");

      // Verify row was NOT confirmed
      const row = store.get("sp-1")!;
      expect(row.status).toBe("draft");
    });
  });

  describe("case 5: concurrent confirmClientFacts calls", () => {
    it("row confirmed once; neither throws; second gets 'sheet changed'", async () => {
      const { store, ctx } = createHost();
      const wordings: ClientFact[] = [
        {
          kind: "say",
          text: "We deliver within 5 business days.",
          source: "https://acme.co.za/faq",
        },
      ];

      store.set("sp-1", {
        sprintId: "sp-1",
        facts: wordings,
        status: "draft",
        updated_by: "user-peet",
        updated_at: "2026-10-01T10:00:00Z",
      });

      vi.mocked(kit.safeFetch).mockResolvedValue({
        status: 200,
        url: "https://acme.co.za/faq",
        redirects: [],
        headers: { "content-type": "text/html" },
        text: faqFixtureHtml,
        ms: 50,
      });

      const env = createEnv(ctx, { now: () => new Date("2026-10-02T12:00:00Z") });

      // Call concurrently
      const [result1, result2] = await Promise.all([
        confirmClientFacts(env, "co-1", agent, { sprintId: "sp-1" }),
        confirmClientFacts(env, "co-1", agent, { sprintId: "sp-1" }),
      ]);

      // Exactly one succeeds (first one to acquire the lock wins)
      const successCount = [result1.confirmed, result2.confirmed].filter(Boolean).length;
      expect(successCount).toBe(1);

      // The loser gets 'sheet changed, retry' OR returns mismatches (edge case where both hit UPDATE)
      if (!result1.confirmed) {
        expect(result1.reason || result1.mismatches).toBeDefined();
        if (result1.reason) expect(result1.reason).toBe("sheet changed, retry");
      }
      if (!result2.confirmed) {
        expect(result2.reason || result2.mismatches).toBeDefined();
        if (result2.reason) expect(result2.reason).toBe("sheet changed, retry");
      }

      // Row is confirmed
      const row = store.get("sp-1")!;
      expect(row.status).toBe("confirmed");
    });
  });

  describe("case 6: already confirmed sheet", () => {
    it("returns as-is with confirmed:true, no UPDATE (updated_at unchanged)", async () => {
      const { store, executes, ctx } = createHost();
      const wordings: ClientFact[] = [
        {
          kind: "say",
          text: "We deliver within 5 business days.",
          source: "https://acme.co.za/faq",
        },
      ];

      const originalUpdatedAt = "2026-10-01T10:00:00Z";
      store.set("sp-1", {
        sprintId: "sp-1",
        facts: wordings,
        status: "confirmed",
        updated_by: "agent-1",
        updated_at: originalUpdatedAt,
      });

      const env = createEnv(ctx, { now: () => new Date("2026-10-02T12:00:00Z") });
      const result = await confirmClientFacts(env, "co-1", agent, { sprintId: "sp-1" });

      expect(result.confirmed).toBe(true);
      expect(result.status).toBe("confirmed");

      // updated_at should match the original (not now())
      expect(result.confirmedAt).toBe(originalUpdatedAt);

      // Verify no UPDATE happened
      const updateCount = executes.filter((e) => /UPDATE.*client_facts/.test(e.sql)).length;
      expect(updateCount).toBe(0);

      // Row state unchanged
      const row = store.get("sp-1")!;
      expect(row.updated_at).toBe(originalUpdatedAt);
    });
  });

  describe("case 7: setClientFacts overwrites after agent confirms", () => {
    it("agent confirms, then person edits with new wordings -> status back to draft, updated_by overwritten", async () => {
      const { store, ctx } = createHost();
      const initialWordings: ClientFact[] = [
        {
          kind: "say",
          text: "We deliver within 5 business days.",
          source: "https://acme.co.za/faq",
        },
      ];

      store.set("sp-1", {
        sprintId: "sp-1",
        facts: initialWordings,
        status: "draft",
        updated_by: "user-peet",
        updated_at: "2026-10-01T10:00:00Z",
      });

      vi.mocked(kit.safeFetch).mockResolvedValue({
        status: 200,
        url: "https://acme.co.za/faq",
        redirects: [],
        headers: { "content-type": "text/html" },
        text: faqFixtureHtml,
        ms: 50,
      });

      const env = createEnv(ctx, { now: () => new Date("2026-10-02T12:00:00Z") });

      // Agent confirms
      const confirmResult = await confirmClientFacts(env, "co-1", agent, { sprintId: "sp-1" });
      expect(confirmResult.confirmed).toBe(true);

      let row = store.get("sp-1")!;
      expect(row.status).toBe("confirmed");
      expect(row.updated_by).toBe("agent-1");

      // Person edits with new wordings (without confirm=true)
      await setClientFacts(
        env,
        "co-1",
        user,
        {
          sprintId: "sp-1",
          text: "+ Refunds are processed within 14 days after cancellation. | https://acme.co.za/faq\n",
          confirm: false,
        },
      );

      // Status should revert to draft, updated_by should change to user
      row = store.get("sp-1")!;
      expect(row.status).toBe("draft");
      expect(row.updated_by).toBe("user-peet");
    });
  });

  describe("case 8: 20s timeout on parallel fetches", () => {
    it("enforces 20s budget on all fetches combined and returns fetch failed when exceeded", async () => {
      const { store, ctx } = createHost();
      const wordings: ClientFact[] = [
        {
          kind: "say",
          text: "We deliver within 5 business days.",
          source: "https://acme.co.za/page1",
        },
      ];

      store.set("sp-1", {
        sprintId: "sp-1",
        facts: wordings,
        status: "draft",
        updated_by: "user-peet",
        updated_at: "2026-10-01T10:00:00Z",
      });

      // Mock safeFetch to never resolve, simulating hung requests
      vi.mocked(kit.safeFetch).mockImplementation(async () => {
        return new Promise(() => {}); // Never resolves
      });

      const env = createEnv(ctx, { now: () => new Date("2026-10-02T12:00:00Z") });

      // Start the confirm, which should timeout after 20s and return fetch failed
      const startTime = Date.now();
      const result = await confirmClientFacts(env, "co-1", agent, { sprintId: "sp-1" });
      const elapsed = Date.now() - startTime;

      // With the fix, result should have fetch failed reason
      expect(result).toMatchObject({
        sprintId: "sp-1",
        status: "draft",
        confirmed: false,
        mismatches: expect.arrayContaining([
          expect.objectContaining({
            reason: "fetch failed",
          }),
        ]),
      });

      // Verify it took approximately 20 seconds (give or take a couple seconds for overhead)
      expect(elapsed).toBeGreaterThanOrEqual(19_000);
      expect(elapsed).toBeLessThan(22_000);
    }, 25_000); // Give the test 25s timeout to accommodate the 20s internal deadline plus overhead
  });
});
