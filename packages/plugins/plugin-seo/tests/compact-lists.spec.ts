/**
 * 0.22.0: `list-previews` (about 89 KB a call) and `needs-you` (about 35 KB) now answer with short rows and a sane
 * default limit; the full detail is one id (or key) away.
 */
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { HANDLERS } from "../src/dispatch.js";
import { NAMESPACE } from "../src/namespace.js";
import { createEnv } from "../src/service/common.js";
import { compactItem, NEEDS_YOU_LIST_DEFAULT, needsYouTool } from "../src/service/needs-you.js";
import { listPreviews, PREVIEW_LIST_DEFAULT } from "../src/service/preview.js";
import { SEO_TOOLS } from "../src/tools.js";
import { validateParams, validateRuntimeQuery } from "./helpers/sql-guard.js";

type Row = Record<string, unknown>;

const NOTE = Array.from({ length: 40 }, (_, i) => `Problem ${i + 1}: the listing grid loses its price column on the phone layout.`).join("\n");

function previewRows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `pv-${String(i).padStart(3, "0")}-${"x".repeat(20)}`,
    task_id: i % 2 ? "t-1" : "t-2",
    page_url: `https://huntandgun.co.za/category/p${i}/`,
    title: `Category page ${i} intro, FAQ and links ${"t".repeat(150)}`,
    status: i % 5 === 0 ? "approved" : "pending",
    decision_note: i % 5 === 0 ? "Looks good. ".repeat(60) : null,
    decided_at: i % 5 === 0 ? "2026-10-02T12:00:00Z" : null,
    expires_at: "2026-11-01T00:00:00Z",
    created_at: `2026-10-02T${String(10 + (i % 12)).padStart(2, "0")}:00:00Z`,
    review_status: i % 5 === 0 ? "passed" : "changes_needed",
    review_note: NOTE,
    stats: { liveWords: 900, previewWords: 1100, keptPct: 97, addedWords: 200, removedWords: 0, rendered: { keptPct: 96, liveWords: 880, previewWords: 1075, at: "2026-10-02T11:00:00Z", detail: "d".repeat(400) } },
  }));
}

function previewsHost(all: Row[]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const ctx = {
    db: {
      namespace: NAMESPACE,
      async query(sql: string, params: unknown[] = []) {
        validateRuntimeQuery(sql, NAMESPACE, ["heartbeat_runs", "issue_comments"]);
        validateParams(sql, params);
        calls.push({ sql, params });
        let rows = all;
        // Mirror the WHERE: params after $1 (company) and $2 (sprint), in the order the filters were added.
        const filters = [...sql.matchAll(/AND (\w+) = \$(\d+)/g)].map((m) => [m[1]!, params[Number(m[2]) - 1]] as const);
        for (const [column, value] of filters) if (column !== "sprint_id") rows = rows.filter((r) => r[column] === value);
        const limit = Number(params[params.length - 1]);
        return rows.slice(0, limit).map((r) => ({ ...r, total: rows.length }));
      },
      async execute() {
        return { rowCount: 0 };
      },
    },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  } as unknown as PluginContext;
  return { env: createEnv(ctx, { now: () => new Date("2026-10-03T08:00:00Z"), fetch: vi.fn() as never, site: vi.fn() as never }), calls };
}

const bytes = (value: unknown) => JSON.stringify(value).length;

