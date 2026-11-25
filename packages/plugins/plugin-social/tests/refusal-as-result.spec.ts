import { describe, expect, it } from "vitest";
import { SocialError } from "../src/domain.js";
import { REFUSABLE_ACTIONS, refusalAsResult } from "../src/refusal.js";

const ctx = {} as never;
const viewer = {} as never;

describe("refusalAsResult", () => {
  it("returns a rule's message as a result so the page can show it", async () => {
    const run = refusalAsResult(async () => {
      throw new SocialError("The Reviewer has not passed this version yet. Its pass comes first in this scope.");
    });
    await expect(run(ctx, viewer, {})).resolves.toEqual({
      ok: false,
      error: { code: "SOCIAL_RULE", message: "The Reviewer has not passed this version yet. Its pass comes first in this scope." },
    });
  });

  it("passes a success through unchanged", async () => {
    const run = refusalAsResult(async () => ({ ok: true, post: { id: "p1" } }));
    await expect(run(ctx, viewer, {})).resolves.toEqual({ ok: true, post: { id: "p1" } });
  });

  it("still throws a real fault", async () => {
    const run = refusalAsResult(async () => {
      throw new Error("database is down");
    });
    await expect(run(ctx, viewer, {})).rejects.toThrow("database is down");
  });

  it("covers the approval buttons and leaves page loads alone", () => {
    for (const key of ["social.approve", "social.review", "social.back-to-draft", "social.schedule"]) expect(REFUSABLE_ACTIONS.has(key)).toBe(true);
    expect(REFUSABLE_ACTIONS.has("social.load")).toBe(false);
    expect(REFUSABLE_ACTIONS.has("social.get-post")).toBe(false);
  });
});
