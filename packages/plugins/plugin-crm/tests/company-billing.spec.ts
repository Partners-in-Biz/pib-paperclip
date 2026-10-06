import { describe, expect, it } from "vitest";
import { boot, CO, tool, toolRaw } from "./helpers/crm.js";
import type { Row } from "./helpers/fake-db.js";

// The shared fake db answers the change-window query with nothing; here every company counts as changed.
const changedCompanies = [/FROM \S+\.companies\s+WHERE company_id = \$1 AND \(\$2::int IS NULL/, (p: unknown[], s: Record<string, Row[]>) => (s.companies ?? []).filter((row) => row.company_id === p[0])] as never;

const FIVE = { billingEmail: "Accounts@Acme.co.za", phone: "+27 21 555 0100", address: "1 Main Rd\nCape Town\n8001", vatNumber: "4123456789", registrationNumber: "2020/123456/07" };

describe("company billing details through the tools", () => {
  it("update-company saves the five fields, get-company returns them, and the next company.upserted event carries them", async () => {
    const { harness, store, emit } = await boot({ routes: [changedCompanies] });
    await tool(harness, "update-company", { companyRecordId: "company:acme", ...FIVE });
    const row = store.companies!.find((item) => item.id === "acme")!;
    expect(row).toMatchObject({ billing_email: "accounts@acme.co.za", phone: FIVE.phone, address: FIVE.address, vat_number: FIVE.vatNumber, registration_number: FIVE.registrationNumber });
    const got = await tool(harness, "get-company", { companyRecordId: "company:acme" });
    expect(got).toMatchObject({ billingEmail: "accounts@acme.co.za", phone: FIVE.phone, address: FIVE.address, vatNumber: FIVE.vatNumber, registrationNumber: FIVE.registrationNumber });
    expect(emit).toHaveBeenCalledWith(
      "company.upserted",
      CO,
      expect.objectContaining({
        id: "acme",
        billing: { email: "accounts@acme.co.za", phone: FIVE.phone, address: FIVE.address, vatNumber: FIVE.vatNumber, registrationNumber: FIVE.registrationNumber },
      }),
    );
  });

  it("update-company clears a field sent empty, leaves the others alone, and rejects a malformed email", async () => {
    const { harness, store } = await boot();
    await tool(harness, "update-company", { companyRecordId: "acme", ...FIVE });
    await tool(harness, "update-company", { companyRecordId: "acme", vatNumber: "" });
    expect(store.companies!.find((item) => item.id === "acme")).toMatchObject({ vat_number: null, phone: FIVE.phone });
    const bad = await toolRaw(harness, "update-company", { companyRecordId: "acme", billingEmail: "not-an-email" });
    expect(bad.error).toMatch(/valid email/);
    expect(store.companies!.find((item) => item.id === "acme")!.billing_email).toBe("accounts@acme.co.za");
  });

  it("update-company refuses a locked field for an agent and notes it", async () => {
    const { harness, store } = await boot();
    const row = store.companies!.find((item) => item.id === "acme")!;
    Object.assign(row, { vat_number: "4111111111", human_owned_fields: ["vatNumber"] });
    const out = await toolRaw(harness, "update-company", { companyRecordId: "acme", vatNumber: "4999999999", phone: "082 000 1111" });
    expect(out.error).toMatch(/Refused to overwrite human-owned fields: vatNumber/);
    expect(out.data!.refused).toEqual(["vatNumber"]);
    expect(row.vat_number).toBe("4111111111");
    expect(row.phone).toBe("082 000 1111");
    expect(store.facts!.some((fact) => fact.field_key === "vatNumber" && fact.refused === true)).toBe(true);
  });

  it("create-company that matches an existing record fills only the empty fields", async () => {
    const { harness, store } = await boot();
    const row = store.companies!.find((item) => item.id === "acme")!;
    Object.assign(row, { phone: "021 000 0000", vat_number: "4111111111", human_owned_fields: ["address"] });
    const out = await tool(harness, "create-company", { name: "Acme Plumbing", ...FIVE });
    expect(out).toMatchObject({ id: "acme", matched: true });
    expect(out.filled.sort()).toEqual(["billingEmail", "registrationNumber"]);
    expect(row).toMatchObject({ billing_email: "accounts@acme.co.za", registration_number: FIVE.registrationNumber, phone: "021 000 0000", vat_number: "4111111111", address: null });
  });

  it("create-company with a malformed billing email creates nothing", async () => {
    const { harness, store } = await boot();
    const before = store.companies!.length;
    const bad = await toolRaw(harness, "create-company", { name: "Initech", billingEmail: "nope" });
    expect(bad.error).toMatch(/valid email/);
    expect(store.companies!.length).toBe(before);
  });

  it("create-company stores the details on a new company, and find-records shows them", async () => {
    const { harness, store } = await boot();
    const out = await tool(harness, "create-company", { name: "Initech", domain: "initech.test", ...FIVE });
    expect(store.companies!.find((item) => item.id === out.id)).toMatchObject({ billing_email: "accounts@acme.co.za", address: FIVE.address, vat_number: FIVE.vatNumber });
    const found = await tool(harness, "find-records", { query: "initech", kind: "company" });
    expect(found.results[0]).toMatchObject({ name: "Initech", billingEmail: "accounts@acme.co.za", phone: FIVE.phone, address: FIVE.address, vatNumber: FIVE.vatNumber, registrationNumber: FIVE.registrationNumber });
  });
});
