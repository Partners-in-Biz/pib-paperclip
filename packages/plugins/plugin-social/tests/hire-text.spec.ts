/** The social hire text is read by client agents: no owner company named. */
import { describe, expect, it } from "vitest";
import { hireTaskDraft } from "@partnersinbiz/pib-plugin-kit";
import { SOCIAL_HIRE_INSTRUCTIONS, SOCIAL_HIRE_ROLE } from "../src/hire.js";

describe("social hire template", () => {
  it("names no owner company", () => {
    const draft = hireTaskDraft(SOCIAL_HIRE_ROLE);
    const text = [SOCIAL_HIRE_INSTRUCTIONS, JSON.stringify(SOCIAL_HIRE_ROLE), draft.title, draft.description].join("\n");
    expect(text).not.toContain("Partners in Biz");
    expect(text).not.toMatch(/\bPiB\b/);
  });
});
