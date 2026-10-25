/** The ads hire text is read by client agents: no owner company named. */
import { describe, expect, it } from "vitest";
import { hireTaskDraft } from "@partnersinbiz/pib-plugin-kit";
import { ADS_HIRE_INSTRUCTIONS, ADS_HIRE_ROLE } from "../src/hire.js";

describe("ads hire template", () => {
  it("names no owner company", () => {
    const draft = hireTaskDraft(ADS_HIRE_ROLE);
    const text = [ADS_HIRE_INSTRUCTIONS, JSON.stringify(ADS_HIRE_ROLE), draft.title, draft.description].join("\n");
    expect(text).not.toContain("Partners in Biz");
    expect(text).not.toMatch(/\bPiB\b/);
  });
});
