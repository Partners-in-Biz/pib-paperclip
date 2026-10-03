import { describe, expect, it } from "vitest";
import { feedbackSignal, SIGNAL_MIN_BRIEFS, SIGNAL_THIN_BELOW } from "../src/memory/signal.js";
import { HIGHLY_USED, isToolBehaviourFact, owningModule, skillCandidates, skillCandidateTitle, type FactLike } from "../src/improvements-model.js";

describe("the memory feedback signal (Q2-7)", () => {
  it("is thin with too few briefs to read anything into", () => {
    const s = feedbackSignal(SIGNAL_MIN_BRIEFS - 1, 0);
    expect(s.level).toBe("thin");
    expect(s.message).toContain("too few to read anything into");
    expect(feedbackSignal(1, 1).message).toContain("Only 1 brief in 30 days");
  });

  it("is NO SIGNAL, never good news, when a real number of briefs got no feedback at all", () => {
    const s = feedbackSignal(199, 0);
    expect(s).toMatchObject({ level: "none", coverage: 0, briefs: 199, withFeedback: 0 });
    expect(s.message).toContain("NO SIGNAL");
    expect(s.message).toContain("Zero reports means nobody reported, not that the briefs were good");
    expect(s.message).toContain("do not say how Jev compares with the keyword baseline");
  });

  it("is thin below a fifth of briefs, ok from a fifth", () => {
    expect(feedbackSignal(100, 19).level).toBe("thin");
    expect(feedbackSignal(100, 19).message).toContain("19 of 100 briefs (19%)");
    expect(feedbackSignal(100, 100 * SIGNAL_THIN_BELOW).level).toBe("ok");
    expect(feedbackSignal(12, 3).message).toBe("3 of 12 briefs (25%) got feedback in 30 days: enough to read.");
    expect(feedbackSignal(10, 40).coverage).toBe(1); // never above all
  });

  it("with no briefs there is no coverage", () => {
    expect(feedbackSignal(0, 0).coverage).toBeNull();
  });
});

describe("facts that describe how a tool behaves (Q2-12)", () => {
  it("tells an instruction for a tool or skill from a fact about a client", () => {
    expect(isToolBehaviourFact("Call partnersinbiz.* tools as MCP tools, never over curl to /api/plugins/tools/execute.")).toBe(true);
    expect(isToolBehaviourFact("partnersinbiz.seo:complete-task fails unless the evidence field is set.")).toBe(true);
    expect(isToolBehaviourFact("A routine run must end with its turn: always detach builds and poll them.")).toBe(true);
    expect(isToolBehaviourFact("Northwind prefers posts on Tuesdays.")).toBe(false);
    expect(isToolBehaviourFact("The client's tool of choice is Figma and they want to approve everything.")).toBe(false);
    // "client" as an argument of a tool is still an instruction, not a client fact
    expect(isToolBehaviourFact("Always pass the client when you call partnersinbiz.seo tools.")).toBe(true);
    expect(isToolBehaviourFact("Invoices go out on the 25th.")).toBe(false);
  });

  it("names the module the fact is about", () => {
    expect(owningModule("Use partnersinbiz.social:create-post with a handoffKey")).toBe("social");
    expect(owningModule("Never call curl for tools")).toBeNull();
    expect(skillCandidateTitle({ text: "Use partnersinbiz.social:create-post with a handoffKey" })).toBe("Fold into the social skill: Use partnersinbiz.social:create-post with a handoffKey");
    expect(skillCandidateTitle({ text: "Never call tools over curl, use the MCP tools. ".repeat(5) }).length).toBeLessThan(140);
  });

  it("picks active company-wide facts that are pinned or much used, never a client's", () => {
    const fact = (id: string, extra: Partial<FactLike> = {}): FactLike => ({ id, text: "Never call tools over curl: use the MCP tools.", kind: "rule", pinned: true, useCount: 0, clientRef: null, status: "active", ...extra });
    const picked = skillCandidates([
      fact("pinned"),
      fact("used", { pinned: false, useCount: HIGHLY_USED }),
      fact("rarely", { pinned: false, useCount: HIGHLY_USED - 1 }),
      fact("client", { clientRef: "company:x" }),
      fact("archived", { status: "archived" }),
      fact("preference", { kind: "preference" }),
      fact("not-a-tool", { text: "Northwind prefers Tuesdays." }),
    ]);
    expect(picked.map((f) => f.id)).toEqual(["pinned", "used"]);
  });
});
