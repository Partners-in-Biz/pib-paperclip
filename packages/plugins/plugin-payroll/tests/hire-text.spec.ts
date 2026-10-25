/** The Payroll Clerk's instructions are read by client agents: no owner company named. */
import { describe, expect, it } from "vitest";
import { hireTaskDraft } from "@partnersinbiz/pib-plugin-kit";
import { CLERK_INSTRUCTIONS, CLERK_ROLE } from "../src/hire.js";

describe("payroll hire template", () => {
  it("names no owner company", () => {
    expect(CLERK_INSTRUCTIONS.split("\n")[0]).toBe("# Payroll Clerk");
    expect(JSON.stringify(CLERK_ROLE)).not.toContain("Partners in Biz");
    const draft = hireTaskDraft(CLERK_ROLE);
    expect(`${draft.title}\n${draft.description}`).not.toContain("Partners in Biz");
  });
});
