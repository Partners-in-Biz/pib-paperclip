import { describe, expect, it } from "vitest";
import {
  assertNoPlaintext,
  luhnValid,
  maskTail,
  masksFor,
  normaliseBank,
  normaliseIdentity,
  normaliseTax,
  openDetails,
  payrollKeyring,
  sealDetails,
  validateSaId,
  validateTaxReference,
  type BankDetails,
} from "../src/pii.js";
import { assertMaskedOutput } from "../src/tools.js";

const keyring = payrollKeyring("company-1", "a-long-enough-payroll-secret");
const bank: BankDetails = { bankName: "FNB", branchCode: "250655", accountNumber: "62812345678", accountType: "current", accountHolder: "Thandi Nkosi" };

describe("sealing", () => {
  it("round-trips and never stores plaintext", () => {
    const sealed = sealDetails(bank, keyring);
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain("62812345678");
    expect(sealed).not.toContain("250655");
    expect(openDetails<BankDetails>(sealed, keyring)).toEqual(bank);
  });

  it("uses a different ciphertext each time and a per-company key", () => {
    expect(sealDetails(bank, keyring)).not.toBe(sealDetails(bank, keyring));
    const other = payrollKeyring("company-2", "a-long-enough-payroll-secret");
    expect(() => openDetails(sealDetails(bank, keyring), other)).toThrow();
  });

  it("opens values sealed with the previous key while rotating", () => {
    const old = payrollKeyring("company-1", "the-old-payroll-secret-value");
    const sealed = sealDetails(bank, old);
    const rotated = payrollKeyring("company-1", "the-new-payroll-secret-value", { version: 1, secret: "the-old-payroll-secret-value" }, 2);
    expect(openDetails<BankDetails>(sealed, rotated)).toEqual(bank);
    expect(sealDetails(bank, rotated).startsWith("v2.")).toBe(true);
  });

  it("refuses a short key", () => {
    expect(() => payrollKeyring("c", "short")).toThrow(/16 characters/);
  });
});

describe("masks", () => {
  it("keeps only the last digits", () => {
    expect(maskTail("62812345678")).toBe("••••••5678");
    expect(maskTail("0123456789", 3)).toBe("••••••789");
    expect(maskTail("")).toBeNull();
    const masks = masksFor({ idNumber: "9001015009086", passportNumber: null, passportCountry: null }, { taxReference: "0123456789" }, bank);
    expect(masks).toEqual({ idNumber: "••••••086", passportNumber: null, taxReference: "••••••789", bankName: "FNB", accountNumber: "••••••5678", accountType: "current" });
    expect(JSON.stringify(masks)).not.toMatch(/\d{5,}/);
  });
});

describe("validation", () => {
  it("checks SA ID numbers (Luhn and date of birth)", () => {
    expect(luhnValid("9001015009086")).toBe(true);
    expect(validateSaId("9001015009086", 2026)).toEqual({ valid: true, dateOfBirth: "1990-01-01" });
    expect(validateSaId("0405015009088", 2026).dateOfBirth).toBe("2004-05-01");
    expect(validateSaId("9001015009087").valid).toBe(false);
    expect(validateSaId("9013015009081").valid).toBe(false);
    expect(validateSaId("12345").reason).toMatch(/13 digits/);
  });

  it("checks tax reference numbers", () => {
    expect(validateTaxReference("0123456789")).toBe(true);
    expect(validateTaxReference("9123456789")).toBe(true);
    expect(validateTaxReference("5123456789")).toBe(false);
    expect(validateTaxReference("012345678")).toBe(false);
    expect(() => normaliseTax({ taxReference: "5123456789" })).toThrow(/10 digits/);
  });

  it("normalises bank details and identity", () => {
    expect(normaliseBank({ bankName: "Capitec", branchCode: "470 010", accountNumber: "1234-5678-90", accountType: "Savings", accountHolder: "Sipho" })).toEqual({ bankName: "Capitec", branchCode: "470010", accountNumber: "1234567890", accountType: "savings", accountHolder: "Sipho" });
    expect(() => normaliseBank({ bankName: "X", branchCode: "12", accountNumber: "123456", accountHolder: "A" })).toThrow(/6 digits/);
    expect(() => normaliseIdentity({})).toThrow(/ID number or a passport/);
    expect(normaliseIdentity({ passportNumber: "a1234567", passportCountry: "zwe" })).toEqual({ idNumber: null, passportNumber: "A1234567", passportCountry: "ZWE" });
  });
});

describe("output guards", () => {
  it("refuses tool output that carries a full number", () => {
    expect(() => assertMaskedOutput({ employees: [{ bank: "FNB ••••••5678", start: "2026-09-01", amountMinor: 123456789012 }] })).not.toThrow();
    expect(() => assertMaskedOutput({ employee: { accountNumber: "62812345678" } })).toThrow(/unmasked/);
    expect(() => assertMaskedOutput({ note: "ID 9001015009086 on file" })).toThrow(/unmasked/);
    expect(() => assertMaskedOutput(["0123 456 789"])).toThrow(/unmasked/);
  });

  it("finds a secret anywhere in a payload", () => {
    expect(() => assertNoPlaintext({ a: { b: ["x 62812345678 y"] } }, ["62812345678"])).toThrow();
    expect(() => assertNoPlaintext({ a: "••••5678" }, ["62812345678", null])).not.toThrow();
  });
});
