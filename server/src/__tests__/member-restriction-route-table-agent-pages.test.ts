import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agentApiKeys, agents, authUsers, companies, companyMemberships, createDb } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { agentAvatarRoutes } from "../routes/agent-avatars.js";
import { agentRoutes } from "../routes/agents.js";
import { aiConnectionRoutes } from "../routes/ai-connections.js";
import { builtInAgentRoutes } from "../routes/built-in-agents.js";
import { costRoutes } from "../routes/costs.js";
import { instanceSettingsRoutes } from "../routes/instance-settings.js";
import { resourceMembershipRoutes } from "../routes/resource-memberships.js";
import { createAgentAvatarService } from "../services/agent-avatars.js";
import { loadActorMemberships } from "../services/member-restriction/actor-memberships.js";
import { withoutHostKeys } from "../services/member-restriction/response-strip.js";
import { memberRestrictionRouteGuard } from "../services/member-restriction/route-middleware.js";
import { MEMBER_RESTRICTION_ROUTE_TABLE, createRouteClassifier } from "../services/member-restriction/route-table.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-13473 (C4g-4), decision PAR-13469 rev 1 sections 2 and 5 "T1": the
 * reduced agent gains `companyId` (six fields, AC-G4 amended), the avatar row
 * is `open`, and seven rows are `closed` as a recorded choice. Each test runs R
 * (restricted in Y, owner in X) at `enforce` through the real route guard and
 * the real resolver, with the owner O as control. Decision tests 1 to 7.
 */

const resolverFails = vi.hoisted(() => ({ on: false }));
vi.mock("../services/member-restriction/resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/member-restriction/resolver.js")>();
  const fail = () => Promise.reject(new actual.MemberRestrictionReadError("fixture: restriction unreadable"));
  return {
    ...actual,
    memberRestrictionFor: (...args: Parameters<typeof actual.memberRestrictionFor>) =>
      resolverFails.on ? fail() : actual.memberRestrictionFor(...args),
    memberRestrictionResolver: (db: Parameters<typeof actual.memberRestrictionResolver>[0]) =>
      (personId: string, companyId: string) => resolverFails.on ? fail() : actual.memberRestrictionFor(db, personId, companyId),
  };
});

const support = await getEmbeddedPostgresTestSupport();
const THIS_FILE = "server/src/__tests__/member-restriction-route-table-agent-pages.test.ts";
const AVATAR_ROW = "/api/agent-avatars/:version/:palette/:file";
const AVATAR = "/api/agent-avatars/cap-v1/arctic-blue/rest.png";
const SIX = ["companyId", "icon", "id", "name", "status", "title"];
const REFUSED = { status: 403, body: { error: "Not available for your access level", code: "MEMBER_RESTRICTED" } };
/** The seven `closed` rows of this ticket, then the two existing closed reads of decision section 3. */
const CLOSED: Array<[method: "get" | "put", row: string]> = [
  ["get", "/api/companies/:companyId/built-in-agents"],
  ["get", "/api/companies/:companyId/budgets/overview"],
  ["get", "/api/companies/:companyId/ai-connections"],
  ["get", "/api/companies/:companyId/resource-memberships/me"],
  ["put", "/api/companies/:companyId/resource-memberships/me/projects/:projectId"],
  ["put", "/api/companies/:companyId/resource-memberships/me/agents/:agentId"],
  ["put", "/api/companies/:companyId/resource-memberships/me/documents/:documentId"],
];
const OTHER_CLOSED: typeof CLOSED = [["get", "/api/instance/settings"], ["get", "/api/companies/:companyId/org"]];

afterEach(() => {
  vi.unstubAllEnvs();
  resolverFails.on = false;
});

it(`the rows of this ticket: ${AVATAR_ROW} open with this test; seven closed`, () => {
  const mine = MEMBER_RESTRICTION_ROUTE_TABLE.filter((entry) => entry.test === THIS_FILE);
  expect(mine.map((entry) => `${entry.method} ${entry.path} ${entry.class}`)).toEqual([`GET ${AVATAR_ROW} open`]);
  for (const [method, row] of CLOSED) {
    expect(MEMBER_RESTRICTION_ROUTE_TABLE.find((entry) => entry.method === method.toUpperCase() && entry.path === row)?.class, row).toBe("closed");
  }
});

