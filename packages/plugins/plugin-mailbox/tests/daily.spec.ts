import { describe, expect, it } from "vitest";
import { SqlStore } from "../src/db.js";
import { DAILY_DAYS, shapeDaily } from "../src/daily.js";
import { NAMESPACE } from "../src/namespace.js";
import { accountTone, categorySegments, categoryTone, draftTone, isSyncing, lastDays, receivedColumns, sendColumns, sendTone } from "../src/ui/series.js";
import { validateParams, validateRuntimeQuery } from "./helpers/sql-guard.js";

describe("mailbox daily counts (worker)", () => {
  it("reads inbound mail per day and category and sends per day and status in one guarded SELECT", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const store = new SqlStore({
      namespace: NAMESPACE,
      async query<T>(sql: string, params: unknown[] = []) {
        validateRuntimeQuery(sql, NAMESPACE);
        validateParams(sql, params);
        calls.push({ sql, params });
        return [
          { kind: "received", day: "2026-09-25", key: "lead", n: "2" },
          { kind: "received", day: "2026-09-24", key: null, n: 1 },
          { kind: "send", day: "2026-09-25", key: "sent", n: 5 },
          { kind: "send", day: "2026-09-25", key: "failed", n: "1" },
          { kind: "send", day: "2026-09-25", key: null, n: 1 },
        ] as T[];
      },
      async execute() {
        throw new Error("read only");
      },
    });
    const rows = await store.dailyCounts("co-1", 14);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain(`${NAMESPACE}.messages`);
    expect(calls[0]!.sql).toContain(`${NAMESPACE}.send_requests`);
    expect(calls[0]!.params).toEqual(["co-1", 14]);
    const daily = shapeDaily(rows);
    expect(daily.days).toBe(DAILY_DAYS);
    expect(daily.received).toEqual([{ date: "2026-09-24", category: "untriaged", count: 1 }, { date: "2026-09-25", category: "lead", count: 2 }]);
    expect(daily.sends).toEqual([{ date: "2026-09-25", status: "sent", count: 5 }, { date: "2026-09-25", status: "failed", count: 1 }]);
  });
});

describe("mailbox chart series (page)", () => {
  const now = new Date("2026-09-26T09:00:00Z");

  it("stacks received mail by category and folds the long tail into Other", () => {
    const received = ["lead", "client", "support", "newsletter", "spam", "notification", "reply"].map((category, i) => ({ date: "2026-09-26", category, count: 10 - i }));
    const r = receivedColumns({ days: 14, received: [...received, { date: "2026-08-01", category: "lead", count: 99 }], sends: [] }, now, 14, 6);
    expect(r.data).toHaveLength(14);
    expect(r.series.map((s) => s.key)).toEqual(["lead", "client", "support", "newsletter", "spam", "rest"]);
    expect(r.series.at(-1)).toMatchObject({ label: "Other", colorIndex: "neutral" });
    expect(r.data.at(-1)!.values).toMatchObject({ lead: 10, rest: 4 + 5 });
    expect(r.total).toBe(10 + 9 + 8 + 7 + 6 + 5 + 4);
    expect(lastDays(now, 2)).toEqual(["2026-09-25", "2026-09-26"]);
  });

  it("counts sent against failed per day", () => {
    const s = sendColumns({ days: 14, received: [], sends: [{ date: "2026-09-26", status: "sent", count: 4 }, { date: "2026-09-25", status: "failed", count: 1 }, { date: "2026-09-25", status: "retrying", count: 2 }] }, now);
    expect(s.sent).toBe(4);
    expect(s.failed).toBe(3);
    expect(s.sentPerDay.at(-1)).toBe(4);
    expect(s.data.at(-2)!.values).toEqual({ sent: 0, retrying: 2, failed: 1, sending: 0 });
  });

  it("builds donut segments busiest first with an Other slice", () => {
    const segs = categorySegments({ lead: 5, spam: 9, client: 0, support: 2, a: 1, b: 1, c: 1, d: 1, e: 1 }, 7);
    expect(segs[0]).toMatchObject({ key: "spam", value: 9 });
    expect(segs.at(-1)).toMatchObject({ key: "rest", label: "Other", value: 2 });
    expect(segs.some((x) => x.key === "client")).toBe(false);
  });

  it("uses one tone mapping", () => {
    expect([accountTone("connected"), accountTone("connected", "quota"), accountTone("needs_reconnect"), accountTone("disconnected")]).toEqual(["ok", "warn", "bad", "neutral"]);
    expect([sendTone("sent"), sendTone("failed"), sendTone("retrying"), sendTone("sending")]).toEqual(["ok", "bad", "warn", "info"]);
    expect([draftTone("sent"), draftTone("draft"), draftTone("failed")]).toEqual(["ok", "info", "bad"]);
    expect([categoryTone("lead"), categoryTone("invoice_or_bill"), categoryTone("spam"), categoryTone(null)]).toEqual(["ok", "warn", "neutral", "neutral"]);
    expect(isSyncing("2026-09-26T08:58:30Z", now)).toBe(true);
    expect(isSyncing("2026-09-26T08:40:00Z", now)).toBe(false);
    expect(isSyncing(null, now)).toBe(false);
  });
});

describe("chart day labels", () => {
  it("reads 14 Sep, never 9/14", async () => {
    const { dayLabels } = await import("../src/ui/series.js");
    expect(dayLabels("2026-09-14")).toEqual({ label: "14 Sep", title: "Mon 14 Sep" });
    expect(receivedColumns(null, new Date("2026-09-27T10:00:00Z"), 3).data.map((d) => d.label)).toEqual(["25 Sep", "26 Sep", "27 Sep"]);
  });
});
