import { describe, expect, it } from "vitest";
import { billingActivity, invoiceAgeing, invoiceMonths, invoiceStatusCounts, isOverdue, lastMonths, monthLabel, percentDelta, statusTone } from "../src/ui/series.js";
import type { Invoice } from "../src/ui/types.js";
import { openFormFor } from "../src/ui/views.js";

const now = Date.parse("2026-09-26T12:00:00Z");
const inv = (id: string, status: string, extra: Partial<Invoice> = {}): Invoice => ({ id, number: id.toUpperCase(), status, currency: "ZAR", customerRef: "c1", customerName: "Lumen", totalMinor: 10_000, outstandingMinor: 10_000, ...extra });

describe("billing UI series", () => {
  it("maps statuses to one tone scale", () => {
    expect(["paid", "overdue", "payment_pending_verification", "draft", "cancelled", "failed", "unknown"].map(statusTone)).toEqual(["ok", "bad", "warn", "info", "neutral", "bad", "neutral"]);
  });

  it("lists the last months and labels them", () => {
    expect(lastMonths(new Date(now), 3)).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(lastMonths(new Date("2026-01-15T00:00:00Z"), 2)).toEqual(["2025-12", "2026-01"]);
    expect(monthLabel("2026-09")).toEqual({ label: "Sep", title: "Sep 2026" });
  });

  it("describes month-on-month change", () => {
    expect(percentDelta(120, 100)).toBe("+20% vs last month");
    expect(percentDelta(50, 100)).toBe("−50% vs last month");
    expect(percentDelta(100, 100)).toBe("0% vs last month");
    expect(percentDelta(5, 0)).toBeNull();
  });

  it("counts invoices per status and flags overdue ones", () => {
    const list = [inv("a", "paid"), inv("b", "paid"), inv("c", "sent", { dueAt: "2026-09-01" }), inv("d", "draft")];
    expect(invoiceStatusCounts(list)).toEqual([{ status: "paid", count: 2, tone: "ok" }, { status: "draft", count: 1, tone: "info" }, { status: "sent", count: 1, tone: "info" }]);
    expect(isOverdue(list[2]!, now)).toBe(true);
    expect(isOverdue(inv("e", "sent", { dueAt: "2026-10-01" }), now)).toBe(false);
    expect(isOverdue(inv("f", "overdue", { outstandingMinor: 0 }), now)).toBe(false);
  });

  it("ages what is still owed in one currency", () => {
    const buckets = invoiceAgeing([
      inv("a", "sent", { dueAt: "2026-10-10", outstandingMinor: 1_000 }),
      inv("b", "overdue", { dueAt: "2026-08-10", outstandingMinor: 2_000 }),
      inv("c", "partially_paid", { dueAt: "2026-05-01", outstandingMinor: 3_000 }),
      inv("d", "sent", { dueAt: "2026-05-01", outstandingMinor: 9_000, currency: "USD" }),
      inv("e", "paid", { dueAt: "2026-05-01", outstandingMinor: 0 }),
    ], "ZAR", now);
    expect(buckets).toEqual({ "0-30": { count: 1, amountMinor: 1_000 }, "31-60": { count: 1, amountMinor: 2_000 }, "61-90": { count: 0, amountMinor: 0 }, "90+": { count: 1, amountMinor: 3_000 } });
  });

  it("sums invoiced and paid per month from the snapshot", () => {
    const rows = invoiceMonths([
      inv("a", "paid", { sentAt: "2026-08-03T00:00:00Z", paidAt: "2026-09-02T00:00:00Z", paidMinor: 10_000 }),
      inv("b", "sent", { sentAt: "2026-09-05T00:00:00Z", totalMinor: 5_000 }),
      inv("c", "cancelled", { sentAt: "2026-09-05T00:00:00Z" }),
      inv("d", "draft"),
    ], ["2026-08", "2026-09"], "ZAR");
    expect(rows).toEqual([{ month: "2026-08", invoicedMinor: 10_000, paidMinor: 0 }, { month: "2026-09", invoicedMinor: 5_000, paidMinor: 10_000 }]);
  });

  it("builds the activity feed newest first", () => {
    const feed = billingActivity({
      invoices: [
        inv("a", "paid", { sentAt: "2026-09-01T00:00:00Z", paidAt: "2026-09-20T00:00:00Z" }),
        inv("b", "overdue", { sentAt: "2026-09-10T00:00:00Z", deliveryStatus: "failed" }),
      ],
      pops: [{ id: "p", invoiceId: "b", invoiceNumber: "B", source: "email", matchBasis: null, status: "pending", amountMinor: 1, reference: null, fromEmail: "ap@x.co", fromName: null, subject: null, snippet: null, hasFile: false, fileName: null, attachments: [], issueId: null, paymentId: null, rejectReason: null, receivedAt: "2026-09-25T00:00:00Z" }],
    });
    expect(feed.map((e) => [e.title, e.tone])).toEqual([
      ["Proof of payment to check for B", "warn"],
      ["A paid", "ok"],
      ["B email failed", "bad"],
      ["A sent", "info"],
    ]);
  });
});

describe("billing deep links", () => {
  it("opens the new-quote form from the CRM's Draft a quote link, and the invoice form from the Invoices tab", () => {
    expect(openFormFor("quotes")).toBe("quote");
    expect(openFormFor("invoices")).toBe("invoice");
    expect(openFormFor("overview")).toBeNull();
    expect(openFormFor(null)).toBeNull();
  });
});
