import { describe, expect, it } from "vitest";
import { ledgerPayloadFromEvent, parseLedgerInput } from "../src/growth-ledger.js";

const NOW = new Date("2026-10-03T12:00:00.000Z");
const event = { channel: "social", scope_key: "company:c-one", experiment_id: "exp1", verdict: "win", relative_change: 0.2, items: 4, min_per_arm: 2, playbook_decision: "pending", decided_by: null, decided_at: null };

describe("the kit's growth.verdict payload as the ledger reads it", () => {
  it("maps snake_case fields and a client scope key", () => {
    expect(parseLedgerInput(ledgerPayloadFromEvent(event), NOW)).toMatchObject({ channel: "social", scopeKey: "client:company:c-one", experimentId: "exp1", verdict: "win", relativeChange: 0.2, items: 4, minPerArm: 2, playbookDecision: "pending", decidedAt: NOW.toISOString() });
  });
  it("a null scope key is the company's own work", () => {
    expect(parseLedgerInput(ledgerPayloadFromEvent({ ...event, scope_key: null }), NOW).scopeKey).toBe("own");
  });
  it("leaves a camelCase payload alone", () => {
    const camel = { scope: "client:company:c-one", experimentId: "exp1", channel: "social" };
    expect(ledgerPayloadFromEvent(camel)).toBe(camel);
  });
});
