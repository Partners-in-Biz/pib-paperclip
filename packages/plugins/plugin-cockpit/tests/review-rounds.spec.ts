import { describe, expect, it } from "vitest";
import { fakeCtx } from "./helpers/fake-ctx.js";
import { countChangesRounds, REVIEW_ROUNDS_CAP } from "../src/review-rounds-model.js";
import { reviewRoundsCheck } from "../src/register-w1c-rounds.js";
import { CODE_REVIEW_REFERENCE } from "../src/skill-references.js";
import type { Env } from "../src/env.js";

const COMPANY = "co-1";
const CHANGES = "Important: x\nREVIEW: CHANGES NEEDED sha=0123456789ab ci=green";
const PASS = "REVIEW: PASS sha=0123456789ab ci=green";

function world() {
  const w = fakeCtx({
    agents: [
      { id: "cr", companyId: COMPANY, name: "Code Reviewer", role: "qa", title: "Code Reviewer", status: "active" },
      { id: "pl", companyId: COMPANY, name: "Planner", role: "pm", title: "Planner", status: "active" },
      { id: "dev", companyId: COMPANY, name: "Developer", role: "engineer", title: "Developer", status: "active" },
    ],
  });
  const env = { ctx: w.ctx, now: () => new Date("2026-11-04T10:00:00Z") } as unknown as Env;
  const issueId = "iss-1";
  const say = (author: string | null, body: string) => {
    w.comments.push({ id: `c${w.comments.length + 1}`, issueId, body, companyId: COMPANY, authorAgentId: author, authorUserId: null, createdAt: new Date().toISOString() } as never);
  };
  const run = () => reviewRoundsCheck(env, { eventId: "e", eventType: "issue.comment.created", occurredAt: "", companyId: COMPANY, entityId: issueId, entityType: "issue", payload: null } as never);
  const caps = () => w.comments.filter((c) => /round cap reached, handing to planner/i.test(c.body));
  return { w, say, run, caps };
}

describe("review rounds cap", () => {
  it("rounds 1 and 2: no action", async () => {
    const { say, run, caps } = world();
    say("cr", CHANGES); await run();
    say("cr", CHANGES); await run();
    expect(caps()).toHaveLength(0);
  });

  it("round 3 hands over once, mentioning the Planner, and not twice", async () => {
    const { say, run, caps } = world();
    for (let i = 0; i < REVIEW_ROUNDS_CAP; i++) say("cr", CHANGES);
    await run(); await run();
    say("cr", CHANGES); await run();
    expect(caps()).toHaveLength(1);
    expect(caps()[0]!.body).toContain("agent://pl");
  });

  it("a PASS between rounds does not reset the count", async () => {
    const { say, run, caps } = world();
    say("cr", CHANGES); say("cr", PASS); say("cr", CHANGES); say("cr", PASS); say("cr", CHANGES);
    await run();
    expect(caps()).toHaveLength(1);
  });

  it("other authors are ignored", async () => {
    const { say, run, caps } = world();
    say("dev", CHANGES); say("dev", CHANGES); say("dev", CHANGES); say(null, CHANGES); say("cr", CHANGES);
    await run();
    expect(caps()).toHaveLength(0);
    expect(countChangesRounds([{ authorAgentId: "dev", body: CHANGES }], ["cr"])).toBe(0);
  });

  it("counts per comment, not per sha", () => {
    expect(countChangesRounds([{ authorAgentId: "cr", body: CHANGES }, { authorAgentId: "cr", body: CHANGES }], ["cr"])).toBe(2);
  });
});

describe("code-review reference", () => {
  it("holds the three-round line, the tags and the verdict line", () => {
    expect(CODE_REVIEW_REFERENCE).toContain("After **THREE** rounds do not start a fourth");
    for (const t of ["Important", "Nit", "Pre-existing", "REVIEW: PASS sha=<12hex> ci=<green|red>", "REVIEW: CHANGES NEEDED sha=<12hex> ci=<green|red>", "diff-only", "Planner"]) expect(CODE_REVIEW_REFERENCE).toContain(t);
  });
});
