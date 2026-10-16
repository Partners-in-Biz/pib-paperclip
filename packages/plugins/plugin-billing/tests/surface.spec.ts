/**
 * The agent surface (tools, skill, manifest) and the page's tab layout, as
 * pure checks.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { JsonSchema } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import { INVOICE_DRAFT_SKILL, ONLINE_PAYMENTS_REFERENCE, SKILLS } from "../src/skills.js";
import { BILLING_TOOLS } from "../src/tools.js";
import { documentLabel, draftsToSend, futurePaymentsText, waitingOnPerson } from "../src/ui/series.js";
import type { Snapshot } from "../src/ui/types.js";
import { resolveView, sectionsFor, tabsFor, TAB_SECTIONS, TOP_TABS, VIEW_IDS, type View } from "../src/ui/views.js";

const PKG_VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

type Schema = JsonSchema & { properties?: Record<string, Schema>; items?: Schema; enum?: unknown[]; description?: string; required?: string[] };

describe("agent tools", () => {
  it("describe every parameter, and use an enum wherever the values are fixed", () => {
    const fixed = new Set(["customerKind", "status", "method", "paidFrom", "period", "frequency", "supplierKind", "taxCode"]);
    let params = 0;
    for (const tool of BILLING_TOOLS) {
      expect(tool.description.length, tool.name).toBeGreaterThan(20);
      const schema = tool.parametersSchema as Schema;
      expect(schema.additionalProperties, tool.name).toBe(false);
      for (const [name, prop] of Object.entries(schema.properties ?? {})) {
        params += 1;
        expect(prop.description, `${tool.name}.${name}`).toBeTruthy();
        if (prop.items) expect(prop.items.description, `${tool.name}.${name}[]`).toBeTruthy();
        if (fixed.has(name) && name !== "frequency") expect(prop.enum, `${tool.name}.${name}`).toBeTruthy();
        if (name === "frequency") expect(prop.enum).toEqual(["monthly", "quarterly", "yearly"]);
      }
      for (const name of schema.required ?? []) expect(schema.properties?.[name], `${tool.name} requires ${name}`).toBeTruthy();
    }
    expect(params).toBeGreaterThan(150);
    expect(new Set(BILLING_TOOLS.map((t) => t.name)).size).toBe(BILLING_TOOLS.length);
  });

  it("let agents ask for sends, checks and reminders, and never set a quote to sent", () => {
    const names = BILLING_TOOLS.map((t) => t.name);
    for (const name of ["request-invoice-send", "request-quote-send", "request-payment-check", "request-reminder-send", "list-quotes", "quote-detail", "update-quote", "remove-quote-line"]) expect(names).toContain(name);
    const status = (BILLING_TOOLS.find((t) => t.name === "set-quote-status")!.parametersSchema as Schema).properties!.status!;
    expect(status.enum).toEqual(["accepted", "declined", "expired"]);
    const create = BILLING_TOOLS.find((t) => t.name === "create-invoice")!.parametersSchema as Schema;
    expect(create.required).toEqual(["currency", "customerKind", "customerRef"]);
    expect(create.properties!.dealId).toBeTruthy();
    expect((BILLING_TOOLS.find((t) => t.name === "create-quote")!.parametersSchema as Schema).properties!.dealId).toBeTruthy();
    expect(BILLING_TOOLS.find((t) => t.name === "record-payment")!.description).toContain("You never record it yourself");
    expect(BILLING_TOOLS.find((t) => t.name === "set-invoice-tax")!.description).toContain("clears every line's VAT code");
  });
});

describe("the invoice-draft skill", () => {
  it("only names Billing tools that exist and says what only a person can do", () => {
    const names = new Set(BILLING_TOOLS.map((t) => t.name));
    const mentioned = [...INVOICE_DRAFT_SKILL.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)].map((m) => m[1]!).filter((n) => !n.startsWith("za-"));
    const billingLike = mentioned.filter((n) => /^(create|add|update|remove|list|request|record|set|convert|invoice|quote|customer|bill|start|stop|log|pause|resume|billing)-/.test(n) && !["create-company", "create-contact", "create-draft", "find-records", "list-deal-products", "update-company"].includes(n));
    for (const name of billingLike) expect(names.has(name), name).toBe(true);
    for (const tool of ["request-invoice-send", "request-quote-send", "request-payment-check", "request-reminder-send", "record-payment", "create-credit-note", "convert-quote", "set-quote-status", "billing-report", "list-open-invoices"]) {
      expect(INVOICE_DRAFT_SKILL).toContain(`\`${tool}\``);
    }
    expect(INVOICE_DRAFT_SKILL).toContain("## Only a person can");
    expect(INVOICE_DRAFT_SKILL).toContain("partnersinbiz.crm:find-records");
    expect(INVOICE_DRAFT_SKILL).toContain("partnersinbiz.cockpit:ask-owner");
    expect(INVOICE_DRAFT_SKILL).not.toMatch(/@-?mention|assign (it|the issue) to (a|the) (person|owner)/i);
    const skill = SKILLS[0]!;
    expect(skill.skillKey).toBe("invoice-draft");
    expect(skill.slug).toBe("pib-invoice-draft");
    expect(skill.markdown).toContain("## Company memory");
    expect(skill.markdown).toContain("## Asking a person");
  });

  it("stays within the 18,000 character budget, keeps the online-payment detail in a reference, and names the new tools", () => {
    const skill = SKILLS[0]!;
    expect((skill.markdown ?? "").length).toBeLessThanOrEqual(18_000);
    expect(skill.files?.map((f) => f.path)).toEqual(["references/online-payments.md"]);
    expect(skill.files![0]!.content).toBe(ONLINE_PAYMENTS_REFERENCE);
    expect(skill.markdown ?? "").toContain("references/online-payments.md");
    for (const tool of ["create-payment-link", "list-payment-links"]) expect(INVOICE_DRAFT_SKILL).toContain(`\`${tool}\``);
    // the person-only rules and the tool-result shape the skill promises
    expect(INVOICE_DRAFT_SKILL).toContain("You never refund");
    expect(INVOICE_DRAFT_SKILL).toContain("{ mode, total, count, offset, items, more, next }");
    // every status the reference tells an agent about is one the table can really hold
    for (const status of ["active", "paid", "cancelled", "needs_attention", "failed"]) expect(ONLINE_PAYMENTS_REFERENCE).toContain(`| ${status} |`);
  });

  it("every tool the skill reference names exists", () => {
    const names = new Set(BILLING_TOOLS.map((t) => t.name));
    const mentioned = [...ONLINE_PAYMENTS_REFERENCE.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)].map((m) => m[1]!).filter((n) => !["ask-owner"].includes(n));
    for (const name of mentioned) expect(names.has(name), name).toBe(true);
  });
});

describe("manifest", () => {
  it("keeps the package version, comments capability and the follow-up jobs", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(manifest.version).toBe(PKG_VERSION);
    expect(pkg.version).toBe(manifest.version);
    expect(manifest.capabilities).toContain("issue.comments.create");
    const jobs = new Map((manifest.jobs ?? []).map((j) => [j.jobKey, j.schedule]));
    expect(jobs.get("drafts-to-send")).toBe("30 4 * * *");
    expect(jobs.get("overdue-invoices")).toBe("45 4 * * 1");
    expect(jobs.get("post-missing-journals")).toBe("55 1 * * *");
    expect(manifest.tools).toBe(BILLING_TOOLS);
  });
});

describe("page tabs", () => {
  it("has at most six top tabs, each with its sections", () => {
    expect(TOP_TABS.length).toBeLessThanOrEqual(6);
    expect(tabsFor(false)).toEqual(["overview", "invoices", "quotes", "recurring", "costs", "time"]);
    expect(tabsFor(true)).toEqual(["overview", "invoices", "quotes", "recurring", "time"]);
    expect(sectionsFor("invoices", false).map((s) => s.view)).toEqual(["invoices", "payments", "credit-notes", "reminders"]);
    expect(sectionsFor("invoices", true).map((s) => s.view)).toEqual(["invoices", "payments", "credit-notes"]);
    for (const tab of Object.keys(TAB_SECTIONS)) expect(TAB_SECTIONS[tab as keyof typeof TAB_SECTIONS].length).toBeGreaterThan(0);
  });

  it("opens every pre-0.4 ?tab= value in the right tab and section", () => {
    const legacy: Record<string, [string, string]> = {
      overview: ["overview", "overview"],
      invoices: ["invoices", "invoices"],
      quotes: ["quotes", "quotes"],
      payments: ["invoices", "payments"],
      bills: ["costs", "bills"],
      expenses: ["costs", "expenses"],
      time: ["time", "time"],
      retainers: ["recurring", "retainers"],
      reports: ["overview", "reports"],
      reminders: ["invoices", "reminders"],
    };
    for (const [view, [tab, section]] of Object.entries(legacy)) expect(resolveView(view as View, false), view).toEqual({ tab, section });
    expect(resolveView("recurring", false)).toEqual({ tab: "recurring", section: "retainers" });
    expect(resolveView("costs", false)).toEqual({ tab: "costs", section: "bills" });
    for (const view of VIEW_IDS) {
      const { tab, section } = resolveView(view, false);
      expect(TAB_SECTIONS[tab].some((s) => s.view === section), view).toBe(true);
    }
  });

  it("sends a client's workspace from own-book views to the nearest tab it has", () => {
    expect(resolveView("bills", true)).toEqual({ tab: "overview", section: "overview" });
    expect(resolveView("expenses", true)).toEqual({ tab: "overview", section: "overview" });
    expect(resolveView("reports", true)).toEqual({ tab: "overview", section: "overview" });
    expect(resolveView("reminders", true)).toEqual({ tab: "invoices", section: "invoices" });
    expect(resolveView("payments", true)).toEqual({ tab: "invoices", section: "payments" });
  });
});

describe("overview lists", () => {
  const now = Date.parse("2026-09-27T12:00:00Z");
  const base = { currency: "ZAR", customerRef: "ct-1", customerName: "Lumen", totalMinor: 1000 };
  const snapshot: Snapshot = {
    invoices: [
      { ...base, id: "i1", number: "LUM-001", status: "draft", createdAt: "2026-09-25T10:00:00Z" },
      { ...base, id: "i2", number: "LUM-002", status: "draft", createdAt: "2026-09-27T10:00:00Z" },
      { ...base, id: "i3", number: "LUM-003", status: "draft", pendingAction: "send", approvalIssueId: "iss-send" },
      { ...base, id: "i4", number: "LUM-004", status: "draft", createdAt: "2026-09-01T10:00:00Z" },
      { ...base, id: "i5", number: "LUM-005", status: "sent", pendingAction: "pay", approvalIssueId: "iss-pay" },
    ],
    quotes: [
      { ...base, id: "q1", number: "Q-LUM-001", status: "draft", createdAt: "2026-09-20T10:00:00Z" },
      { ...base, id: "q2", number: "Q-LUM-002", status: "accepted", createdAt: "2026-09-10T10:00:00Z", acceptedAt: "2026-09-26T08:00:00Z" },
      { ...base, id: "q3", number: "Q-LUM-003", status: "sent", pendingAction: "send", approvalIssueId: "iss-q" },
    ],
    recurring: [{ id: "r1", templateInvoiceId: "i4", frequency: "monthly", nextRunAt: null, isActive: true, autoSend: false, endsAt: null }],
    pops: [{ id: "p1", invoiceId: "i5", invoiceNumber: "LUM-005", source: "agent", matchBasis: "agent", status: "pending", amountMinor: 1000, reference: null, fromEmail: null, fromName: null, subject: null, snippet: "paid", hasFile: false, fileName: null, attachments: [], issueId: "iss-pop", paymentId: null, rejectReason: null, receivedAt: null }],
    decisions: [
      { issueId: "iss-pay-dec", kind: "payment", title: "Record payment of R 10.00 on LUM-005", invoiceId: "i5", amountMinor: 1000, currency: "ZAR", createdAt: null },
      { issueId: "iss-rem", kind: "reminder", title: "Send payment reminder 1 for LUM-005", invoiceId: "i5", amountMinor: null, currency: null, createdAt: null },
      { issueId: "iss-pop", kind: "pop", title: "Check a proof of payment", invoiceId: null, amountMinor: null, currency: null, createdAt: null },
    ],
  };

  it("lists what waits on a person, money first, without duplicating proof checks", () => {
    const rand = (minor: number) => `R ${(minor / 100).toFixed(2)}`;
    const waiting = waitingOnPerson(snapshot, rand);
    expect(waiting.map((w) => [w.kind, w.issueId])).toEqual([
      ["money", "iss-pay"],
      ["money", "iss-pay-dec"],
      ["check", "iss-pop"],
      ["send", "iss-send"],
      ["send", "iss-q"],
      ["send", "iss-rem"],
    ]);
    expect(waiting.find((w) => w.issueId === "iss-rem")!.title).toBe("Approve: send payment reminder 1 for LUM-005");
    // A draft's number means nothing yet: the send approval names the client and the amount.
    expect(waiting.find((w) => w.issueId === "iss-send")!.title).toBe("Approve sending invoice to Lumen (R 10.00)");
    expect(waiting.find((w) => w.issueId === "iss-q")!.title).toBe("Approve sending quote to Lumen (R 10.00)");
    expect(waiting.find((w) => w.issueId === "iss-pay")!.title).toBe("Confirm payment of LUM-005 (Lumen)");
  });

  it("shows a draft as Draft · client · amount, and an issued document by its number", () => {
    const rand = (minor: number) => `R ${(minor / 100).toFixed(2)}`;
    expect(documentLabel({ ...base, number: "INV-9F0D9A85", status: "draft", totalMinor: 150_000 }, rand)).toBe("Draft · Lumen · R 1500.00");
    expect(documentLabel({ ...base, number: "LUM-002", status: "sent" }, rand)).toBe("LUM-002");
    expect(documentLabel({ ...base, customerName: null, number: "X", status: "draft" }, rand)).toBe("Draft · ct-1 · R 10.00");
  });

  it("says when payments are dated in the future", () => {
    const day = (value: string | null) => (value === "2026-09-28T00:00:00.000Z" ? "28 Sep" : String(value));
    expect(futurePaymentsText([], day)).toBeNull();
    expect(futurePaymentsText([{ invoiceId: "i2", number: "NOR-002", customerName: "Northwind", amountMinor: 575_000, currency: "ZAR", paidAt: "2026-09-28T00:00:00.000Z", count: 1 }], day))
      .toBe("1 payment dated in the future (28 Sep): it counts in no total until then. Check the date.");
    expect(futurePaymentsText([{ invoiceId: "a", number: "A", customerName: "A", amountMinor: 1, currency: "ZAR", paidAt: null, count: 2 }], day))
      .toBe("2 payments dated in the future: they count in no total until then. Check the date.");
  });

  it("lists drafts nobody asked to send, oldest first, flagging those over a day", () => {
    const drafts = draftsToSend(snapshot, now);
    expect(drafts.map((d) => [d.number, d.stale])).toEqual([
      ["Q-LUM-002", true],
      ["Q-LUM-001", true],
      ["LUM-001", true],
      ["LUM-002", false],
    ]);
    expect(drafts[0]!.note).toBe("Accepted: convert to an invoice");
  });
});
