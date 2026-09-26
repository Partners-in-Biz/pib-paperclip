import { describe, expect, it } from "vitest";
import { accountTypeCode, BANK_FILE_NOTICE, buildAcbCsv, buildAcbTxt, buildBankFile, buildNetCashCsv, validateBankRows, type BankPaymentRow } from "../src/bank-files.js";

const rows: BankPaymentRow[] = [
  { beneficiaryName: "Thandi Nkosi", bankName: "FNB", accountNumber: "62812345678", branchCode: "250655", accountType: "current", amountMinor: 2_514_188, reference: "SALARY SEP 2026", ownReference: "E001", actionDate: "2026-09-25" },
  { beneficiaryName: "Sipho, Dube", bankName: "Capitec", accountNumber: "1234 5678 90", branchCode: "470-010", accountType: "savings", amountMinor: 594_000, reference: "SALARY SEP 2026", ownReference: "E002", actionDate: "2026-09-25" },
];

describe("ACB", () => {
  it("writes record type 10 credit lines with cents and rand", () => {
    const file = buildAcbCsv(rows);
    const lines = file.content.trimEnd().split("\n");
    expect(lines[0]).toBe("# ACB-style EFT batch (payroll)");
    expect(lines[1]).toBe(`# ${BANK_FILE_NOTICE}`);
    expect(lines[2]).toBe("RecordType,BranchCode,AccountNumber,AccountType,AmountCents,Amount,ActionDate,BeneficiaryName,StatementReference,OwnReference,BankName,Currency");
    expect(lines[3]).toBe("10,250655,62812345678,1,2514188,25141.88,20260925,Thandi Nkosi,SALARY SEP 2026,E001,FNB,ZAR");
    // Digits only for branch and account; a comma in the name is quoted; savings = 2.
    expect(lines[4]).toBe('10,470010,1234567890,2,594000,5940.00,20260925,"Sipho, Dube",SALARY SEP 2026,E002,Capitec,ZAR');
    expect(file.rows).toBe(2);
    expect(file.totalMinor).toBe(3_108_188);
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("writes the pipe-delimited text with a trailer", () => {
    const lines = buildAcbTxt(rows).content.trimEnd().split("\n");
    expect(lines[0]).toBe("H|ACB|payroll|DOWNLOAD_ONLY");
    expect(lines[2]).toBe("D|10|250655|62812345678|1|2514188|20260925|Thandi Nkosi|SALARY SEP 2026|E001|ZAR");
    expect(lines[lines.length - 1]).toBe("T|2|3108188");
  });
});

describe("NetCash", () => {
  it("writes the batch with rand amounts and no notification columns filled", () => {
    const lines = buildNetCashCsv(rows).content.trimEnd().split("\n");
    expect(lines[2]).toBe("Account reference,Name,Branch code,Account number,Account type,Amount,Extra 1,Extra 2,Email notification,Mobile notification");
    expect(lines[3]).toBe("E001,Thandi Nkosi,250655,62812345678,1,25141.88,SALARY SEP 2026,FNB,,");
    expect(lines[4]).toBe('E002,"Sipho, Dube",470010,1234567890,2,5940.00,SALARY SEP 2026,Capitec,,');
  });
});

describe("validation", () => {
  it("maps account types", () => {
    expect(accountTypeCode("savings")).toBe("2");
    expect(accountTypeCode("transmission")).toBe("3");
    expect(accountTypeCode("cheque")).toBe("1");
    expect(accountTypeCode(undefined)).toBe("1");
  });

  it("refuses bad rows instead of writing a broken file", () => {
    const bad = [{ ...rows[0]!, branchCode: "123", amountMinor: 0 }];
    expect(validateBankRows(bad)).toEqual(["E001: the branch code must be 6 digits", "E001: the amount must be more than zero"]);
    expect(() => buildBankFile("acb", bad, "PR-1")).toThrow(/cannot be built/);
    expect(buildBankFile("netcash", rows, "PR-2026-09-M01").name).toBe("PR-2026-09-M01-netcash.csv");
  });
});
