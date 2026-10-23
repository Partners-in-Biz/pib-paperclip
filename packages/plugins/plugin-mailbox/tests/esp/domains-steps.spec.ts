import { describe, expect, it } from "vitest";
import { dnsInstructions } from "../../src/esp/domains.js";
import type { EspDomainRow } from "../../src/esp/types.js";

describe("DNS instructions for domain setup", () => {
  const baseRow = (overrides?: { provider?: "resend" | "ses"; records?: EspDomainRow["records"] }): Pick<EspDomainRow, "domain" | "records" | "status"> & { provider?: "resend" | "ses" } => {
    const row: Pick<EspDomainRow, "domain" | "records" | "status"> & { provider?: "resend" | "ses" } = {
      domain: "updates.client.co.za",
      status: "pending",
      records: overrides?.records ?? [],
    };
    if (overrides?.provider) row.provider = overrides.provider;
    return row;
  };

  describe("Amazon SES: three DKIM CNAMEs, MX and TXT only with MAIL FROM", () => {
    it("shows DKIM CNAMEs separate from MAIL FROM records", () => {
      const row = baseRow({
        provider: "ses",
        records: [
          // Three DKIM CNAMEs (SES tokens)
          { type: "CNAME", name: "tok1abc._domainkey", fqdn: "tok1abc._domainkey.updates.client.co.za", value: "tok1abc.dkim.amazonses.com", record: "DKIM", purpose: "DKIM: lets receivers check that SES signed the mail as this domain.", priority: null, ttl: null, status: "pending" },
          { type: "CNAME", name: "tok2def._domainkey", fqdn: "tok2def._domainkey.updates.client.co.za", value: "tok2def.dkim.amazonses.com", record: "DKIM", purpose: "DKIM: lets receivers check that SES signed the mail as this domain.", priority: null, ttl: null, status: "pending" },
          { type: "CNAME", name: "tok3ghi._domainkey", fqdn: "tok3ghi._domainkey.updates.client.co.za", value: "tok3ghi.dkim.amazonses.com", record: "DKIM", purpose: "DKIM: lets receivers check that SES signed the mail as this domain.", priority: null, ttl: null, status: "pending" },
          // MAIL FROM: MX and TXT
          { type: "MX", name: "mail", fqdn: "mail.updates.client.co.za", value: "feedback-smtp.eu-north-1.amazonses.com", record: "SPF", purpose: "Custom MAIL FROM: bounces come back to SES at this host.", priority: 10, ttl: null, status: "pending" },
          { type: "TXT", name: "mail", fqdn: "mail.updates.client.co.za", value: "v=spf1 include:amazonses.com ~all", record: "SPF", purpose: "SPF for the custom MAIL FROM host, so SPF aligns with the domain.", priority: null, ttl: null, status: "pending" },
        ],
      });
      const result = dnsInstructions(row);
      expect(result.provider).toBe("ses");
      expect(result.steps[0]).toContain("For updates.client.co.za");
      expect(result.steps[0]).toContain("3 DKIM CNAME records");
      // Check that DKIM lines are numbered
      const dkimLinesMatch = result.steps.filter((s) => /^\d+\. CNAME record at/.test(s));
      expect(dkimLinesMatch.length).toBe(3);
      // Check that MAIL FROM section exists
      expect(result.steps.some((s) => s.includes("When a custom MAIL FROM is set"))).toBe(true);
      const mailFromLines = result.steps.filter((s) => /^\d+\. (MX|TXT) record at/.test(s));
      expect(mailFromLines.length).toBe(2);
    });

    it("shows DKIM CNAMEs only when MAIL FROM is not set", () => {
      const row = baseRow({
        provider: "ses",
        records: [
          // Three DKIM CNAMEs only (no MAIL FROM)
          { type: "CNAME", name: "tok1abc._domainkey", fqdn: "tok1abc._domainkey.updates.client.co.za", value: "tok1abc.dkim.amazonses.com", record: "DKIM", purpose: "DKIM: lets receivers check that SES signed the mail as this domain.", priority: null, ttl: null, status: "pending" },
          { type: "CNAME", name: "tok2def._domainkey", fqdn: "tok2def._domainkey.updates.client.co.za", value: "tok2def.dkim.amazonses.com", record: "DKIM", purpose: "DKIM: lets receivers check that SES signed the mail as this domain.", priority: null, ttl: null, status: "pending" },
          { type: "CNAME", name: "tok3ghi._domainkey", fqdn: "tok3ghi._domainkey.updates.client.co.za", value: "tok3ghi.dkim.amazonses.com", record: "DKIM", purpose: "DKIM: lets receivers check that SES signed the mail as this domain.", priority: null, ttl: null, status: "pending" },
        ],
      });
      const result = dnsInstructions(row);
      expect(result.provider).toBe("ses");
      const dkimLinesMatch = result.steps.filter((s) => /^\d+\. CNAME record at/.test(s));
      expect(dkimLinesMatch.length).toBe(3);
      // MAIL FROM section should not appear
      expect(result.steps.some((s) => s.includes("When a custom MAIL FROM is set"))).toBe(false);
      // No MX or TXT lines
      const mailFromLines = result.steps.filter((s) => /^\d+\. (MX|TXT) record at/.test(s));
      expect(mailFromLines.length).toBe(0);
    });

    it("reads the identity status from the SES console in the afterwards step", () => {
      const row = baseRow({ provider: "ses" });
      const result = dnsInstructions(row);
      expect(result.afterwards).toContain("SES console");
      expect(result.afterwards).toContain("Identities tab");
      expect(result.afterwards).toContain("verified for sending");
    });
  });

  describe("Resend: original formatting unchanged", () => {
    it("numbers all records in one list and says they go at the registered domain zone", () => {
      const row = baseRow({
        provider: "resend",
        records: [
          { type: "MX", name: "send.updates", fqdn: "send.updates.client.co.za", value: "feedback-smtp.eu-west-1.amazonses.com", record: "SPF", purpose: "Bounce mail goes here.", priority: 10, ttl: null, status: "pending" },
          { type: "TXT", name: "send.updates", fqdn: "send.updates.client.co.za", value: "v=spf1 include:amazonses.com ~all", record: "SPF", purpose: "SPF for the return-path host.", priority: null, ttl: null, status: "pending" },
          { type: "TXT", name: "resend._domainkey", fqdn: "resend._domainkey.updates.client.co.za", value: "v=DKIM1; k=rsa; p=...", record: "DKIM", purpose: "DKIM key", priority: null, ttl: null, status: "pending" },
        ],
      });
      const result = dnsInstructions(row);
      expect(result.provider).toBe("resend");
      // Resend steps should have the original format
      expect(result.steps[0]).toContain("At the DNS host for client.co.za");
      expect(result.steps[0]).toContain("these 3 records");
      // Lines are numbered 1, 2, 3 in order
      const numberedLines = result.steps.filter((s) => /^\d+\./.test(s));
      expect(numberedLines.length).toBe(3);
      expect(numberedLines[0]).toMatch(/^1\./);
      expect(numberedLines[1]).toMatch(/^2\./);
      expect(numberedLines[2]).toMatch(/^3\./);
    });

    it("says the provider asks every hour (not SES language)", () => {
      const row = baseRow({ provider: "resend" });
      const result = dnsInstructions(row);
      expect(result.afterwards).toContain("asks it to look again every hour");
    });
  });

  describe("backwards compatibility: default to Resend", () => {
    it("uses Resend formatting when provider is not specified", () => {
      const row = baseRow({
        provider: undefined,
        records: [
          { type: "TXT", name: "resend._domainkey", fqdn: "resend._domainkey.updates.client.co.za", value: "v=DKIM1; k=rsa; p=...", record: "DKIM", purpose: "DKIM key", priority: null, ttl: null, status: "pending" },
        ],
      });
      const result = dnsInstructions(row);
      // Defaults to Resend
      expect(result.provider).toBe("resend");
      // Steps should be Resend-style (the default)
      expect(result.steps[0]).toContain("At the DNS host");
    });
  });

  describe("whoAddsIt wording is provider-agnostic", () => {
    it("is identical for both providers", () => {
      const row = baseRow();
      const resend = dnsInstructions({ ...row, provider: "resend" });
      const ses = dnsInstructions({ ...row, provider: "ses" });
      expect(resend.whoAddsIt).toBe(ses.whoAddsIt);
      expect(resend.whoAddsIt).toContain("Whoever controls the DNS of client.co.za");
      expect(resend.whoAddsIt).toContain("An agent cannot edit DNS");
      expect(resend.whoAddsIt).toContain("partnersinbiz.cockpit:ask-owner");
    });
  });
});
