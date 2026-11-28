/**
 * A board's CRM client link (PAR-14847; plan PAR-14835 Approach 3-5, Q3, Q7): the real `board-client` and
 * `board-client-set` actions, the board generation person path (card click) and agent path (a run on a board chat
 * thread), through the harness and the real worker. The fake `ctx.db` answers only the SQL these paths run and throws
 * on anything else. Postgres behaviour of the table is in board-clients.pg.spec.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { accessCompanyScope, MEMBER_RESTRICTED } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { STUDIO_ACCESS_TABLE } from "../src/access-table.js";
import { BOARD_MODELS } from "../src/ui/board-generate.js";

const CO = "c3600000-0000-4000-8000-000000000001";
const OWNER = "c3600000-0000-4000-8000-000000000011";
const ADMIN = "c3600000-0000-4000-8000-000000000012";
const MEMBER = "c3600000-0000-4000-8000-000000000013";
const VIEWER = "c3600000-0000-4000-8000-000000000014";
const RESTRICTED = "c3600000-0000-4000-8000-000000000015";
const RESTRICTED_ADMIN = "c3600000-0000-4000-8000-000000000016";
const AGENT = "c3600000-0000-4000-8000-000000000021";
const CLIENT_A = "c3600000-0000-4000-8000-0000000000ca";
const CLIENT_B = "c3600000-0000-4000-8000-0000000000cb";
const CLIENT_GONE = "c3600000-0000-4000-8000-0000000000cf";
const PROJECT_A = "project-a";
const PROJECT_DOWN = "project-down";
const BOARD = "b0a7d000-0000-4000-8000-000000000001";
const BOARD_2 = "b0a7d000-0000-4000-8000-000000000002";
const MODEL = BOARD_MODELS.find((m) => m.kind === "image" && m.minRefs === 0)!.id;

vi.mock("../src/scope.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/scope.js")>();
  return {
    ...real,
    projectClientStrict: async (_ctx: unknown, _co: string, projectId: string | null) => {
      if (projectId === PROJECT_DOWN) throw real.boardClientUnavailable();
      return projectId === PROJECT_A ? { kind: "company", id: CLIENT_A, name: "Acme", domain: null, lifecycle: null, email: null } : null;
    },
  };
});

beforeAll(() => {
  process.env.PIB_STUDIO_FAKE_PROVIDER = "1";
});
afterAll(() => {
  delete process.env.PIB_STUDIO_FAKE_PROVIDER;
});

type Link = { board_id: string; client_kind: string | null; client_ref: string | null; client_name: string | null; user_id: string };
const CRM = [
  { id: CLIENT_A, name: "Acme", domain: null, lifecycle: null },
  { id: CLIENT_B, name: "Globex", domain: null, lifecycle: null },
];

async function studio(opts: { linkDown?: boolean; links?: Link[]; generate?: boolean; run?: { issueId: string; person: string | null }; issues?: Array<{ id: string; projectId: string | null; originKind?: string; originId?: string }> } = {}) {
  const at = new Date().toISOString();
  const member = (userId: string, role: string) => ({ id: `m-${userId}`, companyId: CO, principalType: "user" as const, principalId: userId, status: "active" as const, membershipRole: role, grants: [], createdAt: at, updatedAt: at });
  const harness = createTestHarness({
    manifest,
    config: { r2: { accountId: "acct", bucket: "pib-private", accessKeyId: "AK", secretAccessKey: { type: "secret_ref", secretId: "sec-1" } }, boards: { generate: opts.generate ?? false } },
  });
  harness.seed({
    accessMembers: [member(OWNER, "owner"), member(ADMIN, "admin"), member(MEMBER, "member"), member(VIEWER, "viewer"), member(RESTRICTED, "member"), member(RESTRICTED_ADMIN, "admin")],
    issues: (opts.issues ?? []).map((i) => ({ ...i, companyId: CO, title: i.id, status: "todo" })) as never,
  });
  const links: Link[] = [...(opts.links ?? [])];
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const db = harness.ctx.db as { namespace: string; query: (sql: string, params?: unknown[]) => Promise<unknown[]>; execute: (sql: string, params?: unknown[]) => Promise<{ rowCount: number }> };
  db.namespace = "plugin_studio_test";
  db.query = async (sql, params = []) => {
    if (/FROM \S+\.board_client_links WHERE company_id = \$1 AND board_id = \$2 ORDER BY at DESC, id DESC LIMIT 1/.test(sql)) {
      if (opts.linkDown) throw new Error("link store down");
      const latest = links.filter((l) => params[0] === CO && l.board_id === params[1]).at(-1);
      return latest ? [latest] : [];
    }
    if (/FROM \S+\.crm_companies WHERE company_id = \$1 AND id = \$2 AND deleted = false/.test(sql)) return CRM.filter((c) => c.id === params[1]);
    if (/FROM \S+\.crm_companies WHERE company_id = \$1 AND deleted = false ORDER BY lower\(name\)/.test(sql)) return CRM;
    if (/FROM \S+\.crm_contacts WHERE company_id = \$1 AND deleted = false ORDER BY lower\(name\)/.test(sql)) return [];
    if (/FROM public\.heartbeat_runs/.test(sql)) return opts.run ? [{ issue_id: opts.run.issueId, responsible_user_id: opts.run.person }] : [];
    // The generation path: today's board count, the cap, the month's ledger and the run's spend.
    if (/SELECT COUNT\(\*\) AS n FROM \S+\.generations/.test(sql)) return [{ n: 0 }];
    if (/FROM \S+\.credit_limits/.test(sql)) return [{ scope_key: "company", monthly_credits: 100, updated_by: OWNER, updated_at: at }];
    if (/FROM \S+\.credit_ledger/.test(sql)) return [];
    throw new Error(`unexpected SQL in the fake: ${sql}`);
  };
  db.execute = async (sql, params = []) => {
    writes.push({ sql, params });
    if (/^INSERT INTO \S+\.board_client_links/.test(sql)) {
      const [, board_id, client_kind, client_ref, client_name, user_id] = params as [string, string, string | null, string | null, string | null, string];
      links.push({ board_id, client_kind, client_ref, client_name, user_id });
    }
    return { rowCount: 1 };
  };
  await plugin.definition.setup(harness.ctx);
  // Setup's access row is stored (off): with none, the guard refuses a restricted member before Studio's own rules (H3a).
  await harness.ctx.state.set(accessCompanyScope(CO), { mode: "off", rev: 1, userIds: [], receivedAt: new Date().toISOString() });
  const as = (userId: string, restricted = false) => ({ companyId: CO, actor: { type: "user" as const, userId, onBehalfOfUserId: userId, onBehalfOfRestricted: restricted } });
  const linkWrites = () => writes.filter((w) => /board_client_links/.test(w.sql));
  const genWrites = () => writes.filter((w) => !/board_client_links/.test(w.sql));
  return { harness, as, links, writes, linkWrites, genWrites };
}

const refused = (code: string) => expect.objectContaining({ ok: false, refused: true, code });
const linkTo = (client: string, name: string, user = OWNER, board = BOARD): Link => ({ board_id: board, client_kind: "company", client_ref: client, client_name: name, user_id: user });
const clear = (board = BOARD): Link => ({ board_id: board, client_kind: null, client_ref: null, client_name: null, user_id: OWNER });
const scope = (projectId: string | null = null, boardId = BOARD) => ({ boardScope: { projectId, boardId } });

describe("board-client: what the board's panel shows (AC3)", () => {
  it("an owner sees the effective link, where it came from, and the clients to pick from", async () => {
    const { harness, as } = await studio({ links: [linkTo(CLIENT_B, "Globex")] });
    expect(await harness.performAction("board-client", scope(), as(OWNER))).toEqual({
      effective: { kind: "company", ref: `company:${CLIENT_B}`, name: "Globex" }, source: "board", dormant: null, missing: null, canSet: true, withheld: false,
      clients: [{ kind: "company", ref: `company:${CLIENT_A}`, name: "Acme" }, { kind: "company", ref: `company:${CLIENT_B}`, name: "Globex" }],
    });
  });

  it("a member or viewer sees the link read-only, without the client list", async () => {
    const { harness, as } = await studio({ links: [linkTo(CLIENT_B, "Globex")] });
    for (const user of [MEMBER, VIEWER]) {
      const view = await harness.performAction("board-client", scope(), as(user));
      expect(view, user).toEqual({ effective: { kind: "company", ref: `company:${CLIENT_B}`, name: "Globex" }, source: "board", dormant: null, missing: null, canSet: false, withheld: false });
    }
  });

  it("a restricted member learns only that client work is there: withheld, no names", async () => {
    const { harness, as } = await studio({ links: [linkTo(CLIENT_B, "Globex")] });
    const view = await harness.performAction("board-client", scope(), as(RESTRICTED, true));
    expect(view).toEqual({ effective: null, source: "board", dormant: null, missing: null, canSet: false, withheld: true });
    expect(JSON.stringify(view)).not.toContain("Globex");
    // A restricted admin can't set either, and an own-work board is open to him.
    const own = await studio();
    expect(await own.harness.performAction("board-client", scope(), own.as(RESTRICTED_ADMIN, true))).toEqual({ effective: null, source: null, dormant: null, missing: null, canSet: false, withheld: false });
  });

  it("a restricted member on a project board with a client gets withheld (\"Client work\"), no names, no picker (PAR-15288)", async () => {
    const { harness, as } = await studio();
    for (const [user, label] of [[RESTRICTED, "member"], [RESTRICTED_ADMIN, "admin"]] as const) {
      const view = await harness.performAction("board-client", scope(PROJECT_A), as(user, true));
      expect(view, label).toEqual({ effective: null, source: "project", dormant: null, missing: null, canSet: false, withheld: true });
      expect(JSON.stringify(view)).not.toContain("Acme");
    }
  });

  it("a link to a client deleted in the CRM comes back as missing, so the panel can offer re-pick or clear", async () => {
    const { harness, as } = await studio({ links: [linkTo(CLIENT_GONE, "Gone Ltd")] });
    expect(await harness.performAction("board-client", scope(), as(OWNER))).toMatchObject({ effective: null, source: null, missing: { ref: `company:${CLIENT_GONE}`, name: "Gone Ltd" }, canSet: true });
  });

  it("on a project with a client, the project wins and the link is dormant; no boardId reads no link", async () => {
    const { harness, as } = await studio({ links: [linkTo(CLIENT_B, "Globex")] });
    expect(await harness.performAction("board-client", scope(PROJECT_A), as(OWNER))).toMatchObject({
      effective: { ref: `company:${CLIENT_A}`, name: "Acme" }, source: "project", dormant: { ref: `company:${CLIENT_B}`, name: "Globex" }, missing: null,
    });
    expect(await harness.performAction("board-client", { boardScope: { projectId: null } }, as(OWNER))).toMatchObject({ effective: null, source: null });
    expect(await harness.performAction("board-client", scope(PROJECT_DOWN), as(OWNER))).toEqual(refused("board_client_unavailable"));
  });
});

describe("board-client-set: owner or admin only (AC4, Q7)", () => {
  const set = (client: string | null, expected: string | null, projectId: string | null = null) => ({ ...scope(projectId), client, expected });

  it("an owner sets a link: one row with the client and the acting user", async () => {
    const { harness, as, linkWrites, links } = await studio();
    expect(await harness.performAction("board-client-set", set(`company:${CLIENT_B}`, null), as(OWNER))).toEqual({ changed: true, link: { kind: "company", ref: `company:${CLIENT_B}`, name: "Globex" } });
    expect(linkWrites()).toHaveLength(1);
    expect(linkWrites()[0]!.params).toEqual([CO, BOARD, "company", CLIENT_B, "Globex", OWNER]);
    expect(links.at(-1)).toMatchObject({ client_ref: CLIENT_B, user_id: OWNER });
  });

  it("an admin sets a link over an existing one", async () => {
    const { harness, as, linkWrites } = await studio({ links: [linkTo(CLIENT_B, "Globex")] });
    expect(await harness.performAction("board-client-set", set(`company:${CLIENT_A}`, `company:${CLIENT_B}`), as(ADMIN))).toMatchObject({ changed: true, link: { name: "Acme" } });
    expect(linkWrites().map((w) => w.params)).toEqual([[CO, BOARD, "company", CLIENT_A, "Acme", ADMIN]]);
  });

  it("an owner clears a link: one row with the client columns NULL; a clear with no link writes nothing", async () => {
    const { harness, as, linkWrites } = await studio({ links: [linkTo(CLIENT_B, "Globex")] });
    expect(await harness.performAction("board-client-set", set(null, `company:${CLIENT_B}`), as(OWNER))).toEqual({ changed: true, link: null });
    expect(linkWrites().map((w) => w.params)).toEqual([[CO, BOARD, null, null, null, OWNER]]);
    expect(await harness.performAction("board-client-set", set(null, null), as(OWNER))).toEqual({ changed: false, link: null });
    expect(linkWrites()).toHaveLength(1);
  });

  it("refusals write no row: member, viewer, restricted, stale expected, unknown client, project client, no board id", async () => {
    const { harness, as, linkWrites } = await studio({ links: [linkTo(CLIENT_B, "Globex")] });
    const act = (params: Record<string, unknown>, user = OWNER, restricted = false) => harness.performAction("board-client-set", params, as(user, restricted));
    expect(await act(set(`company:${CLIENT_A}`, `company:${CLIENT_B}`), MEMBER)).toEqual(refused("owner_or_admin_only"));
    expect(await act(set(`company:${CLIENT_A}`, `company:${CLIENT_B}`), VIEWER)).toEqual(refused("owner_or_admin_only"));
    expect(await act(set(`company:${CLIENT_A}`, `company:${CLIENT_B}`), RESTRICTED, true)).toEqual(refused(MEMBER_RESTRICTED));
    expect(await act(set(null, `company:${CLIENT_B}`), RESTRICTED_ADMIN, true)).toEqual(refused(MEMBER_RESTRICTED));
    // The panel showed no link, but someone linked Globex since.
    expect(await act(set(`company:${CLIENT_A}`, null))).toEqual(expect.objectContaining({ code: "link_changed", message: expect.stringContaining("Globex") }));
    expect(await act(set(`company:${CLIENT_GONE}`, `company:${CLIENT_B}`))).toEqual(refused("unknown_client"));
    expect(await act(set(`company:${CLIENT_B}`, null, PROJECT_A))).toEqual(refused("project_client"));
    expect(await act({ boardScope: { projectId: null }, client: `company:${CLIENT_A}`, expected: `company:${CLIENT_B}` })).toEqual(refused("bad_board_scope"));
    expect(await act({ ...scope(), client: `company:${CLIENT_A}` })).toEqual(refused("bad_request"));
    expect(await act(set("acme", `company:${CLIENT_B}`))).toEqual(refused("bad_client"));
    expect(await act(set(`company:${CLIENT_A}`, `company:${CLIENT_B}`, PROJECT_DOWN))).toEqual(refused("board_client_unavailable"));
    expect(linkWrites()).toEqual([]);
  });

  it("agents are refused by the real worker, with the person-only text (AC7)", async () => {
    const { harness, linkWrites } = await studio();
    const agent = { companyId: CO, actor: { type: "agent" as const, userId: null, agentId: AGENT, runId: "run-1" } };
    for (const [key, params] of [["board-client", scope()], ["board-client-set", set(`company:${CLIENT_B}`, null)]] as const) {
      expect(await harness.performAction(key, params, agent), key).toEqual(expect.objectContaining({ ok: false, refused: true, code: "forbidden", message: "Agents use the studio tools, not the Studio page." }));
    }
    expect(linkWrites()).toEqual([]);
  });

  it("the two keys have access rows: reading is view, setting is edit", () => {
    expect(STUDIO_ACCESS_TABLE["board-client"]).toEqual({ resource: "studio.work", action: "view" });
    expect(STUDIO_ACCESS_TABLE["board-client-set"]).toEqual({ resource: "studio.work", action: "edit" });
  });
});

describe("board generation charges the board's link (AC5)", () => {
  const card = (extra: Record<string, unknown> = {}) => ({ model: MODEL, prompt: "a lighthouse at dusk", ...scope(), inputKeys: [], ...extra });
  const genInsert = (writes: Array<{ sql: string; params: unknown[] }>) => writes.find((w) => /INSERT INTO \S+\.generations/.test(w.sql));

  it("person path: the linked client is injected server-side, the estimate names it, the row carries it", async () => {
    const { harness, as, genWrites } = await studio({ generate: true, links: [linkTo(CLIENT_B, "Globex")] });
    expect(await harness.performAction("estimate", card(), as(MEMBER))).toMatchObject({ client: `company:${CLIENT_B}`, clientName: "Globex" });
    expect(await harness.performAction("generate", card({ expectedClient: `company:${CLIENT_B}` }), as(MEMBER))).toMatchObject({ status: "queued", client: { kind: "company", id: CLIENT_B } });
    const insert = genInsert(genWrites())!;
    expect(insert.params.slice(3, 6)).toEqual(["company", CLIENT_B, "Globex"]);
  });

  it("person path: a client sent by the browser is still refused, and a boardId generate needs expectedClient", async () => {
    const { harness, as, genWrites } = await studio({ generate: true, links: [linkTo(CLIENT_B, "Globex")] });
    expect(await harness.performAction("generate", card({ client: `company:${CLIENT_B}`, expectedClient: `company:${CLIENT_B}` }), as(MEMBER))).toEqual(refused("bad_board_scope"));
    expect(await harness.performAction("generate", card(), as(MEMBER))).toEqual(refused("bad_request"));
    expect(genWrites()).toEqual([]);
  });

  it("person path: the link changed after the estimate -> board_client_changed, nothing reserved", async () => {
    const { harness, as, links, genWrites } = await studio({ generate: true, links: [linkTo(CLIENT_B, "Globex")] });
    expect(await harness.performAction("estimate", card(), as(MEMBER))).toMatchObject({ client: `company:${CLIENT_B}` });
    links.push(linkTo(CLIENT_A, "Acme", ADMIN));
    expect(await harness.performAction("generate", card({ expectedClient: `company:${CLIENT_B}` }), as(MEMBER))).toEqual(refused("board_client_changed"));
    links.push(clear());
    expect(await harness.performAction("generate", card({ expectedClient: `company:${CLIENT_A}` }), as(MEMBER))).toEqual(refused("board_client_changed"));
    expect(genWrites()).toEqual([]);
    // Own work confirmed as null goes through.
    expect(await harness.performAction("generate", card({ expectedClient: null }), as(MEMBER))).toMatchObject({ status: "queued", client: null });
  });

  it("person path: a restricted member on a linked board is refused before anything is priced", async () => {
    const { harness, as, genWrites } = await studio({ generate: true, links: [linkTo(CLIENT_B, "Globex")] });
    expect(await harness.performAction("estimate", card(), as(RESTRICTED, true))).toEqual(refused(MEMBER_RESTRICTED));
    expect(genWrites()).toEqual([]);
  });

  const thread = (id: string, boardId: string, suffix = ":chat") => ({ id, projectId: null, originKind: "planning_canvas", originId: `${boardId}${suffix}` });
  const run = { agentId: AGENT, runId: "run-1", companyId: CO, projectId: "" };
  type Tool = { data?: Record<string, unknown>; error?: string };

  it("agent path: a studio-generate run on a linked board's thread charges the linked client", async () => {
    const { harness, genWrites } = await studio({ generate: true, links: [linkTo(CLIENT_B, "Globex")], run: { issueId: "thread-1", person: OWNER }, issues: [thread("thread-1", BOARD)] });
    const out = await harness.executeTool<Tool>("studio-generate", { model: MODEL, prompt: "a lighthouse" }, run);
    expect(out.error).toBeUndefined();
    expect(out.data).toMatchObject({ status: "queued", client: { kind: "company", id: CLIENT_B } });
    const insert = genInsert(genWrites())!;
    expect(insert.params.slice(3, 6)).toEqual(["company", CLIENT_B, "Globex"]);
    expect(insert.params.slice(-3, -1)).toEqual(["board", OWNER]);
  });

  it("agent path: the same client is fine, another client is refused with wrong_client", async () => {
    const { harness, genWrites } = await studio({ generate: true, links: [linkTo(CLIENT_B, "Globex")], run: { issueId: "thread-1", person: OWNER }, issues: [thread("thread-1", BOARD, "")] });
    const other = await harness.executeTool<Tool>("studio-generate", { model: MODEL, prompt: "x", client: `company:${CLIENT_A}` }, run);
    expect(other.error).toMatch(/board for Globex, so it can only use Globex's Studio files/);
    expect(genWrites()).toEqual([]);
    const same = await harness.executeTool<Tool>("studio-generate", { model: MODEL, prompt: "x", client: `company:${CLIENT_B}` }, run);
    expect(same.data).toMatchObject({ client: { id: CLIENT_B } });
  });

  it("agent path: studio-estimate on the thread reports the linked client", async () => {
    const { harness } = await studio({ generate: true, links: [linkTo(CLIENT_B, "Globex")], run: { issueId: "thread-1", person: OWNER }, issues: [thread("thread-1", BOARD)] });
    const out = await harness.executeTool<Tool>("studio-estimate", { model: MODEL, prompt: "x" }, run);
    expect(out.data).toMatchObject({ client: `company:${CLIENT_B}`, clientName: "Globex", dailyLimit: 20 });
  });

  it("both paths fail closed: a link read that throws refuses estimate, generate, studio-estimate and studio-generate", async () => {
    const { harness, as, genWrites } = await studio({ generate: true, linkDown: true, run: { issueId: "thread-1", person: OWNER }, issues: [thread("thread-1", BOARD)] });
    expect(await harness.performAction("estimate", card(), as(MEMBER))).toEqual(refused("board_client_unavailable"));
    expect(await harness.performAction("generate", card({ expectedClient: null }), as(MEMBER))).toEqual(refused("board_client_unavailable"));
    for (const tool of ["studio-estimate", "studio-generate"]) {
      const out = await harness.executeTool<Tool>(tool, { model: MODEL, prompt: "x" }, run);
      expect(out.error, tool).toMatch(/couldn't read this board's client/);
    }
    expect(genWrites()).toEqual([]);
  });

  it("both paths: a link to a client deleted in the CRM refuses with linked_client_missing, nothing reserved", async () => {
    const { harness, as, genWrites } = await studio({ generate: true, links: [linkTo(CLIENT_GONE, "Gone Ltd")], run: { issueId: "thread-1", person: OWNER }, issues: [thread("thread-1", BOARD)] });
    expect(await harness.performAction("estimate", card(), as(MEMBER))).toEqual(refused("linked_client_missing"));
    expect(await harness.performAction("generate", card({ expectedClient: null }), as(MEMBER))).toEqual(refused("linked_client_missing"));
    expect((await harness.executeTool<Tool>("studio-generate", { model: MODEL, prompt: "x" }, run)).error).toMatch(/no longer in the CRM/);
    expect(genWrites()).toEqual([]);
  });

  it("agent path: threads of two different boards -> board_ambiguous, nothing started", async () => {
    const { harness, genWrites } = await studio({
      generate: true, links: [linkTo(CLIENT_B, "Globex")], run: { issueId: "thread-1", person: OWNER },
      issues: [thread("thread-1", BOARD), thread("thread-2", BOARD_2)],
    });
    const out = await harness.executeTool<Tool>("studio-generate", { model: MODEL, prompt: "x", issueId: "thread-2" }, run);
    expect(out.error).toMatch(/two different boards/);
    expect(genWrites()).toEqual([]);
  });
});