describe("list-previews", () => {
  it("returns the 20 newest as short rows by default", async () => {
    const h = previewsHost(previewRows(100));
    const out = (await listPreviews(h.env, "co-1", { sprintId: "sp-1" })) as { previews: Row[]; returned: number; total: number; compact: boolean; more?: string; detail?: string };
    expect(PREVIEW_LIST_DEFAULT).toBe(20);
    expect(h.calls[0]!.params.at(-1)).toBe(20);
    expect(out).toMatchObject({ returned: 20, total: 100, compact: true });
    expect(out.more).toMatch(/80 older previews not shown/);
    expect(out.detail).toMatch(/previewId/);
    const row = out.previews[0]!;
    expect(Object.keys(row).sort()).toEqual(["decidedAt", "expiresAt", "keptPct", "pageUrl", "previewId", "reviewNote", "reviewNoteCut", "reviewStatus", "status", "taskId", "title", "url", "note", "noteCut"].filter((k) => k in row).sort());
    expect(row).not.toHaveProperty("stats");
    expect(String(row.reviewNote).length).toBeLessThanOrEqual(200);
    expect(row.reviewNoteCut).toBe(true);
    expect(row.keptPct).toBe(96);
    // About 89 KB a call before (100 rows in full); a short answer now.
    const full = await listPreviews(previewsHost(previewRows(100)).env, "co-1", { sprintId: "sp-1", compact: false, limit: 100 });
    expect(bytes(out)).toBeLessThan(16_000);
    expect(bytes(out)).toBeLessThan(bytes(full) / 25);
  });

  it("gives the client link only for previews the Reviewer passed", async () => {
    const out = (await listPreviews(previewsHost(previewRows(10)).env, "co-1", { sprintId: "sp-1" })) as { previews: Row[] };
    for (const row of out.previews) {
      if (row.reviewStatus === "passed") expect(String(row.url)).toMatch(/^https:\/\/preview\.partnersinbiz\.online\/p\/huntandgun\//);
      else expect(row).not.toHaveProperty("url");
    }
  });

  it("returns one preview in full by id: whole notes, figures and link", async () => {
    const all = previewRows(30);
    const wanted = String(all[7]!.id);
    const h = previewsHost(all);
    const out = (await listPreviews(h.env, "co-1", { sprintId: "sp-1", previewId: wanted, limit: 5, compact: true })) as { previews: Array<Row & { reviewNote: string; stats: Row }>; compact: boolean };
    expect(out.compact).toBe(false);
    expect(out.previews).toHaveLength(1);
    expect(out.previews[0]).toMatchObject({ previewId: wanted, reviewStatus: "changes_needed" });
    expect(out.previews[0]!.reviewNote).toBe(NOTE);
    expect(out.previews[0]!.stats).toMatchObject({ liveWords: 900, rendered: { keptPct: 96 } });
    expect(out.previews[0]!.url).toContain(wanted);
    expect(h.calls[0]!.sql).toContain("AND id = $3");
  });

  it("filters by task, answer and verdict, takes a limit, and can return every row in full", async () => {
    const h = previewsHost(previewRows(40));
    const filtered = (await listPreviews(h.env, "co-1", { sprintId: "sp-1", taskId: "t-1", status: "pending", reviewStatus: "changes_needed", limit: 5 })) as { previews: Row[]; total: number };
    expect(filtered.previews).toHaveLength(5);
    expect(filtered.previews.every((p) => p.taskId === "t-1" && p.status === "pending" && p.reviewStatus === "changes_needed")).toBe(true);
    expect(h.calls[0]!.sql).toMatch(/AND task_id = \$3 AND status = \$4 AND review_status = \$5/);
    const full = (await listPreviews(h.env, "co-1", { sprintId: "sp-1", compact: false, limit: 3 })) as { previews: Array<Row & { reviewNote: string }>; compact: boolean; detail?: string };
    expect(full.compact).toBe(false);
    expect(full.previews[0]!.reviewNote).toBe(NOTE);
    expect(full.previews[0]).toHaveProperty("stats");
    expect(full.detail).toBeUndefined();
    await expect(listPreviews(h.env, "co-1", { sprintId: "sp-1", status: "weird" })).rejects.toThrow(/status must be one of/);
    await expect(listPreviews(h.env, "co-1", { sprintId: "sp-1", limit: 500 })).rejects.toThrow(/at most 100/);
  });

  it("says nothing is there when nothing is", async () => {
    expect(await listPreviews(previewsHost([]).env, "co-1", { sprintId: "sp-1" })).toEqual({ previews: [], returned: 0, total: 0, compact: true });
  });
});

// ---------------------------------------------------------------------------

const item = (i: number, status: "open" | "done" = "open"): Row => ({
  key: `grant:item-${i}`,
  kind: "grant",
  title: `Item ${i}: ${"title ".repeat(30)}`,
  why: `Why ${i}: ${"because it needs a person ".repeat(40)}`,
  steps: Array.from({ length: 8 }, (_, s) => `Step ${s}: ${"do the thing ".repeat(20)}`),
  links: [{ label: "Open", url: "https://example.com/x" }],
  after: "The agent carries on.",
  copy: "Copy-ready text ".repeat(100),
  check: "manual",
  taskIds: [`t-${i}`],
  optional: false,
  status,
  addedAt: "2026-09-29T08:00:00Z",
  doneAt: status === "done" ? `2026-10-0${1 + (i % 3)}T08:00:00Z` : null,
});

function needsHost(items: Row[]) {
  const ctx = {
    db: {
      namespace: NAMESPACE,
      async query(sql: string, params: unknown[] = []) {
        validateRuntimeQuery(sql, NAMESPACE, ["heartbeat_runs", "issue_comments"]);
        validateParams(sql, params);
        if (/FROM plugin_seo_\w+\.sprints WHERE id = \$1/.test(sql)) {
          return [{ id: "sp-1", company_id: "co-1", name: "Acme", site_url: "https://acme.co.za", site_name: "Acme", status: "active", start_date: "2026-09-01", template_id: "outrank-90", template_version: 4, autopilot_mode: "safe" }];
        }
        if (/FROM plugin_seo_\w+\.needs_you WHERE company_id = \$1 AND sprint_id = \$2 AND week_start = \$3/.test(sql)) {
          return [{ id: "d-1", company_id: "co-1", sprint_id: "sp-1", week_start: "2026-09-28", issue_id: "iss-9", issue_identifier: "PAR-150", items, status: "open", updated_at: "2026-10-01T00:00:00Z" }];
        }
        return [];
      },
      async execute() {
        return { rowCount: 0 };
      },
    },
    config: { get: vi.fn(async () => ({})) },
    companies: { get: vi.fn(async () => ({ id: "co-1", issuePrefix: "PAR" })) },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  } as unknown as PluginContext;
  // 2026-09-30 is in the week of the digest (Monday 2026-09-28).
  return createEnv(ctx, { now: () => new Date("2026-09-30T08:00:00Z"), fetch: vi.fn() as never, site: vi.fn() as never });
}

describe("needs-you", () => {
  const items = [...Array.from({ length: 45 }, (_, i) => item(i)), ...Array.from({ length: 12 }, (_, i) => item(100 + i, "done"))];

  it("returns one-line rows for the open items (up to 30) and the keys of the done ones by default", async () => {
    const full = (await needsYouTool(needsHost(items), "co-1", { sprintId: "sp-1", compact: false })) as { open: Row[]; done: Row[] };
    expect(full.open).toHaveLength(45);
    const out = (await needsYouTool(needsHost(items), "co-1", { sprintId: "sp-1" })) as { compact: boolean; open: Row[]; openTotal: number; done: Row[]; doneTotal: number; more?: string; detail: string; weekStart: string; issueIdentifier: string };
    expect(NEEDS_YOU_LIST_DEFAULT).toBe(30);
    expect(out).toMatchObject({ compact: true, openTotal: 45, doneTotal: 12, weekStart: "2026-09-28", issueIdentifier: "PAR-150" });
    expect(out.open).toHaveLength(30);
    expect(out.more).toMatch(/15 more open items/);
    expect(out.open[0]).toEqual({ key: "grant:item-0", kind: "grant", title: expect.any(String), why: expect.any(String), status: "open", optional: false, taskIds: ["t-0"], addedAt: "2026-09-29T08:00:00Z" });
    expect(String(out.open[0]!.why).length).toBeLessThanOrEqual(160);
    for (const row of out.open) for (const heavy of ["steps", "links", "copy", "after"]) expect(row).not.toHaveProperty(heavy);
    expect(out.done).toHaveLength(12);
    expect(Object.keys(out.done[0]!).sort()).toEqual(["doneAt", "key", "title"]);
    expect(out.detail).toMatch(/Pass key/);
    expect(bytes(out)).toBeLessThan(bytes(full) / 8);
  });

  it("returns one item in full by key (open or done) and names the keys when it is not there", async () => {
    const env = needsHost(items);
    const open = (await needsYouTool(env, "co-1", { sprintId: "sp-1", key: "grant:item-3" })) as { item: Row };
    expect(open.item).toMatchObject({ key: "grant:item-3", status: "open", copy: expect.stringContaining("Copy-ready text"), links: [{ label: "Open", url: "https://example.com/x" }] });
    expect((open.item.steps as string[]).length).toBe(8);
    const done = (await needsYouTool(env, "co-1", { sprintId: "sp-1", key: "grant:item-101" })) as { item: Row };
    expect(done.item).toMatchObject({ key: "grant:item-101", status: "done" });
    await expect(needsYouTool(env, "co-1", { sprintId: "sp-1", key: "nope" })).rejects.toThrow(/needs-you lists the keys/);
  });

  it("takes a limit and keeps the old full shape behind compact false", async () => {
    const out = (await needsYouTool(needsHost(items), "co-1", { sprintId: "sp-1", limit: 5 })) as { open: Row[]; more?: string };
    expect(out.open).toHaveLength(5);
    expect(out.more).toMatch(/40 more open items/);
    const full = (await needsYouTool(needsHost(items), "co-1", { sprintId: "sp-1", compact: false })) as { sprintId: string; weekStart: string; open: Array<Row & { steps: string[] }>; done: Row[] };
    expect(full).toMatchObject({ sprintId: "sp-1", weekStart: "2026-09-28" });
    expect(full.open[0]!.steps).toHaveLength(8);
    expect(full.done).toHaveLength(12);
    await expect(needsYouTool(needsHost(items), "co-1", { sprintId: "sp-1", limit: 1000 })).rejects.toThrow(/at most 100/);
  });

  it("compactItem keeps the key and drops the heavy fields", () => {
    const row = compactItem({ key: "k", kind: "grant", title: "T", why: "W".repeat(500), steps: ["s"], links: [], after: "a", copy: "c", optional: true, status: "open", check: "manual", taskIds: ["t"], addedAt: "x", doneAt: null } as never);
    expect(row).toEqual({ key: "k", kind: "grant", title: "T", why: `${"W".repeat(159)}…`, status: "open", optional: true, taskIds: ["t"], addedAt: "x" });
  });
});

describe("the tools declare the compact controls", () => {
  const props = (name: string) => Object.keys((SEO_TOOLS.find((t) => t.name === name)!.parametersSchema as { properties: Record<string, unknown> }).properties);
  it("list-previews and needs-you take compact, limit and an id", () => {
    expect(props("list-previews")).toEqual(expect.arrayContaining(["previewId", "compact", "limit", "status", "reviewStatus", "taskId"]));
    expect(props("needs-you")).toEqual(expect.arrayContaining(["key", "compact", "limit"]));
    expect(HANDLERS["list-previews"]).toBeDefined();
    expect(HANDLERS["needs-you"]).toBeDefined();
  });
});
