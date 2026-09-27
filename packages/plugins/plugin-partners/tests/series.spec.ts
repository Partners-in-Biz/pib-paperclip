import { describe, expect, it } from "vitest";
import { acceptedByMe, partnerSummary, recordKind } from "../src/series.js";

const ME = "me";

describe("partner overview numbers", () => {
  it("reads the record kind from plain and prefixed types", () => {
    expect(recordKind("company")).toBe("company");
    expect(recordKind("billing.invoice")).toBe("invoice");
  });

  it("knows which side of a link already accepted", () => {
    expect(acceptedByMe({ id: "l", company_a_id: ME, company_b_id: "x", status: "pending", accepted_a: true }, ME)).toBe(true);
    expect(acceptedByMe({ id: "l", company_a_id: "x", company_b_id: ME, status: "pending", accepted_a: true, accepted_b: false }, ME)).toBe(false);
    expect(acceptedByMe({ id: "l", company_a_id: "x", company_b_id: "y", status: "pending" }, null)).toBe(false);
  });

  it("counts links and grants and ranks shared records by type and partner", () => {
    const summary = partnerSummary(
      [
        { id: "l1", company_a_id: ME, company_b_id: "p1", status: "active" },
        { id: "l2", company_a_id: ME, company_b_id: "p2", status: "pending", accepted_a: true },
        { id: "l3", company_a_id: "p3", company_b_id: ME, status: "pending", accepted_a: true },
      ],
      [
        { id: "g1", record_type: "company", record_id: "r1", status: "active", source_company_id: ME, grantee_company_id: "p1" },
        { id: "g2", record_type: "contact", record_id: "r2", status: "active", source_company_id: ME, grantee_company_id: "p1" },
        { id: "g3", record_type: "company", record_id: "r3", status: "active", source_company_id: "p2", grantee_company_id: ME },
        { id: "g4", record_type: "invoice", record_id: "r4", status: "proposed", source_company_id: "p2", grantee_company_id: ME },
        { id: "g5", record_type: "deal", record_id: "r5", status: "proposed", source_company_id: ME, grantee_company_id: "p1" },
        { id: "g6", record_type: "deal", record_id: "r6", status: "revoked", source_company_id: ME, grantee_company_id: "p1" },
      ],
      ME,
    );
    expect(summary).toEqual({
      activeLinks: 1,
      pendingLinks: 2,
      linksToAccept: 1,
      activeGrants: 3,
      // g5: our deal waiting for a yes here. g4 (their invoice) waits for them, not us.
      grantsToAccept: 1,
      grantsIncoming: 1,
      revokedGrants: 1,
      byType: [{ type: "company", count: 2 }, { type: "contact", count: 1 }],
      byPartner: [{ companyId: "p1", count: 2 }, { companyId: "p2", count: 1 }],
    });
  });
});
