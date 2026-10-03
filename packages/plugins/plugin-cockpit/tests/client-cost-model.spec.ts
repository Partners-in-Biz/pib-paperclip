import { describe, expect, it } from "vitest";
import { clientEffortChecks, clientEfforts, EFFORT, effortBrief, type ClientRef, type Payment, type ProjectSpend } from "../src/client-cost-model.js";

const project = (id: string, name: string, usd: number, extra: Partial<ProjectSpend> = {}): ProjectSpend => ({ projectId: id, name, usd, runs: 10, doneIssues: 4, ...extra });
const client = (ref: string, name: string, extra: Partial<ClientRef> = {}): ClientRef => ({ clientRef: `company:${ref}`, name, lifecycle: "customer", linkedProjectIds: [], ...extra });
const paid = (ref: string | null, rand: number, currency = "ZAR"): Payment => ({ clientRef: ref ? `company:${ref}` : null, totalMinor: Math.round(rand * 100), currency });

describe("tying projects to clients", () => {
  it("prefers the CRM's links, then a project named after the client, and never gives one project to two clients", () => {
    const rows = clientEfforts({
      projects: [project("p1", "Brightside Dental", 60), project("p2", "Website rebuild", 40), project("p3", "Brightside Dental", 5), project("p4", "Northwind", 30)],
      clients: [
        client("a", "Brightside Dental", { linkedProjectIds: ["p2"] }), // the link wins over the name
        client("b", "Northwind"),
        client("c", "Brightside Dental"), // same name again: only what is left
      ],
      payments: [],
      usdRate: 18,
    });
    const a = rows.find((r) => r.clientRef === "company:a")!;
    expect(a).toMatchObject({ matchedBy: "link", usd: 40 });
    expect(a.projects.map((p) => p.projectId)).toEqual(["p2"]);
    expect(rows.find((r) => r.clientRef === "company:b")).toMatchObject({ matchedBy: "name", usd: 30 });
    const c = rows.find((r) => r.clientRef === "company:c")!;
    expect(c.projects.map((p) => p.projectId).sort()).toEqual(["p1", "p3"]);
    expect(c.usd).toBe(65);
    const all = rows.flatMap((r) => r.projects.map((p) => p.projectId));
    expect(new Set(all).size).toBe(all.length);
  });

  it("leaves out clients with no project, matches names loosely (case and punctuation), and orders by spend", () => {
    const rows = clientEfforts({
      projects: [project("p1", "ACME, Ltd.", 10), project("p2", "Big Co", 90)],
      clients: [client("a", "acme ltd"), client("b", "Big Co"), client("z", "Nobody")],
      payments: [],
      usdRate: 18,
    });
    expect(rows.map((r) => r.name)).toEqual(["Big Co", "acme ltd"]);
  });

  it("ignores a project with no id (spend the host could not place)", () => {
    expect(clientEfforts({ projects: [{ projectId: null, name: null, usd: 500, runs: 5, doneIssues: 0 }], clients: [client("a", "Anyone")], payments: [], usdRate: 18 })).toEqual([]);
  });
});

describe("what a client paid", () => {
  const base = { projects: [project("p1", "Brightside", 60)], clients: [client("a", "Brightside")], usdRate: 18 };

  it("converts USD at the rate, counts ZAR as it is, leaves other currencies out and says so", () => {
    const [row] = clientEfforts({ ...base, payments: [paid("a", 1000), paid("a", 50, "usd"), paid("a", 400, "EUR"), paid("b", 9999)] });
    expect(row!.paidZar).toBe(1900); // 1000 + 50 * 18
    expect(row!.skippedCurrencies).toEqual(["EUR"]);
    expect(row!.ratio).toBeCloseTo(0.57, 2); // 60 * 18 / 1900
  });

  it("has no ratio when nothing was paid, rather than dividing by zero", () => {
    const [row] = clientEfforts({ ...base, payments: [] });
    expect(row).toMatchObject({ paidZar: 0, ratio: null });
  });

  it("the rate changes the answer", () => {
    const pay = [paid("a", 1000)];
    expect(clientEfforts({ ...base, payments: pay, usdRate: 18 })[0]!.ratio).toBeCloseTo(1.08, 2);
    expect(clientEfforts({ ...base, payments: pay, usdRate: 10 })[0]!.ratio).toBeCloseTo(0.6, 2);
  });
});

describe("the alerts", () => {
  const row = (over: Partial<ReturnType<typeof clientEfforts>[number]> = {}) => ({
    clientRef: "company:a",
    name: "Brightside",
    lifecycle: "customer",
    matchedBy: "link" as const,
    projects: [],
    usd: 60,
    runs: 10,
    doneIssues: 4,
    paidZar: 1900,
    skippedCurrencies: [] as string[],
    ratio: 0.57,
    ...over,
  });

  it("warns when effort is at least half of what the customer paid, red from the whole of it", () => {
    expect(clientEffortChecks([row({ ratio: 0.49 })])).toEqual([]);
    const warn = clientEffortChecks([row({ ratio: 0.5 })]);
    expect(warn).toHaveLength(1);
    expect(warn[0]).toMatchObject({ key: "client-effort:company:a", status: "warn", title: "Brightside: agent effort is 50% of what they paid", href: "/cockpit?client=company:a" });
    expect(clientEffortChecks([row({ ratio: 1 })])[0]!.status).toBe("bad");
    expect(warn[0]!.detail).toContain("Notional spend is list price, not a bill");
    expect(warn[0]!.fix).toContain("Do not stop client-facing work without telling the owner");
  });

  it("honours the alert ratio from the settings", () => {
    expect(clientEffortChecks([row({ ratio: 0.57 })], { alertRatio: 0.8 })).toEqual([]);
    expect(clientEffortChecks([row({ ratio: 0.57 })], { alertRatio: 0.25 })).toHaveLength(1);
  });

  it("only customers, and only effort that is not noise", () => {
    expect(clientEffortChecks([row({ lifecycle: "lead", ratio: 3 })])).toEqual([]);
    expect(clientEffortChecks([row({ usd: EFFORT.minUsd - 1, ratio: 3 })])).toEqual([]);
    expect(clientEffortChecks([row({ usd: EFFORT.minUsd, ratio: 3 })])).toHaveLength(1);
  });

  it("flags real effort with nothing paid in the window, and says to chase the invoice", () => {
    expect(clientEffortChecks([row({ paidZar: 0, ratio: null, usd: EFFORT.noRevenueUsd - 1 })])).toEqual([]);
    const [check] = clientEffortChecks([row({ paidZar: 0, ratio: null, usd: 150 })]);
    expect(check).toMatchObject({ status: "warn", title: "Brightside: $150 of agent effort and nothing paid in 30 days" });
    expect(check!.fix).toContain("Account Manager follows up on overdue invoices");
  });

  it("names the currencies it left out", () => {
    const [check] = clientEffortChecks([row({ ratio: 0.9, skippedCurrencies: ["EUR", "GBP"] })]);
    expect(check!.detail).toContain("Invoices in EUR, GBP are left out.");
  });

  it("the ranking for the weekly retro is capped at twelve and carries the rate it used", () => {
    const rows = Array.from({ length: 15 }, (_, i) => row({ clientRef: `company:${i}`, name: `C${i}` }));
    const brief = effortBrief(rows, 17.5);
    expect(brief).toHaveLength(12);
    expect(brief[0]).toMatchObject({ client: "C0", ref: "company:0", notionalUsd: 60, paidZar: 1900, effortVsPaid: 0.57, rateUsed: 17.5 });
  });
});
