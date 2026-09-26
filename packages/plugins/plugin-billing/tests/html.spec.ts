import { describe, expect, it } from "vitest";
import { buildInvoiceHtml } from "../src/domain.js";

describe("printable invoice", () => {
  const base = {
    number: "INV-0007",
    status: "draft",
    currency: "ZAR",
    sender: { name: "Partners in Biz", vatNumber: "4123456789", address: "1 Main Rd\nBallito" },
    customer: { name: "Acme <Ltd>", email: "ap@acme.test" },
    lines: [
      { description: "SEO sprint — month 1", quantity: 1, unitAmountMinor: 1_000_000 },
      { description: "Social management", quantity: 2, unitAmountMinor: 250_050 },
    ],
    dueAt: "2026-10-10T00:00:00.000Z",
  };

  it("prints real line descriptions, VAT and EFT details", () => {
    const html = buildInvoiceHtml({
      ...base,
      taxRate: 15,
      payment: { bankName: "FNB", accountNumber: "62000000000", branchCode: "250655" },
    });
    expect(html).toContain("SEO sprint — month 1");
    expect(html).toContain("Social management");
    expect(html).toContain("VAT 15%");
    expect(html).toMatch(/ZAR\s15,001\.00/);
    expect(html).toMatch(/ZAR\s2,250\.15/);
    expect(html).toMatch(/ZAR\s17,251\.15/);
    expect(html).toContain("Payment details (EFT)");
    expect(html).toContain("62000000000");
    expect(html).toContain("<th>Reference</th><td>INV-0007</td>");
    expect(html).toContain("VAT no. 4123456789");
    expect(html).toContain("Acme &lt;Ltd&gt;");
    expect(html).toContain("Due 2026-10-10");
  });

  it("titles quotes as quotes and omits bank details", () => {
    const html = buildInvoiceHtml({ ...base, kind: "Quote", number: "QTE-0002", payment: { bankName: "FNB" } });
    expect(html).toContain("<title>Quote QTE-0002</title>");
    expect(html).toContain("Valid until 2026-10-10");
    expect(html).not.toContain("Payment details");
    expect(html).not.toContain("VAT 0%");
  });
});
