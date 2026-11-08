/**
 * Reviewer findings (W1c H1): a finding recorded twice by hash is one row; only the author-side agent or the
 * owner sets the outcome (never the reviewer); everything is company-scoped; the migration is additive.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import { REVIEW_FINDING_TOOLS } from "../src/review-finding-declarations.js";
import { setFindingOutcome } from "../src/review-findings.js";
import { currentRoles, saveTeam } from "../src/roles.js";
import { COMPANY, OTHER_COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds, type Hybrid } from "./helpers/hybrid.js";
import { splitSqlStatements, validateMigrationStatement } from "./helpers/sql-guard.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const A = COMPANY;
const B = OTHER_COMPANY;
const REVIEWER = "aaaaaaaa-0000-4000-8000-0000000000c1";
const DEV = "aaaaaaaa-0000-4000-8000-0000000000c2";
const OTHER = "aaaaaaaa-0000-4000-8000-0000000000c3";
const B_AGENT = "aaaaaaaa-0000-4000-8000-0000000000c4";
const ISSUE = "dddddddd-0000-4000-8000-0000000000c1";
const B_ISSUE = "dddddddd-0000-4000-8000-0000000000c2";
const run = (agentId: string, companyId = A) => ({ agentId, runId: "run-1", companyId, projectId: "" });

type Out = { error?: string; content?: string; data?: any };

describe("migration 015_review_findings", () => {
  it("is additive and passes the host migration guard", () => {
    const sql = readFileSync(new URL("../migrations/015_review_findings.sql", import.meta.url), "utf8");
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(3);
    for (const statement of statements) {
      validateMigrationStatement(statement, NAMESPACE);
      const body = statement.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim();
      expect(body).toMatch(/^CREATE (TABLE|UNIQUE INDEX|INDEX) IF NOT EXISTS /);
      expect(statement).not.toMatch(/\b(DROP|ALTER|DELETE|TRUNCATE|RENAME)\b/i);
    }
    for (const line of sql.split("\n").filter((l) => l.trim().startsWith("--"))) expect(line, line).not.toMatch(/['"]/);
  });
});

d("review findings (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  async function make() {
    const w = await worlds.make({
      savedConfigs: { [A]: { healthIssue: true }, [B]: { healthIssue: true } },
      prefixes: { [A]: "PAR", [B]: "OTH" },
      agents: [
        { id: REVIEWER, companyId: A, name: "Rita", status: "active", role: "qa", title: "Code Reviewer" },
        { id: DEV, companyId: A, name: "Dev", status: "idle", role: "engineer" },
        { id: OTHER, companyId: A, name: "Otto", status: "idle", role: "engineer" },
        { id: B_AGENT, companyId: B, name: "Bea", status: "idle", role: "engineer" },
      ],
    });
    // The harness reset does not know this table yet: start each test empty.
    await w.client.query(`DELETE FROM ${NAMESPACE}.review_findings`);
    await saveTeam(w.env, A, { operatorAgentId: OTHER }, "user-owner");
    w.issues.set(ISSUE, { id: ISSUE, companyId: A, identifier: "PAR-501", title: "Build", description: "", status: "in_review", assigneeAgentId: DEV });
    w.issues.set(B_ISSUE, { id: B_ISSUE, companyId: B, identifier: "OTH-1", title: "Other", description: "", status: "in_review", assigneeAgentId: B_AGENT });
    return w;
  }
  const call = (w: Hybrid, name: string, params: Record<string, unknown>, r = run(REVIEWER)) => w.tools.get(name)!(params, r) as Promise<Out>;
  const rows = async (w: Hybrid, companyId = A) =>
    (await w.client.query(`SELECT * FROM ${NAMESPACE}.review_findings WHERE company_id = $1 ORDER BY created_at`, [companyId])).rows as Record<string, any>[];

  it("declares and registers both tools", async () => {
    const w = await make();
    expect(REVIEW_FINDING_TOOLS.map((t) => t.name)).toEqual(["review-finding-record", "review-outcome-set"]);
    for (const tool of REVIEW_FINDING_TOOLS) expect(w.tools.has(tool.name), tool.name).toBe(true);
  });

  it("records a finding twice by hash as one row", async () => {
    const w = await make();
    const first = await call(w, "review-finding-record", { issueId: "PAR-501", summary: "Missing   null check in save()", filePath: "src/a.ts", tag: "bug" });
    expect(first.error).toBeUndefined();
    expect(first.data.status).toBe("recorded");
    expect(first.data.authorAgentId).toBe(DEV);
    // Same words, different case and spacing: same hash, same row.
    const again = await call(w, "review-finding-record", { issueId: ISSUE, summary: "missing null check in SAVE()", filePath: "src/a.ts" });
    expect(again.data.status).toBe("seen_again");
    expect(again.data.findingId).toBe(first.data.findingId);
    // An explicit hash is a key too.
    await call(w, "review-finding-record", { issueId: ISSUE, summary: "x", hash: "ABC" });
    await call(w, "review-finding-record", { issueId: ISSUE, summary: "y", hash: "abc" });
    const stored = await rows(w);
    expect(stored).toHaveLength(2);
    expect(stored.map((r) => Number(r.seen_count))).toEqual([2, 2]);
    expect(stored[0]!.reviewer_agent_id).toBe(REVIEWER);
    expect(stored[0]!.tag).toBe("bug");
  });

  it("refuses the reviewer as author and an author from another company", async () => {
    const w = await make();
    expect((await call(w, "review-finding-record", { issueId: ISSUE, summary: "s", authorAgentId: REVIEWER })).error).toMatch(/can not be you/);
    expect((await call(w, "review-finding-record", { issueId: ISSUE, summary: "s", authorAgentId: B_AGENT })).error).toMatch(/not an agent of this company/);
    expect(await rows(w)).toHaveLength(0);
  });

  it("lets only the author-side agent or the owner set the outcome, never the reviewer", async () => {
    const w = await make();
    const rec = await call(w, "review-finding-record", { issueId: ISSUE, summary: "Rename this" });
    const id = rec.data.findingId as string;
    expect((await call(w, "review-outcome-set", { findingId: id, outcome: "wrong" }, run(REVIEWER))).error).toMatch(/reviewer can not/);
    expect((await call(w, "review-outcome-set", { findingId: id, outcome: "wrong" }, run(OTHER))).error).toMatch(/Only the author/);
    expect((await call(w, "review-outcome-set", { findingId: id, outcome: "maybe" }, run(DEV))).error).toMatch(/Pass outcome/);
    expect((await rows(w))[0]!.outcome).toBeNull();

    const ok = await call(w, "review-outcome-set", { findingId: id, outcome: "did_not_matter", note: "cosmetic" }, run(DEV));
    expect(ok.error).toBeUndefined();
    let stored = (await rows(w))[0]!;
    expect(stored.outcome).toBe("did_not_matter");
    expect(stored.outcome_by_agent_id).toBe(DEV);

    const owner = (await currentRoles(w.env, A))!.ownerUserId!;
    expect(owner).toBeTruthy();
    await expect(setFindingOutcome(w.env, A, { userId: "someone-else" }, { findingId: id, outcome: "fixed" })).rejects.toThrow(/Only the author/);
    await setFindingOutcome(w.env, A, { userId: owner }, { hash: stored.finding_hash, outcome: "fixed" });
    stored = (await rows(w))[0]!;
    expect(stored.outcome).toBe("fixed");
    expect(stored.outcome_by_user_id).toBe(owner);
    expect(stored.outcome_by_agent_id).toBeNull();
  });

  it("keeps companies apart", async () => {
    const w = await make();
    // Company A's reviewer can not record on company B's issue.
    expect((await call(w, "review-finding-record", { issueId: B_ISSUE, summary: "s" })).error).toMatch(/not found in this company/);
    const rec = await call(w, "review-finding-record", { issueId: ISSUE, summary: "Same text", hash: "shared" });
    // The same hash in company B is its own row.
    const b = await call(w, "review-finding-record", { issueId: B_ISSUE, summary: "Same text", hash: "shared", authorAgentId: B_AGENT }, run(DEV, B));
    expect(b.data.status).toBe("recorded");
    expect(b.data.findingId).not.toBe(rec.data.findingId);
    // B's agent can not see or set A's finding, even by id.
    expect((await call(w, "review-outcome-set", { findingId: rec.data.findingId, outcome: "wrong" }, run(B_AGENT, B))).error).toMatch(/not found in this company/);
    expect(await rows(w, A)).toHaveLength(1);
    expect(await rows(w, B)).toHaveLength(1);
    expect((await rows(w, A))[0]!.outcome).toBeNull();
  });
});
