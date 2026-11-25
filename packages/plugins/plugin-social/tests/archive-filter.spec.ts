/**
 * Archived posts must leave every list, count and work queue (PAR-11506 review).
 * The fake db below applies `archived_at IS NULL` only when the statement contains it, so each test
 * fails if that clause is removed from the query. It proves the clause is in the SQL, not Postgres semantics.
 */
import { describe, expect, it } from "vitest";
import { socialFlows } from "../src/cockpit.js";
import { listPosts, setPostArchived } from "../src/db.js";
import { fakeCtx } from "./helpers.js";

type Row = { id: string; status: string; archived_at: string | null; client_ref?: string | null; updated_at?: string };

const ROWS: Row[] = [
  { id: "live-draft", status: "draft", archived_at: null },
  { id: "old-draft", status: "draft", archived_at: "2026-11-13T00:00:00Z" },
  { id: "live-review", status: "review", archived_at: null },
  { id: "old-review", status: "review", archived_at: "2026-11-13T00:00:00Z" },
  { id: "old-failed", status: "failed", archived_at: "2026-11-13T00:00:00Z" },
];

/** Rows a `FROM ...posts` statement would see: archived ones only when the SQL does not filter them. */
function visible(sql: string): Row[] {
  const rows = sql.includes("archived_at IS NULL") ? ROWS.filter((r) => r.archived_at === null) : ROWS;
  const m = /status = '(\w+)'/.exec(sql);
  return m ? rows.filter((r) => r.status === m[1]) : rows;
}

describe("archived posts leave the lists", () => {
  it("listPosts drops an archived post; without the clause it would be returned", async () => {
    const ctx = fakeCtx({}, { queryResult: (sql) => visible(sql) });
    const out = await listPosts(ctx, "co", {});
    expect(out.map((p) => p.id)).toEqual(["live-draft", "live-review"]);
  });

  it("the Cockpit draft and approval flow counts ignore archived posts", async () => {
    const ctx = fakeCtx(
      {},
      {
        queryResult: (sql) => {
          if (sql.includes("count(*)::text AS drafts")) return [{ drafts: String(visible(sql).length) }];
          if (sql.includes("count(*)::text AS n, count(*) FILTER")) return [{ n: String(visible(sql).length), late: "0", oldest: null }];
          return [];
        },
      },
    );
    const flows = await socialFlows(ctx, "co");
    // One live draft and one live review post; the archived ones are not counted.
    expect(flows.find((f) => f.stage === "social.drafts")?.count).toBe(1);
    expect(flows.find((f) => f.stage === "social.approval")?.count).toBe(1);
  });

  it("every post count and queue in the module filters archived_at", async () => {
    const { readFileSync } = await import("node:fs");
    const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
    const mustFilter: Array<[string, string]> = [
      ["cockpit.ts", "status = 'review' AND archived_at IS NULL AND review_issue_id IS NOT NULL"],
      ["cockpit.ts", "status = 'review' AND archived_at IS NULL ORDER BY updated_at"],
      ["cockpit.ts", "status = 'approved' AND archived_at IS NULL ORDER BY updated_at"],
      ["cockpit.ts", "status = 'draft' AND archived_at IS NULL"],
      ["cockpit.ts", "status = 'review' AND archived_at IS NULL`"],
      ["cockpit.ts", "p.company_id = $1 AND p.archived_at IS NULL"],
      ["db.ts", "status IN ('failed', 'partially_published') AND archived_at IS NULL"],
      ["done-checks.ts", "status = 'approved' AND archived_at IS NULL"],
      ["approval-flow.ts", "p.archived_at IS NULL"],
    ];
    for (const [file, fragment] of mustFilter) expect(src(file), `${file}: ${fragment}`).toContain(fragment);
  });
});

describe("setPostArchived guard", () => {
  it("does not archive a post that became scheduled between read and write", async () => {
    const post = { status: "scheduled", archived_at: null as string | null };
    const ctx = fakeCtx(
      {},
      {
        executeResult: (sql: string) => {
          // Apply the UPDATE's own WHERE: the status list in the SQL decides whether the row changes.
          const refused = /status NOT IN \(([^)]*)\)/.exec(sql)?.[1] ?? "";
          if (refused.includes(`'${post.status}'`)) return 0;
          post.archived_at = "now";
          return 1;
        },
      },
    );
    expect(await setPostArchived(ctx, "co", "p1", true)).toBe(false);
    expect(post.archived_at).toBeNull();
    post.status = "draft";
    expect(await setPostArchived(ctx, "co", "p1", true)).toBe(true);
  });
});
