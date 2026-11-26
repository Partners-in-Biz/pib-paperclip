/**
 * The board client link table against real Postgres (PAR-14847; plan PAR-14835 Approach 1, AC1): migration 008 runs
 * with the others, a set, a second set and a clear each write one row and the latest row is the link after each; the
 * CHECK refuses a half-null row and an unknown client kind; the reads and writes pass the host's SQL rules.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { setBoardClient } from "../src/board-clients.js";
import { projectClientStrict } from "../src/scope.js";
import { boardTarget, latestBoardLink } from "../src/board-scope.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";

const CO = "22222222-2222-4222-8222-222222222222";
const BOARD = "b0a7d000-0000-4000-8000-0000000000aa";
const OWNER = "owner-1";
const ADMIN = "admin-1";
const available = await embeddedAvailable();
let pg: Pg;

beforeAll(async () => {
  if (available) pg = await startPg();
}, 120_000);
afterAll(async () => {
  if (available) await pg.stop();
});

describe("board client links database support", () => {
  // Opt-in (STUDIO_REQUIRE_PG=1), not CI: the deploy runner sets CI but has no embedded Postgres, so every pg suite skips there.
  it.runIf(Boolean(process.env.STUDIO_REQUIRE_PG))("runs its database tests when Postgres is required", () => expect(available).toBe(true));
});

describe("projectClientStrict: the board's project read fails closed", () => {
  it("a CRM read that throws refuses with board_client_unavailable; no project is no client, without a read", async () => {
    let reads = 0;
    const ctx = { db: { namespace: "plugin_studio_test", query: async () => { reads += 1; throw new Error("crm down"); } }, state: { get: async () => null } } as unknown as PluginContext;
    await expect(projectClientStrict(ctx, CO, "project-1")).rejects.toMatchObject({ code: "board_client_unavailable" });
    expect(await projectClientStrict(ctx, CO, null)).toBeNull();
    // The companies and contacts reads of the first call only.
    expect(reads).toBe(2);
  });
});

function makeCtx(db: Pg["db"]): PluginContext {
  return {
    db,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    config: { get: async () => ({ boards: {} }) },
    state: { get: async () => null, set: async () => undefined, delete: async () => undefined },
  } as unknown as PluginContext;
}

const T = (name: string) => `${pg.db.namespace}.${name}`;

describe.skipIf(!available)("board_client_links (migration 008)", () => {
  let ctx: PluginContext;

  beforeEach(async () => {
    await pg.reset();
    ctx = makeCtx(pg.db);
    const now = new Date().toISOString();
    for (const [id, name] of [["acme", "Acme Ltd"], ["globex", "Globex"]]) {
      await pg.client.query(`INSERT INTO ${T("crm_companies")} (id, company_id, name, updated_at) VALUES ($1, $2, $3, $4)`, [id, CO, name, now]);
    }
  });

  const rows = async () =>
    (await pg.client.query(`SELECT client_kind, client_ref, client_name, user_id FROM ${T("board_client_links")} WHERE company_id = $1 AND board_id = $2 ORDER BY at, id`, [CO, BOARD])).rows;
  const set = (client: string | null, expected: string | null, userId = OWNER) =>
    setBoardClient(ctx, CO, { boardScope: { projectId: null, boardId: BOARD }, client, expected }, { role: userId === ADMIN ? "admin" : "owner", userId, restriction: "unrestricted" });

  it("a set, a second set and a clear: one row each, and the latest row is the link after each", async () => {
    expect(await latestBoardLink(ctx, CO, BOARD)).toBeNull();

    expect(await set("company:acme", null)).toEqual({ changed: true, link: { kind: "company", ref: "company:acme", name: "Acme Ltd" } });
    expect(await latestBoardLink(ctx, CO, BOARD)).toEqual({ kind: "company", id: "acme", name: "Acme Ltd" });
    expect(await boardTarget(ctx, CO, { projectId: null, boardId: BOARD })).toMatchObject({ client: { kind: "company", id: "acme" }, source: "board" });

    expect(await set("company:globex", "company:acme", ADMIN)).toMatchObject({ changed: true, link: { name: "Globex" } });
    expect(await latestBoardLink(ctx, CO, BOARD)).toEqual({ kind: "company", id: "globex", name: "Globex" });

    expect(await set(null, "company:globex")).toEqual({ changed: true, link: null });
    expect(await latestBoardLink(ctx, CO, BOARD)).toBeNull();
    expect(await boardTarget(ctx, CO, { projectId: null, boardId: BOARD })).toMatchObject({ client: null, source: null });

    expect(await rows()).toEqual([
      { client_kind: "company", client_ref: "acme", client_name: "Acme Ltd", user_id: OWNER },
      { client_kind: "company", client_ref: "globex", client_name: "Globex", user_id: ADMIN },
      { client_kind: null, client_ref: null, client_name: null, user_id: OWNER },
    ]);
  });

  it("a clear with no link and a stale expected write nothing", async () => {
    expect(await set(null, null)).toEqual({ changed: false, link: null });
    await set("company:acme", null);
    await expect(set("company:globex", null)).rejects.toMatchObject({ code: "link_changed" });
    expect(await rows()).toHaveLength(1);
  });

  it("another company's rows and another board's rows are not this board's link", async () => {
    await pg.client.query(`INSERT INTO ${T("board_client_links")} (company_id, board_id, client_kind, client_ref, client_name, user_id) VALUES ($1, $2, 'company', 'acme', 'Acme Ltd', 'x')`, ["33333333-3333-4333-8333-333333333333", BOARD]);
    await pg.client.query(`INSERT INTO ${T("board_client_links")} (company_id, board_id, client_kind, client_ref, client_name, user_id) VALUES ($1, $2, 'company', 'acme', 'Acme Ltd', 'x')`, [CO, "b0a7d000-0000-4000-8000-0000000000bb"]);
    expect(await latestBoardLink(ctx, CO, BOARD)).toBeNull();
  });

  it("the CHECK refuses a half-null row and an unknown client kind", async () => {
    const insert = (kind: string | null, ref: string | null, name: string | null) =>
      pg.client.query(`INSERT INTO ${T("board_client_links")} (company_id, board_id, client_kind, client_ref, client_name, user_id) VALUES ($1, $2, $3, $4, $5, 'u')`, [CO, BOARD, kind, ref, name]);
    await expect(insert("company", "acme", null)).rejects.toThrow(/board_client_links_all_or_none/);
    await expect(insert(null, "acme", "Acme Ltd")).rejects.toThrow(/board_client_links_all_or_none/);
    await expect(insert("company", null, null)).rejects.toThrow(/board_client_links_all_or_none/);
    await expect(insert("person", "acme", "Acme Ltd")).rejects.toThrow(/board_client_links_all_or_none/);
    await insert(null, null, null);
    await insert("contact", "c-1", "Jo");
    expect(await rows()).toHaveLength(2);
  });

  it("the index for the latest-row read exists", async () => {
    const index = (await pg.client.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'board_client_links_latest'")).rows as Array<{ indexdef: string }>;
    expect(index[0]?.indexdef).toMatch(/\(company_id, board_id, at DESC, id DESC\)/);
  });
});
