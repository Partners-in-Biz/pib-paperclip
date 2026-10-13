import { describe, it, expect, beforeEach } from "vitest";
import { insertOnce, type SqlExecutor } from "../src/idempotency.js";

describe("insertOnce", () => {
  let rec: Array<{ sql: string; params: unknown[] }>;
  const db = { async execute(sql: string, params?: unknown[]) { rec.push({ sql, params: params ?? [] }); return { rowCount: 1 }; } };
  const db1 = { async execute() { return { rowCount: 1 }; } } as SqlExecutor;
  const db0 = { async execute() { return { rowCount: 0 }; } } as SqlExecutor;

  beforeEach(() => {
    rec = [];
  });

  it("INSERT shape", async () => {
    await insertOnce(db, "plugin_test", "call", { call_sid: "cs123", from_e164: "+27821234567", to_e164: "+27821234568", user_id: "u1" });
    const { sql, params } = rec[0]!;
    expect(sql).toContain("INSERT INTO");
    expect(sql).toContain("ON CONFLICT (call_sid) DO NOTHING");
    expect(params).toContain("cs123");
  });
  it.each([[db1, true], [db0, false]])("rowCount %s", async (d, exp) => {
    const r = await insertOnce(d, "plugin_test", "call", { call_sid: "cs1", from_e164: "+27821234567", to_e164: "+27821234568", user_id: "u1" });
    expect(r).toBe(exp);
  });
  it.each([
    ["bad-ns", {}, /Unsafe/],
    ["plugin_test", { "bad-col": "v", call_sid: "c1" }, /Unsafe/],
    ["plugin_test", { from_e164: "+27821234567" }, /Missing/],
    ["plugin_test", { call_sid: "", from_e164: "+27821234567" }, /Missing/],
  ])("rejects %s", async (ns, d, e) => {
    await expect(insertOnce(db, ns, "call", d)).rejects.toThrow(e);
  });
  it.each([
    ["recording", { recording_sid: "rs1", call_sid: "cs1", twilio_url: "http://test" }, "recording_sid"],
    ["message", { provider_msg_id: "pm1", from_e164: "+27821234567", to_e164: "+27821234568", channel: "sms", direction: "outbound" }, "provider_msg_id"],
  ])("allows %s (%s)", async (k, d, col) => {
    const r = await insertOnce(db, "plugin_test", k as never, d as never);
    expect(r).toBe(true);
    expect(rec[0]?.sql).toContain(`ON CONFLICT (${col}) DO NOTHING`);
  });
});
