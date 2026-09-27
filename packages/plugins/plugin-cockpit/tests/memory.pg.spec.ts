/**
 * Company memory end to end against a real Postgres with the host SQL rules:
 * tools as agents call them, Jev via a fake TypeSafe endpoint.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import { NAMESPACE } from "../src/namespace.js";
import { clearMemoryJevCache } from "../src/memory/jev.js";
import { harvestComment, onCommentCreated, upkeep } from "../src/memory/service.js";
import * as store from "../src/memory/store.js";
import { runMemoryTool } from "../src/memory/tools.js";
import { SELECTION } from "../src/memory/engine.js";
import { COMPANY, OTHER_COMPANY, embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const RUN: ToolRunContext = { agentId: "agent-seo", runId: "run-1", companyId: COMPANY, projectId: "p1" };

d("company memory (Postgres)", () => {
  let h: PgHarness;
  const tool = async (name: string, params: Record<string, unknown>, run: ToolRunContext = RUN) => {
    const result = (await runMemoryTool(h.env, name, params, run)) as { content: string; data: any; error?: string };
    return result;
  };
  const add = (params: Record<string, unknown>, run?: ToolRunContext) => tool("memory-add", params, run);
  const recall = (params: Record<string, unknown>, run?: ToolRunContext) => tool("memory-recall", params, run);

  beforeAll(async () => {
    h = await startPg();
  }, 120_000);
  afterAll(async () => {
    await h?.stop();
  });
  beforeEach(async () => {
    await h.reset();
    clearMemoryJevCache();
  });

  async function seedNorthwind() {
    h.addIssue({ id: "i-old", identifier: "PIB-9", title: "[Northwind] Set up the blog", originKind: "plugin:partnersinbiz.seo" });
    const facts = [
      { text: "Northwind blog posts use British spelling and a friendly tone.", kind: "preference" },
      { text: "Northwind's site runs on WordPress; changes deploy through WP Engine staging first.", kind: "fact" },
      { text: "Northwind pays invoices on the 25th of each month.", kind: "fact", area: "billing" },
    ];
    for (const f of facts) {
      const r = await add({ ...f, client: "company:nw", clientName: "Northwind", issueId: "PIB-9" });
      expect(r.error).toBeUndefined();
    }
    const acme = await add({ text: "Acme wants all posts approved by their marketing lead first.", client: "company:ac", clientName: "Acme", area: "social", kind: "rule" });
    expect(acme.error).toBeUndefined();
    const wide = await add({ text: "Never publish anything on Sundays.", client: "own", kind: "rule", pinned: true, area: "general" });
    expect(wide.error).toBeUndefined();
  }

  it("adds facts and gives a task only its client's and company-wide facts (baseline, no Jev key)", async () => {
    await seedNorthwind();
    h.addIssue({ id: "i-new", identifier: "PIB-20", title: "[Northwind] Write the October blog post", description: "Draft and publish the blog post about winter menus.", originKind: "plugin:partnersinbiz.seo" });
    const brief = await recall({ issueId: "PIB-20" });
    expect(brief.error).toBeUndefined();
    expect(brief.data.method).toBe("baseline");
    const texts: string[] = brief.data.facts.map((f: { text: string }) => f.text);
    expect(texts[0]).toBe("Never publish anything on Sundays.");
    expect(texts).toContain("Northwind blog posts use British spelling and a friendly tone.");
    expect(texts.some((t) => t.startsWith("Acme"))).toBe(false);
    expect(brief.data.client.refs).toEqual(["company:nw"]);
    expect(brief.content).toContain("Memory brief for PIB-20");
    expect(brief.content).toContain("picked by keyword and recency");
    // Usage is counted.
    const used = await store.getFacts(h.ctx, COMPANY, brief.data.facts.map((f: { id: string }) => f.id));
    expect(used.every((f) => f.useCount === 1)).toBe(true);
  });

  it("reuses a brief for the same issue and agent until a fact changes", async () => {
    await seedNorthwind();
    h.addIssue({ id: "i-new", identifier: "PIB-20", title: "[Northwind] Blog post", originKind: "plugin:partnersinbiz.seo" });
    const first = await recall({ issueId: "i-new" });
    const second = await recall({ issueId: "PIB-20" });
    expect(second.data.cached).toBe(true);
    expect(second.data.briefId).toBe(first.data.briefId);
    await add({ text: "Northwind wants every blog post to end with a booking link.", client: "company:nw", issueId: "PIB-20" });
    const third = await recall({ issueId: "PIB-20" });
    expect(third.data.cached).toBe(false);
    expect(third.data.facts.map((f: { text: string }) => f.text)).toContain("Northwind wants every blog post to end with a booking link.");
    const otherAgent = await recall({ issueId: "PIB-20" }, { ...RUN, agentId: "agent-social" });
    expect(otherAgent.data.cached).toBe(false);
  });

  it("uses Jev to keep only what the task needs, and logs the baseline for comparison", async () => {
    await seedNorthwind();
    h.config.set(COMPANY, { jev: { apiKey: "ts-key" } });
    h.setJev((state, questions) => {
      const facts = (state as { facts?: Record<string, string> }).facts ?? {};
      return Object.fromEntries(Object.keys(questions).map((k) => [k, { type: "noul", noul: /blog|tone|spelling/i.test(facts[k] ?? "") ? 0.92 : 0.05 }]));
    });
    h.addIssue({ id: "i-new", identifier: "PIB-21", title: "[Northwind] Write the October blog post", originKind: "plugin:partnersinbiz.seo" });
    const brief = await recall({ issueId: "PIB-21" });
    expect(brief.data.method).toBe("jev");
    expect(brief.data.facts.map((f: { text: string }) => f.text)).toEqual([
      "Never publish anything on Sundays.", // pinned rules are always in
      "Northwind blog posts use British spelling and a friendly tone.",
    ]);
    const call = h.fetchCalls.at(-1)!;
    expect(JSON.stringify(call.state)).not.toContain("Acme"); // other clients' facts never leave the server
    const row = await store.getBrief(h.ctx, COMPANY, brief.data.briefId);
    expect(row!.method).toBe("jev");
    expect(row!.model).toBe("jev-1.13.0");
    expect(row!.jevInputTokens).toBe(1234);
    expect(row!.baselineIds.length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(row!.scores).length).toBeGreaterThan(0);
  });

  it("falls back to the baseline when Jev is down", async () => {
    await seedNorthwind();
    h.config.set(COMPANY, { jev: { apiKey: "ts-key" } });
    h.setJev(null); // 503
    h.addIssue({ id: "i-new", identifier: "PIB-22", title: "[Northwind] Blog post", originKind: "plugin:partnersinbiz.seo" });
    const brief = await recall({ issueId: "PIB-22" });
    expect(brief.error).toBeUndefined();
    expect(brief.data.method).toBe("baseline");
    expect(brief.data.facts.length).toBeGreaterThan(0);
  });

  it("lets Jev pick the client when the task text does not name one", async () => {
    await seedNorthwind();
    h.config.set(COMPANY, { jev: { apiKey: "ts-key" } });
    h.setJev((_state, questions) => {
      if (questions.client) return { client: { type: "choice", choice: "c1", probabilities: { c1: 0.9 }, confidence: 0.9 } };
      return Object.fromEntries(Object.keys(questions).map((k) => [k, { type: "noul", noul: 0.8 }]));
    });
    h.addIssue({ id: "i-x", identifier: "PIB-23", title: "Fix the meta descriptions on the menu pages", originKind: "plugin:partnersinbiz.seo" });
    const known = await store.knownClients(h.ctx, COMPANY);
    const brief = await recall({ issueId: "PIB-23" });
    expect(brief.data.client.how).toBe("jev");
    expect(brief.data.client.refs).toEqual([known[0]!.clientRef]);
  });

  it("caps a brief at 12 facts and ~1,500 tokens however much is stored", async () => {
    for (let i = 0; i < 40; i += 1) {
      const r = await add({ text: `Northwind blog note ${i}: keep paragraphs short and add one image per section, variant ${i}.`, client: "company:nw", clientName: "Northwind", area: "seo" });
      expect(r.error).toBeUndefined();
    }
    h.addIssue({ id: "i-b", identifier: "PIB-30", title: "[Northwind] Blog post", originKind: "plugin:partnersinbiz.seo" });
    const brief = await recall({ issueId: "PIB-30" });
    expect(brief.data.facts.length).toBeLessThanOrEqual(12);
    expect(brief.data.tokens).toBeLessThanOrEqual(1500);
    expect(brief.data.totalFacts).toBe(40);
  });

  it("refuses secrets, overlong facts and unknown clients", async () => {
    const secret = await add({ text: "The WordPress admin password: Winter2026!", client: "own" });
    expect(secret.error).toContain("password");
    const long = await add({ text: "x".repeat(301), client: "own" });
    expect(long.error).toContain("at most 300");
    const unknown = await add({ text: "Some client fact that matters.", client: "Globex" });
    expect(unknown.error).toContain("Unknown client");
    const nameless = await add({ text: "Some client fact that matters.", client: "company:new" });
    expect(nameless.error).toContain("clientName is required");
  });

  it("detects duplicates exactly and (with Jev) by meaning, and flags conflicts", async () => {
    const first = await add({ text: "Northwind prefers posts at 09:00 SAST.", client: "company:nw", clientName: "Northwind", area: "social" });
    const again = await add({ text: "northwind prefers posts at 09:00 SAST", client: "company:nw", area: "social" });
    expect(again.data.status).toBe("duplicate");
    expect(again.data.id).toBe(first.data.id);

    h.config.set(COMPANY, { jev: { apiKey: "ts-key" } });
    h.setJev((_state, questions) => Object.fromEntries(Object.keys(questions).map((k) => [k, { type: "noul", noul: k.startsWith("same") ? 0.95 : 0.1 }])));
    const same = await add({ text: "Northwind prefers their posts at 09:00 SAST.", client: "company:nw", area: "social" });
    expect(same.data.status).toBe("duplicate");

    clearMemoryJevCache();
    h.setJev((_state, questions) => Object.fromEntries(Object.keys(questions).map((k) => [k, { type: "noul", noul: k.startsWith("conflict") ? 0.9 : 0.1 }])));
    const changed = await add({ text: "Northwind now prefers posts at 17:00 SAST.", client: "company:nw", area: "social" });
    expect(changed.data.status).toBe("added");
    expect(changed.content).toContain("may contradict");
    expect(changed.data.similar[0].relation).toBe("conflict");
  });

  it("supersedes an old fact so briefs only carry the new one", async () => {
    const old = await add({ text: "Northwind prefers posts at 09:00 SAST.", client: "company:nw", clientName: "Northwind", area: "social" });
    const next = await add({ text: "Northwind now prefers posts at 17:00 SAST.", client: "company:nw", area: "social", supersedes: old.data.id });
    expect(next.data.superseded).toBe(old.data.id);
    const oldRow = await store.getFact(h.ctx, COMPANY, old.data.id);
    expect(oldRow!.status).toBe("superseded");
    expect(oldRow!.supersededBy).toBe(next.data.id);
    const brief = await recall({ query: "When should Northwind posts go out?", client: "company:nw" });
    const ids = brief.data.facts.map((f: { id: string }) => f.id);
    expect(ids).toContain(next.data.id);
    expect(ids).not.toContain(old.data.id);
  });

  it("takes the client from the issue when the agent forgets it", async () => {
    await add({ text: "Northwind's brand colour is forest green.", client: "company:nw", clientName: "Northwind", area: "social" });
    h.addIssue({ id: "i-s", identifier: "PIB-40", title: "[Northwind] Instagram carousel", originKind: "plugin:partnersinbiz.social" });
    const r = await add({ text: "Northwind carousels do best with 5 slides.", issueId: "PIB-40", kind: "lesson" });
    expect(r.data.fact.clientRef).toBe("company:nw");
    expect(r.data.fact.area).toBe("social");
    expect(r.data.fact.sourceIdentifier).toBe("PIB-40");
    expect(r.content).toContain("taken from the issue");
  });

  it("limits pinned rules per client and area", async () => {
    for (let i = 0; i < 5; i += 1) {
      const r = await add({ text: `Rule number ${i} for Northwind social posts.`, client: "company:nw", clientName: "Northwind", area: "social", kind: "rule", pinned: true });
      expect(r.data.fact.pinned).toBe(true);
    }
    const sixth = await add({ text: "Rule number six for Northwind social posts.", client: "company:nw", area: "social", kind: "rule", pinned: true });
    expect(sixth.data.fact.pinned).toBe(false);
    expect(sixth.content).toContain("already has 5 pinned");
    const fact = await add({ text: "A plain fact cannot be pinned at all.", client: "own", pinned: true });
    expect(fact.data.fact.pinned).toBe(false);
  });

  it("updates, archives and restores facts", async () => {
    const r = await add({ text: "Northwind closes for the holidays.", client: "company:nw", clientName: "Northwind" });
    const id = r.data.id;
    expect((await tool("memory-update", { id, text: "Northwind closes 15 Dec to 5 Jan.", expiresAt: "2099-01-06" })).error).toBeUndefined();
    const updated = await store.getFact(h.ctx, COMPANY, id);
    expect(updated!.text).toBe("Northwind closes 15 Dec to 5 Jan.");
    expect(updated!.expiresAt).toContain("2099-01-06");
    expect((await tool("memory-update", { id, pinned: true })).error).toContain("Only rules and warnings");
    expect((await tool("memory-update", { id, status: "archived" })).error).toBeUndefined();
    expect((await store.getFact(h.ctx, COMPANY, id))!.status).toBe("archived");
    expect((await tool("memory-update", { id, status: "active" })).error).toBeUndefined();
    expect((await tool("memory-update", { id: "m-nope", text: "x" })).error).toContain("No fact");
  });

  it("records feedback, bumps counters and says whether the baseline would have caught a miss", async () => {
    await seedNorthwind();
    h.addIssue({ id: "i-f", identifier: "PIB-50", title: "[Northwind] Monthly invoice", originKind: "plugin:partnersinbiz.billing" });
    const brief = await recall({ issueId: "PIB-50" });
    const inBrief: string[] = brief.data.facts.map((f: { id: string }) => f.id);
    const all = await store.listFacts(h.ctx, COMPANY, { status: "active", limit: 50, offset: 0 });
    const notInBrief = all.facts.find((f) => !inBrief.includes(f.id) && f.clientRef === "company:nw")!;
    const fb = await tool("memory-feedback", { briefId: brief.data.briefId, noise: [inBrief[0]], missing: [notInBrief.id], missingText: "How Northwind wants invoices addressed" });
    expect(fb.data.recorded).toBe(3);
    expect((await store.getFact(h.ctx, COMPANY, inBrief[0]!))!.noiseCount).toBe(1);
    expect((await store.getFact(h.ctx, COMPANY, notInBrief.id))!.helpfulCount).toBe(1);
    const stats = await store.memoryStats(h.ctx, COMPANY);
    expect(stats.feedback30d.noise).toBe(1);
    expect(stats.feedback30d.missing).toBe(2);
    expect(stats.feedback30d.missingInBaseline + stats.feedback30d.missingNotInBaseline).toBe(1);
    expect((await tool("memory-feedback", { briefId: brief.data.briefId })).error).toContain("Say what was missing");
  });

  it("searches with a cap and never shows other companies' facts", async () => {
    await seedNorthwind();
    await add({ text: "Other company's secret sauce recipe is private.", client: "own" }, { ...RUN, companyId: OTHER_COMPANY });
    const found = await tool("memory-search", { query: "WordPress deploy staging" });
    expect(found.data.facts[0].text).toContain("WordPress");
    const other = await tool("memory-search", { query: "secret sauce recipe" });
    expect(other.data.facts).toHaveLength(0);
  });

  it("keeps scopes under their cap and archives expired facts in daily upkeep", async () => {
    await add({ text: "Holiday closure notice for the office.", client: "own" });
    await h.client.query(`UPDATE ${NAMESPACE}.memory_facts SET expires_at = now() - interval '1 day'`);
    const values: string[] = [];
    for (let i = 0; i < SELECTION.scopeActiveCap + 5; i += 1) {
      values.push(`('cap-${i}', '${COMPANY}', 'company:nw', 'Northwind', 'seo', 'fact', 'Cap fact ${i}', 'hash-${i}', ${i < 3 ? "true" : "false"}, now() - interval '${i} days')`);
    }
    await h.client.query(`INSERT INTO ${NAMESPACE}.memory_facts (id, company_id, client_ref, client_name, area, kind, text, text_hash, pinned, updated_at) VALUES ${values.join(", ")}`);
    const result = await upkeep(h.env);
    expect(result.expired).toBe(1);
    expect(result.archived).toBe(5);
    const stats = await store.memoryStats(h.ctx, COMPANY);
    expect(stats.facts.active).toBe(SELECTION.scopeActiveCap);
    const pinned = await store.listFacts(h.ctx, COMPANY, { status: "active", pinned: true, limit: 10, offset: 0 });
    expect(pinned.total).toBe(3); // pinned facts are never archived
  });

  it("reviews memory for the Operator: duplicates, noise, stats", async () => {
    await add({ text: "Blog posts for Northwind must use British spelling.", client: "company:nw", clientName: "Northwind", area: "seo" });
    await add({ text: "Northwind blog posts must use British spelling always.", client: "company:nw", area: "seo" });
    const review = await tool("memory-review", {});
    expect(review.error).toBeUndefined();
    expect(review.data.duplicates.length).toBe(1);
    expect(review.data.stats.facts.active).toBe(2);
    expect(review.content).toContain("2 active facts");
  });

  it("gives a clear message when there is nothing to recall, and validates input", async () => {
    h.addIssue({ id: "i-e", identifier: "PIB-60", title: "Anything" });
    const empty = await recall({ issueId: "PIB-60" });
    expect(empty.data.method).toBe("empty");
    expect(empty.content).toContain("no stored facts yet");
    expect((await recall({})).error).toContain("Pass issueId");
    expect((await recall({ issueId: "PIB-404" })).error).toContain("not found");
  });

  it("measures how often each agent starts a run with memory", async () => {
    const agent = "aaaaaaaa-0000-0000-0000-000000000001";
    const runs = ["bbbbbbbb-0000-0000-0000-000000000001", "bbbbbbbb-0000-0000-0000-000000000002", "bbbbbbbb-0000-0000-0000-000000000003"];
    for (const id of runs) await h.client.query(`INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at) VALUES ($1, $2, $3, 'succeeded', now() - interval '1 hour')`, [id, COMPANY, agent]);
    await add({ text: "Northwind site runs on WordPress.", client: "company:nw", clientName: "Northwind" });
    h.addIssue({ id: "i-c", identifier: "PIB-70", title: "[Northwind] Update plugins" });
    await recall({ issueId: "PIB-70" }, { ...RUN, agentId: agent, runId: runs[0]! });
    const coverage = await store.recallCoverage(h.ctx, COMPANY);
    expect(coverage).toEqual([{ agentId: agent, runs: 3, withBrief: 1 }]);
    const review = await tool("memory-review", {});
    expect(review.data.agentsSkippingMemory).toEqual([{ agentId: agent, runs: 3, withBrief: 1 }]);
    expect(review.content).toContain("started most runs without memory-recall");
  });

  it("saves Learned lines from a closing comment for the issue's client and area", async () => {
    await add({ text: "Northwind's site runs on WordPress.", client: "company:nw", clientName: "Northwind", area: "seo" });
    h.addIssue({ id: "i-h", identifier: "PIB-80", title: "[Northwind] Publish the winter menu post", originKind: "plugin:partnersinbiz.seo" });
    h.comments.push({
      id: "c-1",
      companyId: COMPANY,
      issueId: "i-h",
      authorAgentId: "agent-seo",
      authorUserId: null,
      createdByRunId: "run-9",
      body: [
        "Published and checked on production.",
        "",
        "**Learned:**",
        "- Northwind wants a booking link at the end of every post.",
        "- Rule: never publish on public holidays.",
        "- The admin password: Winter2026! works for staging.",
        "- Northwind's site runs on WordPress.",
      ].join("\n"),
    });
    const result = await harvestComment(h.env, COMPANY, { issueId: "i-h", commentId: "c-1", authorAgentId: "agent-seo", authorUserId: null });
    expect(result.saved.map((s) => s.text)).toEqual(["Northwind wants a booking link at the end of every post.", "Never publish on public holidays."]);
    expect(result.duplicates).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toContain("password");
    const saved = await store.getFacts(h.ctx, COMPANY, result.saved.map((s) => s.id));
    for (const fact of saved) {
      expect(fact.clientRef).toBe("company:nw");
      expect(fact.area).toBe("seo");
      expect(fact.origin).toBe("harvest");
      expect(fact.sourceCommentId).toBe("c-1");
      expect(fact.sourceIdentifier).toBe("PIB-80");
      expect(fact.createdByAgentId).toBe("agent-seo");
    }
    expect(saved.find((f) => f.text.startsWith("Never"))!.kind).toBe("rule");
    expect(saved.find((f) => f.text.startsWith("Northwind wants"))!.kind).toBe("lesson");
    // Reading the same comment again changes nothing (and does not inflate usefulness).
    const again = await harvestComment(h.env, COMPANY, { issueId: "i-h", commentId: "c-1", authorAgentId: "agent-seo", authorUserId: null });
    expect(again.saved).toHaveLength(0);
    expect(again.duplicates).toBe(3);
    const wordpress = (await store.listFacts(h.ctx, COMPANY, { status: "active", q: "WordPress", limit: 5, offset: 0 })).facts[0]!;
    expect(wordpress.helpfulCount).toBe(0);
    // The next task for Northwind gets them in its brief.
    h.addIssue({ id: "i-n", identifier: "PIB-81", title: "[Northwind] Write the spring post", originKind: "plugin:partnersinbiz.seo" });
    const brief = await recall({ issueId: "PIB-81" });
    expect(brief.data.facts.map((f: { text: string }) => f.text)).toContain("Northwind wants a booking link at the end of every post.");
    const stats = await store.memoryStats(h.ctx, COMPANY);
    expect(stats.harvested7d).toBe(2);
  });

  it("ignores comments without a Learned label and company-wide lessons stay company-wide", async () => {
    h.addIssue({ id: "i-o", identifier: "PIB-90", title: "Tidy the routines" });
    h.comments.push({ id: "c-2", companyId: COMPANY, issueId: "i-o", authorAgentId: "agent-op", authorUserId: null, body: "Done. Paused the duplicate routine." });
    expect(await harvestComment(h.env, COMPANY, { issueId: "i-o", commentId: "c-2", authorAgentId: "agent-op", authorUserId: null })).toEqual({ saved: [], duplicates: 0, skipped: [] });
    h.comments.push({ id: "c-3", companyId: COMPANY, issueId: "i-o", authorAgentId: null, authorUserId: "user-peet", body: "Learned: routines should always have a named owner." });
    const byPerson = await harvestComment(h.env, COMPANY, { issueId: "i-o", commentId: "c-3", authorAgentId: null, authorUserId: "user-peet" });
    expect(byPerson.saved).toHaveLength(1);
    const fact = (await store.getFact(h.ctx, COMPANY, byPerson.saved[0]!.id))!;
    expect(fact.clientRef).toBeNull();
    expect(fact.createdByUserId).toBe("user-peet");
    expect(await harvestComment(h.env, COMPANY, { issueId: "i-o", commentId: "missing", authorAgentId: null, authorUserId: null })).toEqual({ saved: [], duplicates: 0, skipped: [] });
  });

  it("handles the host's comment event: agents and people yes, plugins and system no", async () => {
    h.addIssue({ id: "i-ev", identifier: "PIB-95", title: "Update the invoice template", originKind: "plugin:partnersinbiz.billing" });
    h.comments.push({ id: "c-ev", companyId: COMPANY, issueId: "i-ev", authorAgentId: "agent-books", authorUserId: null, body: "Done.\n\n**Learned:** the invoice template needs the VAT number in the footer." });
    const base = { companyId: COMPANY, entityType: "issue", entityId: "i-ev", payload: { commentId: "c-ev", bodySnippet: "Done.", identifier: "PIB-95", agentId: "agent-books" } } as const;
    expect((await onCommentCreated(h.env, { ...base, actorType: "plugin", actorId: "partnersinbiz.cockpit" })).saved).toHaveLength(0);
    expect((await onCommentCreated(h.env, { ...base, actorType: "system", actorId: "system" })).saved).toHaveLength(0);
    expect((await onCommentCreated(h.env, { ...base, entityType: "project" as never, actorType: "agent", actorId: "agent-books" })).saved).toHaveLength(0);
    const result = await onCommentCreated(h.env, { ...base, actorType: "agent", actorId: "agent-books" });
    expect(result.saved).toHaveLength(1);
    const fact = (await store.getFact(h.ctx, COMPANY, result.saved[0]!.id))!;
    expect(fact.area).toBe("billing");
    expect(fact.createdByAgentId).toBe("agent-books");
    expect(fact.origin).toBe("harvest");
  });

  it("unpins a rule when its kind changes to one that cannot be pinned", async () => {
    const rule = await add({ text: "Never merge on Fridays without green checks.", client: "own", kind: "rule", pinned: true });
    expect(rule.data.fact.pinned).toBe(true);
    const changed = await tool("memory-update", { id: rule.data.id, kind: "lesson" });
    expect(changed.error).toBeUndefined();
    expect((await store.getFact(h.ctx, COMPANY, rule.data.id))!.pinned).toBe(false);
  });
});

