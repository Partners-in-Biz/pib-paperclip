import { describe, expect, it } from "vitest";
import { crmDirectory, emptyDirectory, invoiceName, lookupsFor, recordHref, recordLabel, sharedKind } from "../src/records.js";
import { linkState, otherCompany } from "../src/series.js";

describe("shared record names", () => {
  const crm = crmDirectory({
    data: {
      accounts: [{ id: "co-1", name: "Northwind" }, { id: "co-bad", name: "  " }],
      contacts: [{ id: "ct-1", name: "Ada Lovelace" }],
      deals: [{ id: "d-1", title: "Website rebuild" }],
    },
  });

  it("reads company, contact and deal names from the CRM page data, plain or wrapped", () => {
    expect([...crm.companies]).toEqual([["co-1", "Northwind"]]);
    expect(crm.contacts.get("ct-1")).toBe("Ada Lovelace");
    expect(crm.deals.get("d-1")).toBe("Website rebuild");
    expect(crmDirectory({ accounts: [{ id: "x", name: "Plain" }] }).companies.get("x")).toBe("Plain");
    expect(crmDirectory(null).companies.size).toBe(0);
  });

  it("names an invoice by number and client; a draft has no number yet", () => {
    expect(invoiceName({ invoice: { number: "NOR-001", customerName: "Northwind" } })).toBe("NOR-001 · Northwind");
    expect(invoiceName({ data: { invoice: { number: null, customerName: "Northwind" } } })).toBe("Draft · Northwind");
    expect(invoiceName({})).toBeNull();
  });

  it("shows the name and kind with a link to where the record lives, never the id", () => {
    const directory = { ...emptyDirectory(), ...crm };
    directory.invoices.set("inv-1", "NOR-001 · Northwind");
    expect(recordLabel({ record_type: "company", record_id: "co-1" }, directory)).toMatchObject({
      text: "Northwind (company)", name: "Northwind", kindWord: "company", href: "/crm?client=company%3Aco-1", where: "CRM", found: true,
    });
    expect(recordLabel({ record_type: "crm.contact", record_id: "ct-1" }, directory).text).toBe("Ada Lovelace (contact)");
    expect(recordLabel({ record_type: "deal", record_id: "d-1" }, directory)).toMatchObject({ text: "Website rebuild (deal)", href: "/crm?tab=deals" });
    expect(recordLabel({ record_type: "invoice", record_id: "inv-1" }, directory)).toMatchObject({ text: "NOR-001 · Northwind (invoice)", where: "Billing", href: "/billing?tab=invoices" });
    const unknown = recordLabel({ record_type: "company", record_id: "3347ba94-1711-4492-9f2b-3603232a3393" }, directory);
    expect(unknown).toMatchObject({ text: "A company (name not available)", found: false });
    expect(unknown.text).not.toContain("3347ba94");
  });

  it("asks the CRM once and Billing once per invoice", () => {
    expect(lookupsFor([
      { record_type: "company", record_id: "a" },
      { record_type: "deal", record_id: "b" },
      { record_type: "invoice", record_id: "i1" },
      { record_type: "invoice", record_id: "i1" },
      { record_type: "invoice", record_id: "i2" },
    ])).toEqual({ crm: true, invoiceIds: ["i1", "i2"] });
    expect(lookupsFor([{ record_type: "invoice", record_id: "i1" }])).toEqual({ crm: false, invoiceIds: ["i1"] });
    expect(sharedKind("widget")).toBeNull();
    expect(recordHref("contact", "ct-9")).toBe("/crm?client=contact%3Act-9");
  });
});

describe("partner link state", () => {
  const ME = "me";
  it("says who a pending link waits for", () => {
    expect(linkState({ id: "l", company_a_id: ME, company_b_id: "p", status: "active" }, ME)).toBe("active");
    expect(linkState({ id: "l", company_a_id: ME, company_b_id: "p", status: "pending", accepted_a: true }, ME)).toBe("waiting-for-partner");
    expect(linkState({ id: "l", company_a_id: "p", company_b_id: ME, status: "pending", accepted_a: true, accepted_b: false }, ME)).toBe("waiting-for-you");
    expect(otherCompany({ id: "l", company_a_id: "p", company_b_id: ME, status: "pending" }, ME)).toBe("p");
    expect(otherCompany({ id: "l", company_a_id: ME, company_b_id: "p", status: "pending" }, ME)).toBe("p");
  });
});
