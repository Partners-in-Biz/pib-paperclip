import { describe, expect, it } from "vitest";
import { dedupeByTask } from "../src/cockpit.js";
import { companyInfo } from "../src/service/common.js";
import { closeItemsForClosedTask } from "../src/service/needs-you.js";
import { seoHost, taskRow, SPRINT, type Route, type Row } from "./helpers/seo-host.js";

const item = (key: string, kind: string, taskIds: string[], status = "open"): Row => ({
  key, kind, title: key, why: "why", steps: [], links: [], after: "after", check: "manual", taskIds, status, addedAt: "2026-09-29T00:00:00Z",
});
const digest = (week: string, items: Row[]): Row => ({ id: `ny-${week}`, company_id: "co-1", sprint_id: "sp-1", week_start: week, issue_id: null, issue_identifier: null, items, status: "open" });

function world(digests: Row[], tasks: Row[]) {
  const routes: Route[] = [
    [/FROM plugin_seo_8099f8879a\.sprints WHERE id = \$1/, () => [SPRINT]],
    [/needs_you WHERE company_id = \$1 AND sprint_id = \$2 ORDER BY week_start DESC/, () => digests],
    [/needs_you WHERE company_id = \$1 AND week_start = /, () => digests],
    [/FROM plugin_seo_8099f8879a\.sprint_tasks WHERE id = \$1/, (p) => tasks.filter((t) => t.id === p[0])],
  ];
  return seoHost({ routes });
}

const saved = (h: ReturnType<typeof world>) => h.executes.filter((e) => /INSERT INTO plugin_seo_8099f8879a\.needs_you /.test(e.sql));
const savedItems = (e: { params: unknown[] }) => e.params.flatMap((p) => (Array.isArray(p) ? p : typeof p === "string" && p.startsWith("[") ? JSON.parse(p) : [])) as Row[];

describe("closeItemsForClosedTask", () => {
  it("closes review, task and listing rows on every week's digest; leaves other tasks and setup items", async () => {
    const h = world(
      [
        digest("2026-10-05", [item("review:t-1", "review", ["t-1"]), item("task:t-1", "task", ["t-1"]), item("review:t-2", "review", ["t-2"]), item("service_account", "grant", [])]),
        digest("2026-09-28", [item("custom-signoff", "review", ["t-1"])]),
      ],
      [taskRow({ id: "t-1", status: "done" })],
    );
    const n = await closeItemsForClosedTask(h.env, "co-1", "sp-1", "t-1", "The task was closed.");
    expect(n).toBe(3);
    const rows = saved(h).flatMap(savedItems);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.status]));
    expect(byKey["review:t-1"]).toBe("done");
    expect(byKey["task:t-1"]).toBe("done");
    expect(byKey["custom-signoff"]).toBe("done");
    expect(byKey["review:t-2"]).toBe("open");
    expect(byKey["service_account"]).toBe("open");
  });

  it("keeps a row listing several tasks open while another listed task is still open", async () => {
    const h = world([digest("2026-10-05", [item("batch", "review", ["t-1", "t-2"])])], [taskRow({ id: "t-2", status: "in_progress" })]);
    expect(await closeItemsForClosedTask(h.env, "co-1", "sp-1", "t-1", "closed")).toBe(0);
    expect(saved(h)).toHaveLength(0);
  });
});

describe("dedupeByTask", () => {
  const row = (key: string, kind: string, taskIds: string[], sprint = "sp-1") => ({ item: item(key, kind, taskIds) as never, digest: { sprint_id: sprint } });
  it("keeps one row per sprint and task, the sign-off first", () => {
    const out = dedupeByTask([row("task:t-1", "task", ["t-1"]), row("review:t-1", "review", ["t-1"]), row("again", "review", ["t-1"]), row("task:t-1", "task", ["t-1"], "sp-2"), row("g", "grant", [])]);
    expect(out.map((r) => `${r.digest.sprint_id}:${r.item.key}`)).toEqual(["sp-1:review:t-1", "sp-2:task:t-1", "sp-1:g"]);
    expect(out).toHaveLength(3);
    expect(out.find((r) => r.digest.sprint_id === "sp-1" && r.item.taskIds?.[0] === "t-1")!.item.key).toBe("review:t-1");
  });
});
