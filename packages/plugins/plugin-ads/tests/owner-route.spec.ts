import { describe, it, expect } from "vitest";
import { DEFAULT_OWNER_THRESHOLD_MINOR, ownerThresholdMinor, lifetimeBudgetMinor, ownerRouteOf, isOwnerDelegateApproval } from "../src/owner-route.js";
import type { ApprovalRow, ProposalRow } from "../src/db.js";
import { signoffState } from "../src/signoffs.js";

describe("owner-route", () => {
  describe("ownerThresholdMinor", () => {
    [
      ["explicit wins", { currency: "ZAR", owner_threshold_minor: 100_000 }, 100_000],
      ["null => 50k ZAR", { currency: "ZAR", owner_threshold_minor: null }, DEFAULT_OWNER_THRESHOLD_MINOR],
      ["null => 0 non-ZAR", { currency: "USD", owner_threshold_minor: null }, 0],
    ].forEach(([desc, scope, expected]) => {
      it(String(desc), () => expect(ownerThresholdMinor(scope as any)).toBe(expected));
    });
  });

  describe("lifetimeBudgetMinor", () => {
    const p = (kind: any, payload?: any, impact?: any) => ({ kind, payload: payload ?? {}, impact: impact ?? {} } as any);
    [
      ["pause_campaign => 0", p("pause_campaign"), 0],
      ["creative_check => 0", p("creative_check"), 0],
      ["change_budget", p("change_budget", {}, { addedThisMonthMinor: 25_000 }), 25_000],
      ["create: 5k x 10", p("create_campaign", { dailyBudgetMinor: 5_000, startDate: "2026-01-01", endDate: "2026-01-10" }), 50_000],
      ["create: + adSets", p("create_campaign", { dailyBudgetMinor: 2_000, startDate: "2026-01-01", endDate: "2026-01-05", adSets: [{ dailyBudgetMinor: 1_000, startDate: "2026-01-01", endDate: "2026-01-05" }] }), 15_000],
      ["create: no endDate", p("create_campaign", { dailyBudgetMinor: 5_000, startDate: "2026-01-01" }), null],
    ].forEach(([desc, proposal, expected]) => {
      it(String(desc), () => expect(lifetimeBudgetMinor(proposal)).toBe(expected));
    });
  });

  describe("ownerRouteOf", () => {
    const scope = (threshold: number) => ({ currency: "ZAR", owner_threshold_minor: threshold } as any);
    [
      ["<=threshold => delegate", scope(50_000), { dailyBudgetMinor: 5_000, startDate: "2026-01-01", endDate: "2026-01-10" }, "delegate"],
      [">threshold => owner", scope(50_000), { dailyBudgetMinor: 5_001, startDate: "2026-01-01", endDate: "2026-01-10" }, "owner_required"],
      ["null => owner", scope(50_000), { dailyBudgetMinor: 5_000, startDate: "2026-01-01" }, "owner_required"],
    ].forEach(([desc, s, payload, route]) => {
      it(String(desc), () => expect(ownerRouteOf(s, { kind: "create_campaign", payload, impact: {} } as any).route).toBe(route));
    });
  });

  describe("isOwnerDelegateApproval", () => {
    const agent = "agent:agent-am";
    [
      ["agent+owner+approved+no cap", agent, "owner", "approved", false, true],
      ["agent+over_cap", agent, "owner", "approved", true, false],
      ["agent+client", agent, "client", "approved", false, false],
      ["agent+rejected", agent, "owner", "rejected", false, false],
      ["a person", "user:someone", "owner", "approved", false, false],
      ["other agent", "agent:other", "owner", "approved", false, false],
    ].forEach(([desc, decidedBy, role, decision, overCapAck, expected]) => {
      it(String(desc), () => expect(isOwnerDelegateApproval({ decided_by: decidedBy, role: role as any, decision: decision as any, over_cap_ack: overCapAck } as any, "agent-am")).toBe(expected));
    });
  });

  it("signoffState: only the current delegate agent counts", () => {
    const now = new Date();
    const prop = { content_hash: "h", requires_signoffs: ["owner"] } as any;
    const a = (decidedBy: string): ApprovalRow => ({ id: "a", proposal_id: "p", role: "owner", decision: "approved", decided_by: decidedBy, content_hash: "h", over_cap_ack: false, note: null, evidence_ref: null, expires_at: new Date(Date.now() + 1e6).toISOString(), consumed_at: null, created_at: now.toISOString() });
    expect(signoffState(prop, [a("agent:agent-am")], now, "agent-am").complete).toBe(true);
    expect(signoffState(prop, [a("agent:other")], now, "agent-am").complete).toBe(false);
    expect(signoffState(prop, [a("agent:agent-am")], now, null).complete).toBe(false);
    expect(signoffState(prop, [a("agent:agent-am")], now).complete).toBe(false);
  });
});
