/** PAR-10892: the Cockpit lead counts leave out a newsletter-origin contact (real Postgres). */
import { describe, expect, it } from "vitest";
import { createContact, NOT_NEWSLETTER_ORIGIN_SQL } from "../src/domain.js";
import { insertContact } from "../src/db.js";
import { NAMESPACE } from "../src/namespace.js";
import { embeddedAvailable, startPg } from "./helpers/pg.js";

const available = await embeddedAvailable();

describe.skipIf(!available)("newsletter origin on a real database", () => {
  it("counts a plain lead and leaves out a newsletter subscriber", async () => {
    const pg = await startPg();
    try {
      for (const [name, custom] of [["Plain", {}], ["Other origin", { origin: "form" }], ["Subscriber", { origin: "newsletter" }]] as const) {
        await insertContact(pg.ctx, createContact({ companyId: "co-1", name, emails: [`${name.replace(" ", "")}@x.test`], lifecycle: "lead", custom }));
      }
      const rows = await pg.ctx.db.query<{ n: string; open: string }>(
        `SELECT count(*) FILTER (WHERE lifecycle = 'lead' AND ${NOT_NEWSLETTER_ORIGIN_SQL})::text AS n,
                count(*) FILTER (WHERE lifecycle IN ('lead', 'prospect'))::text AS open
         FROM ${NAMESPACE}.contacts WHERE company_id = $1`, ["co-1"]);
      expect(rows[0]).toEqual({ n: "2", open: "3" });
    } finally {
      await pg.stop();
    }
  }, 120_000);
});
