/**
 * What marks the canary client in Billing (0.7.1), without a database: the id rule the guards share, the SQL fragment that leaves it out
 * of queries, and the reminder plan that never includes it. The behaviour on a real Postgres is in `canary-rehearsal.pg.spec.ts`.
 */
import { describe, expect, it } from "vitest";
import type { InvoiceBalance } from "../src/balances.js";
import { isCanaryCustomer, isCanaryEmail, isCanaryRef, isCanarySql } from "../src/canary.js";
import { DEFAULT_DUNNING_STAGES } from "../src/config.js";
import { planReminders } from "../src/dunning.js";
import { SKILLS } from "../src/skills.js";

describe("the canary id rule", () => {
  it("is a prefix and nothing else: a real client's id that merely mentions the word is not the canary", () => {
    for (const ref of ["canary-ab12cd34", "canary-contact-ab12cd34", "canary-x"]) expect(isCanaryRef(ref)).toBe(true);
    for (const ref of ["acme-canary-1", "canary", "Canary-ab12", " canary-ab12", "", null, undefined]) expect(isCanaryRef(ref as string | null | undefined)).toBe(false);
    expect(isCanaryCustomer({ customer_ref: "canary-ab12cd34" })).toBe(true);
    expect(isCanaryCustomer({ customer_ref: "co-acme" })).toBe(false);
    expect(isCanaryCustomer({})).toBe(false);
  });

  it("leaves the address rule alone: only a reserved .invalid name is a canary address", () => {
    expect(isCanaryEmail("canary@canary.invalid")).toBe(true);
    expect(isCanaryEmail("ap@lumen.test")).toBe(false);
  });

  it("gives queries the same rule as one constant clause on the table's alias", () => {
    expect(isCanarySql("i")).toBe("i.customer_ref LIKE 'canary-%'");
    expect(isCanarySql("q")).toBe("q.customer_ref LIKE 'canary-%'");
  });
});

describe("the reminder plan", () => {
  const now = new Date("2026-10-04T08:00:00Z");
  const balance = (id: string, customerRef: string, dueDaysAgo = 20): InvoiceBalance => ({
    invoice: { id, status: "overdue", customer_kind: "company", customer_ref: customerRef, due_at: new Date(now.getTime() - dueDaysAgo * 86_400_000).toISOString() } as never,
    state: {} as never,
    outstandingMinor: 100_000,
    futurePaidMinor: 0,
    futurePayments: 0,
    nextFuturePaidAt: null,
  });

  it("never includes the canary's invoice, however overdue, and still plans a real one", () => {
    const plans = planReminders({
      balances: [balance("canary-inv", "canary-ab12cd34"), balance("canary-contact-inv", "canary-contact-ab12cd34", 90), balance("real-inv", "co-acme"), balance("lookalike-inv", "acme-canary-1")],
      stages: DEFAULT_DUNNING_STAGES,
      sentByInvoice: new Map(),
      optedOut: new Set(),
      now,
    });
    expect(plans.map((plan) => plan.invoiceId)).toEqual(["real-inv", "lookalike-inv"]);
  });
});

describe("the skill", () => {
  it("tells agents a rehearsal opens no work for them, and stays within the size budget", () => {
    const skill = SKILLS[0]!.markdown ?? "";
    expect(skill).toContain("None of these is opened for the canary (test) client");
    expect(skill).toContain("opens no issue and wakes nobody");
    expect(skill.length).toBeLessThanOrEqual(18_000);
  });
});
