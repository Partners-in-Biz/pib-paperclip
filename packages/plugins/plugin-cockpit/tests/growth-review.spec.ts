import { describe, expect, it } from "vitest";
import { channelPlugin, channelRole, growthHandoffContent, growthReviewContent, REVIEW_MAX_EXPERIMENTS, type ReviewScope } from "../src/growth-review.js";

const scope = (scopeKey: string, channels: ReviewScope["channels"]): ReviewScope => ({ scopeKey, channels });
const base = { weekLabel: "2026-10-05", cockpitHref: "/PAR/cockpit" };

describe("the owner issue", () => {
  it("lists a scope's verdicts under that scope only, so one client's rows never reach another's issue", () => {
    const one = growthReviewContent({ ...base, proposeGoals: false, scopes: [scope("client:company:c-one", [{ channel: "social", ledger: [{ experimentId: "exp-one", verdict: "win", relativeChange: 0.123, playbookDecision: "kept" }] }])] });
    const two = growthReviewContent({ ...base, proposeGoals: false, scopes: [scope("client:company:c-two", [{ channel: "seo", ledger: [] }])] });
    expect(one.description).toContain("exp-one");
    expect(one.description).toContain("+12.3%");
    expect(one.description).not.toContain("c-two");
    expect(two.description).not.toContain("exp-one");
    expect(two.description).not.toContain("c-one");
    expect(two.description).toContain("No verdicts reached the ledger this week.");
  });

  it("tells the owner to reconcile through ledger-upsert with the experiment's own time, and to close one line per channel", () => {
    const { description, title } = growthReviewContent({ ...base, proposeGoals: false, scopes: [scope("own", [{ channel: "social", ledger: [] }])] });
    expect(title).toBe("Weekly growth review: week of 2026-10-05");
    expect(description).toContain("`partnersinbiz.social:list-experiments` with scope `own`");
    expect(description).toContain("ledger-upsert");
    expect(description).toContain("`decidedAt`");
    expect(description).toContain("One line per channel");
  });

  it("asks for goal proposals only when asked to", () => {
    const scopes = [scope("own", [])];
    expect(growthReviewContent({ ...base, proposeGoals: true, scopes }).description).toContain("`goal-set`");
    expect(growthReviewContent({ ...base, proposeGoals: false, scopes }).description).not.toContain("goal-set");
  });

  it("escapes pipes so an experiment name cannot break the table", () => {
    const { description } = growthReviewContent({ ...base, proposeGoals: false, scopes: [scope("own", [{ channel: "social", ledger: [{ experimentId: "a|b", verdict: null, relativeChange: null, playbookDecision: null }] }])] });
    expect(description).toContain("a\\|b | pending | n/a | –");
  });
});

describe("the channel hand-off", () => {
  const content = growthHandoffContent({ weekLabel: "2026-10-05", channels: [{ channel: "seo", scopes: ["own", "client:company:c-one"] }, { channel: "social", scopes: ["own"] }] });

  it("names each channel's real tools for every scope and caps new experiments at two", () => {
    expect(REVIEW_MAX_EXPERIMENTS).toBe(2);
    expect(content.description).toContain("`partnersinbiz.seo:performance-review`");
    expect(content.description).toContain("`partnersinbiz.social:propose-experiment`");
    expect(content.description).toContain("Propose at most 2 new experiments");
    expect(content.description.match(/### `own`/g)).toHaveLength(2);
    expect(content.description).toContain("### `client:company:c-one`");
  });

  it("states who decides a pending playbook change on each autopilot level", () => {
    const text = content.description;
    expect(text).toContain("`full` decide each one yourself");
    expect(text).toContain("`reviewed` only the Reviewer decides");
    expect(text).toContain("`safe` or `off` leave it pending");
    expect(text).toContain("client-facing post still needs the person's approval");
  });
});

describe("channels", () => {
  it("routes social and seo to their roles and the rest to the Revenue Lead; an unknown channel still gets a plugin", () => {
    expect(channelRole("social")).toBe("social");
    expect(channelRole("seo")).toBe("seo-specialist");
    expect(channelRole("aso")).toBe("revenue-lead");
    expect(channelRole("tiktok")).toBe("revenue-lead");
    expect(channelPlugin("website")).toBe("partnersinbiz.cockpit");
    expect(channelPlugin("tiktok")).toBe("partnersinbiz.tiktok");
  });
});
