/**
 * Hire templates are read by the client's own agents, so they must not name
 * the owner company. The kit's contract scan only covers skill text.
 */
import { describe, expect, it } from "vitest";
import { hireTaskDraft } from "@partnersinbiz/pib-plugin-kit";
import { HIRE_ROLES, OPERATOR_INSTRUCTIONS, REVIEWER_INSTRUCTIONS } from "../src/hire.js";

describe("cockpit hire templates", () => {
  it("name no owner company in the instructions headings", () => {
    expect(OPERATOR_INSTRUCTIONS.split("\n")[0]).toBe("# Operator (Chief of staff)");
    expect(REVIEWER_INSTRUCTIONS.split("\n")[0]).toBe("# Reviewer (Quality reviewer)");
  });

  for (const [kind, role] of Object.entries(HIRE_ROLES)) {
    it(`${kind} role and its hire task never contain "Partners in Biz"`, () => {
      expect(JSON.stringify(role)).not.toContain("Partners in Biz");
      const draft = hireTaskDraft(role);
      expect(`${draft.title}\n${draft.description}`).not.toContain("Partners in Biz");
      expect(draft.description).not.toContain("## Notes");
    });
  }
});