it("test 3 (AC-G11): the avatar variants classify as the plain path or are refused", async () => {
  const classify = createRouteClassifier();
  expect(await classify("GET", AVATAR)).toMatchObject({ kind: "matched", entry: { path: AVATAR_ROW, class: "open" } });
  for (const [method, variant] of [["GET", AVATAR.toUpperCase()], ["GET", `${AVATAR}/`], ["HEAD", AVATAR],
    ["GET", AVATAR.replace("/api/", "/api//")], ["GET", AVATAR.replace("arctic-blue", "arctic-blue%2Fx")]]) {
    const result = await classify(method!, variant!);
    expect(result.kind === "refused" || (result.kind === "matched" && result.entry.path === AVATAR_ROW), `${method} ${variant}`).toBe(true);
  }
});

describe("agent pages database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

type Actor = Express.Request["actor"];
type Res = request.Response;
const answer = (res: Res) => ({ status: res.status, body: res.body });

(support.supported ? describe : describe.skip)("agent pages: six fields, the avatar row and seven closed rows (PAR-13469)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let avatarDir = "";
  let guarded: express.Express;
  let bare: express.Express;
  let actor: Actor;
  const R = `restricted-${randomUUID()}`, O = `owner-${randomUUID()}`, XO = `x-owner-${randomUUID()}`, ADMIN = `admin-${randomUUID()}`;
  let Y = "", X = "", listed = "", offList = "", inX = "";

  const mount = (withGuard: boolean) => {
    const app = express();
    app.use(express.json());
    const real = actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null });
    // A bearer goes through the real agent-key auth; otherwise the actor under test.
    app.use((req, res, next) => req.headers.authorization ? real(req, res, next) : ((req.actor = actor), next()));
    const api = express.Router();
    if (withGuard) api.use(memberRestrictionRouteGuard(db));
    api.use(agentAvatarRoutes(createAgentAvatarService(createLocalDiskStorageProvider(avatarDir), async () => Buffer.from("avatar-png"))).router);
    api.use(agentRoutes(db));
    api.use(builtInAgentRoutes(db));
    api.use(costRoutes(db));
    api.use(resourceMembershipRoutes(db));
    api.use(instanceSettingsRoutes(db));
    api.use(aiConnectionRoutes(db, { deploymentMode: "authenticated", deploymentExposure: "private" }));
    app.use("/api", api);
    app.use(errorHandler);
    return app;
  };
  const as = (who: Actor, app = guarded) => { actor = who; return request(app); };
  const boardFor = async (userId: string, extra: Partial<Actor> = {}): Promise<Actor> => {
    const memberships = await loadActorMemberships(db, { userId, activeOnly: true });
    return { type: "board", userId, source: "session", isInstanceAdmin: false, memberships,
      companyIds: memberships.map((row) => row.companyId), ...extra } as Actor;
  };
  const keyFor = async (agentId: string, companyId: string, userId: string) => {
    const token = `pcp_${randomUUID()}`;
    await db.insert(agentApiKeys).values({ companyId, agentId, responsibleUserId: userId, name: "key",
      keyHash: createHash("sha256").update(token).digest("hex") });
    return token;
  };
  const setMode = (mode: "off" | "report" | "enforce") => db.update(companies).set({ memberRestrictionMode: mode }).where(eq(companies.id, Y));
  const fill = (row: string, companyId = Y) => row.replace(":companyId", companyId).replace(/:[A-Za-z]+/g, () => randomUUID());

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-route-table-agent-pages-");
    db = createDb(tempDb.connectionString);
    avatarDir = await mkdtemp(path.join(os.tmpdir(), "agent-pages-avatar-"));
    guarded = mount(true);
    bare = mount(false);
    const [y, x] = await db.insert(companies).values([
      { name: "Y", issuePrefix: `Y${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
      { name: "X", issuePrefix: `X${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
    ]).returning();
    Y = y!.id; X = x!.id;
    const agent = async (companyId: string, name: string) => (await db.insert(agents).values({ companyId, name, title: "Writer",
      icon: "pen", status: "idle", adapterType: "process", adapterConfig: { command: "secret-host-command" } }).returning())[0]!.id;
    listed = await agent(Y, "Listed"); offList = await agent(Y, "Off list"); inX = await agent(X, "In X");
    const now = new Date();
    await db.insert(authUsers).values([R, O, XO, ADMIN].map((id) => ({ id, name: id, email: `${id}@example.test`, emailVerified: true,
      createdAt: now, updatedAt: now })));
    await db.insert(companyMemberships).values([
      { companyId: Y, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
      { companyId: Y, principalType: "user", principalId: R, status: "active", membershipRole: "operator", restricted: true, restrictedAgentIds: [listed] },
      { companyId: X, principalType: "user", principalId: R, status: "active", membershipRole: "owner" },
      { companyId: X, principalType: "user", principalId: XO, status: "active", membershipRole: "owner" },
    ]);
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
    if (avatarDir) await rm(avatarDir, { recursive: true, force: true });
  });

  /** Tests 1 and 2: exactly the six keys, `companyId` is Y, an agent off his list absent and byte-equal to an unknown id. */
  const sixFieldReads = async (get: (url: string) => Promise<Res>) => {
    const list = await get(`/api/companies/${Y}/agents`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.map((row: { id: string }) => row.id)).toEqual([listed]);
    expect(Object.keys(list.body[0]).sort()).toEqual(SIX);
    expect(list.body[0].companyId).toBe(Y);
    const detail = await get(`/api/agents/${listed}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toEqual(list.body[0]);
    const [off, unknown] = [await get(`/api/agents/${offList}`), await get(`/api/agents/${randomUUID()}`)];
    expect(answer(off)).toEqual({ status: 404, body: { error: "Agent not found" } });
    expect(off.text).toBe(unknown.text);
  };

  it("test 1: R's agent list and agent by id carry exactly the six fields; the owner gets the full body", async () => {
    await sixFieldReads(async (url) => as(await boardFor(R)).get(url));
    const owner = await as(await boardFor(O)).get(`/api/agents/${listed}`);
    expect(owner.body).toMatchObject({ id: listed, companyId: Y, adapterType: "process" });
  });

  it("test 2: an agent key working for R reads the same six fields; the owner's key reads the full body", async () => {
    const forR = await keyFor(listed, Y, R);
    await sixFieldReads((url) => request(guarded).get(url).set("authorization", `Bearer ${forR}`));
    const forO = await keyFor(listed, Y, O);
    const full = await request(guarded).get(`/api/agents/${listed}`).set("authorization", `Bearer ${forO}`);
    expect(full.status).toBe(200);
    expect(full.body).toHaveProperty("adapterType");
  });

  it("test 3: R gets the avatar with the owner's ETag and bytes; a palette outside the list is the handler's 400", async () => {
    const [mine, owner] = [await as(await boardFor(R)).get(AVATAR), await as(await boardFor(O)).get(AVATAR)];
    expect(mine.status).toBe(200);
    expect(mine.headers.etag).toBeTruthy();
    expect(mine.headers.etag).toBe(owner.headers.etag);
    expect(Buffer.compare(mine.body as Buffer, owner.body as Buffer)).toBe(0);
    const bad = await as(await boardFor(R)).get("/api/agent-avatars/cap-v1/no-such-palette/rest.png");
    expect(answer(bad)).toEqual({ status: 400, body: { error: "Unsupported avatar version, palette, pose, size, or scale" } });
  });

  it.each([...CLOSED, ...OTHER_CLOSED])("test 4: %s %s is 403 MEMBER_RESTRICTED for R, not for the owner", async (method, row) => {
    const url = fill(row);
    expect(answer(await as(await boardFor(R))[method](url).send({}))).toEqual(REFUSED);
    expect((await as(await boardFor(O))[method](url).send({})).body).not.toEqual(REFUSED.body);
  });

  it("test 5: every other caller class keeps today's answer on the agent list, the agent by id, the avatar and a closed row", async () => {
    const reads = (companyId: string, agentId: string) => [`/api/companies/${companyId}/agents`, `/api/agents/${agentId}`, AVATAR,
      `/api/companies/${companyId}/budgets/overview`];
    const [xKey, xOwnerKey] = [await keyFor(inX, X, R), await keyFor(inX, X, XO)];
    // `strip`: R is restricted in Y at `enforce`, so a path naming no company gets the C4i-c host-key strip
    // (fail closed, as `member-restriction-scope-callers.test.ts` pins); a path naming X does not.
    type Cell = { name: string; make: () => Promise<Actor | string>; mode?: "report" | "off"; killSwitch?: true; strip?: true; urls: string[] };
    const cells: Cell[] = [
      { name: "R at report", make: () => boardFor(R), mode: "report", urls: reads(Y, listed) },
      { name: "R at off", make: () => boardFor(R), mode: "off", urls: reads(Y, listed) },
      { name: "R with the kill switch on", make: () => boardFor(R), killSwitch: true, urls: reads(Y, listed) },
      { name: "an owner who is not restricted", make: () => boardFor(O), urls: reads(Y, offList) },
      { name: "an instance admin who is not a member", make: () => boardFor(ADMIN, { isInstanceAdmin: true, companyIds: [], memberships: [] }),
        urls: reads(Y, offList) },
      { name: "local_implicit", make: () => boardFor(O, { source: "local_implicit" }), urls: reads(Y, offList) },
      { name: "R in X, where he is owner", make: () => boardFor(R), strip: true, urls: reads(X, inX) },
      { name: "a key working for R in X", make: async () => xKey, urls: reads(X, inX) },
      { name: "another company's agent", make: async () => xOwnerKey, urls: reads(Y, offList) },
      { name: "anonymous", make: async () => ({ type: "none", source: "none" }) as Actor, urls: [AVATAR] },
    ];
    for (const cell of cells) {
      if (cell.mode) await setMode(cell.mode);
      if (cell.killSwitch) vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
      try {
        for (const url of cell.urls) {
          const send = async (app: express.Express) => {
            const who = await cell.make();
            return typeof who === "string" ? request(app).get(url).set("authorization", `Bearer ${who}`) : as(who, app).get(url);
          };
          const [now, today] = [await send(guarded), await send(bare)];
          const label = `${cell.name}: ${url}`;
          const stripped = cell.strip && url.startsWith("/api/agents/");
          expect(answer(now), label).toEqual({ status: today.status, body: stripped ? withoutHostKeys(today.body) : today.body });
          if (url === AVATAR) expect(now.headers.etag, label).toBe(today.headers.etag);
          if (url.includes("/agents/") && now.status === 200) expect(now.body, label).toHaveProperty("adapterType");
        }
      } finally {
        vi.unstubAllEnvs();
        await setMode("enforce");
      }
    }
  });

  it.each([`/api/companies/{Y}/agents`, "/api/agents/{listed}", AVATAR])("test 6: %s answers 503 with no agent data when the restriction cannot be read", async (template) => {
    // Memberships without the restriction fields make the guard read through the resolver.
    const caller = await boardFor(R);
    const unknown = { ...caller, memberships: caller.memberships!.map(({ companyId, membershipRole, status }) => ({ companyId, membershipRole, status })) } as Actor;
    resolverFails.on = true;
    const res = await as(unknown).get(template.replace("{Y}", Y).replace("{listed}", listed));
    expect(res.status).toBe(503);
    expect(res.body.code ?? res.body.details?.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
    expect(JSON.stringify(res.body)).not.toContain(listed);
    expect(res.body).not.toHaveProperty("name");
  });
});
