import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const available = await embeddedAvailable();

describe.skipIf(!available)("audience_mode check (postgres)", () => {
  let h: PgHarness;
  beforeAll(async () => {
    h = await startPg();
  }, 60_000);
  afterAll(async () => {
    await h?.stop();
  });
  const add = (id: string, mode: string | null) =>
    h.client.query(
      mode === null
        ? `INSERT INTO ${NAMESPACE}.campaigns (id, company_id, name, status) VALUES ($1, 'c', 'n', 'draft')`
        : `INSERT INTO ${NAMESPACE}.campaigns (id, company_id, name, status, audience_mode) VALUES ($1, 'c', 'n', 'draft', '${mode}')`,
      [id],
    );

  it("accepts the three old values, the default and the new client_list", async () => {
    await add("d", null);
    for (const [i, m] of ["tags", "client_contacts", "client_contact", "client_list"].entries()) await add(`m${i}`, m);
    const rows = (await h.client.query(`SELECT audience_mode FROM ${NAMESPACE}.campaigns ORDER BY id`)).rows;
    expect(rows).toHaveLength(5);
  });

  it("an update to client_list passes and an unknown value is still refused", async () => {
    await h.client.query(`UPDATE ${NAMESPACE}.campaigns SET audience_mode = 'client_list' WHERE id = 'm0'`);
    await expect(add("bad", "everyone")).rejects.toThrow(/campaigns_audience_mode/);
  });
});
