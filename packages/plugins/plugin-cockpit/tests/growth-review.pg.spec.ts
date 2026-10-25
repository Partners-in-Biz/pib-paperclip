/**
 * The weekly growth review job (Postgres): owner issue and channel hand-offs
 * open once a week, and one company's scopes never reach another company.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JOBS, ORIGIN } from "../src/constants.js";
import { COMPANY, OTHER_COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { saveTeam } from "../src/roles.js";
import { startWorlds } from "./helpers/hybrid.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const A = COMPANY;
const OP_A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const OP_B = "bbbbbbbb-0000-4000-8000-0000000000b1";
const NOW = "2026-10-05T04:30:00.000Z"; // a Monday
const SOCIAL = "plugin.partnersinbiz.social.growth.verdict";
const verdict = (scope: string, experimentId: string) => ({ scope, experimentId, verdict: "win", relativeChange: 0.1, items: 9, minPerArm: 3, playbookDecision: "pending", decidedAt: "2026-10-02T08:00:00.000Z" });

d("the weekly growth review (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  const make = async () => {
    const w = await worlds.make(
      {
        savedConfigs: { [A]: { healthIssue: true }, [OTHER_COMPANY]: { healthIssue: true } },
        prefixes: { [A]: "PAR" },
        agents: [
          { id: OP_A, companyId: A, name: "Olive", status: "active", role: "general" },
          { id: OP_B, companyId: OTHER_COMPANY, name: "Omar", status: "active", role: "general" },
        ],
      },
      NOW,
    );
    await saveTeam(w.env, A, { operatorAgentId: OP_A }, "user-owner");
    await saveTeam(w.env, OTHER_COMPANY, { operatorAgentId: OP_B }, "user-owner");
    return w;
  };
  const reviews = (w: Awaited<ReturnType<typeof make>>, companyId: string) => [...w.issues.values()].filter((i) => i.originKind === ORIGIN.growthReview && i.companyId === companyId);

  it("opens an owner issue and the hand-offs, and not another set for the same week", async () => {
    const w = await make();
    await w.fire(SOCIAL, { companyId: A, payload: verdict("client:company:c-one", "exp-one") });
    await w.jobs.get(JOBS.growthReview)!();
    const first = reviews(w, A).length;
    expect(first).toBeGreaterThanOrEqual(2);
    const all = reviews(w, A);
    expect(all.some((i) => String(i.title).startsWith("Weekly growth review:"))).toBe(true);
    expect(all.some((i) => String(i.title).includes("hand-off"))).toBe(true);
    expect(all.find((i) => String(i.title).startsWith("Weekly growth review:"))!.description).toContain("exp-one");
    await w.jobs.get(JOBS.growthReview)!();
    expect(reviews(w, A)).toHaveLength(first);
  });

  it("keeps company A's scopes out of company B's issues", async () => {
    const w = await make();
    await w.fire(SOCIAL, { companyId: A, payload: verdict("client:company:only-a", "exp-a") });
    await w.jobs.get(JOBS.growthReview)!();
    const other = reviews(w, OTHER_COMPANY);
    for (const issue of other) {
      expect(String(issue.description)).not.toContain("only-a");
      expect(String(issue.description)).not.toContain("exp-a");
    }
    expect(reviews(w, A).some((i) => String(i.description).includes("only-a"))).toBe(true);
  });
});
