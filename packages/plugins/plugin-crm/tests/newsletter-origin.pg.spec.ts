/** PAR-10892: the Cockpit lead counts leave out a newsletter-origin contact (real Postgres, the shipped cockpitSnapshot). */
import { describe, expect, it } from "vitest";
import { cockpitSnapshot } from "../src/cockpit.js";
import { createContact } from "../src/domain.js";
import { insertContact } from "../src/db.js";
import { NAMESPACE } from "../src/namespace.js";
import { embeddedAvailable, startPg } from "./helpers/pg.js";

const available = await embeddedAvailable();

describe.skipIf(!available)("newsletter origin on a real database", () => {
  it("cockpitSnapshot counts a plain lead and a prospect and leaves out a newsletter subscriber", async () => {
    const pg = await startPg();
    try {
      const seed = [
        ["Plain", "lead", {}],
        ["Subscriber", "lead", { origin: "newsletter" }],
        ["Prospect", "prospect", {}],
      ] as const;
      for (const [name, lifecycle, custom] of seed) {
        await insertContact(pg.ctx, createContact({ companyId: "co-1", name, emails: [`${name}@x.test`], lifecycle, custom }));
      }
      // Plain lead and subscriber are scored; the prospect is not.
      await pg.ctx.db.execute(`UPDATE ${NAMESPACE}.contacts SET lead_scored_at = now() WHERE company_id = $1 AND name IN ('Plain', 'Subscriber')`, ["co-1"]);

      const snap = await cockpitSnapshot(pg.ctx, "co-1");
      // new_leads_week: Plain only (the prospect is not a lead, the subscriber is left out).
      expect(snap.kpis.find((k) => k.key === "new_leads_week")?.raw).toBe(1);
      // open_leads = Plain + Prospect = 2; scored_leads = Plain = 1. Without the helper these read 3 and 2.
      expect(snap.quality?.find((m) => m.key === "lead_score_coverage")?.value).toBe("50% (1 of 2)");
    } finally {
      await pg.stop();
    }
  }, 120_000);
});
