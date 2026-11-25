import express from "express";
import request from "supertest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { companyMemberships, type Db } from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";

/**
 * PAR-12718: the board-chat "Board Operations" lookup is a new caller of the
 * member-restriction resolver. These tests drive the shipped route with the
 * REAL resolver (`issueReadSqlCondition`); only the issue service, the chat
 * subprocess and the feature flag are stubbed. AC-X1: a failing read answers
 * 503 MEMBER_RESTRICTION_UNAVAILABLE before any task is listed or any process
 * spawned. AC-F8: with the kill switch `off`, a company on `enforce` lists as
 * in mode `off`.
 */

const mockGetExperimental = vi.hoisted(() => vi.fn());
const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  addComment: vi.fn(),
  listComments: vi.fn(),
}));
const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  instanceSettingsService: () => ({ getExperimental: mockGetExperimental }),
  issueService: () => mockIssueService,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mockSpawn,
}));

vi.mock("../services/fast-responses.js", () => ({
  enqueueFastResponse: vi.fn(async () => undefined),
  supersedeFastResponse: vi.fn(async () => undefined),
}));

const COMPANY_ID = "company-1";
const actor: Express.Request["actor"] = {
  type: "board", userId: "user-r", companyIds: [COMPANY_ID], source: "session", isInstanceAdmin: false,
};

/**
 * A db whose restriction read (`company_memberships`) answers with
 * `restrictionRows`; every other read (the instance-admin check) answers no rows.
 */
function fakeDb(restrictionRows: () => Promise<unknown[]>): Db {
  return {
    select: () => ({
      from: (table: unknown) => {
        const rows = table === companyMemberships ? restrictionRows : async () => [];
        const chain: Record<string, unknown> = {};
        Object.assign(chain, {
          innerJoin: () => chain,
          where: () => chain,
          limit: () => chain,
          then: (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
            rows().then(resolve, reject),
        });
        return chain;
      },
    }),
    transaction: async (effect: (tx: unknown) => unknown) => effect({}),
  } as unknown as Db;
}

const failingRead = () => Promise.reject(new Error("connection reset"));
const enforcedForR = async () => [{ companyId: COMPANY_ID }];
const modeOff = async () => [];

async function postChat(db: Db) {
  const { boardChatRoutes } = await import("../routes/board-chat.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.actor = actor; next(); });
  app.use("/api", boardChatRoutes(db, { deploymentMode: "local_trusted" }));
  app.use(errorHandler);
  return request(app).post("/api/board/chat/stream").send({ companyId: COMPANY_ID, message: "hello" });
}

/** The read condition the route passed to the task list, rendered to SQL. */
async function listedReadCondition(db: Db) {
  mockIssueService.list.mockRejectedValueOnce(new Error("stop after the lookup"));
  await postChat(db);
  expect(mockIssueService.list).toHaveBeenCalledTimes(1);
  const [companyId, filters] = mockIssueService.list.mock.calls[0]! as [string, { readCondition: SQL<boolean> }];
  expect(companyId).toBe(COMPANY_ID);
  mockIssueService.list.mockClear();
  return new PgDialect().sqlToQuery(filters.readCondition);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /board/chat/stream Board Operations lookup (PAR-12718)", () => {
  it("AC-X1: a failing restriction read answers 503 MEMBER_RESTRICTION_UNAVAILABLE with no tasks and no process", async () => {
    const res = await postChat(fakeDb(failingRead));

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
    expect(mockIssueService.list).not.toHaveBeenCalled();
    expect(mockIssueService.create).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("AC-F8: with the kill switch `off` the lookup does not read the restriction and lists as in mode off", async () => {
    const asModeOff = await listedReadCondition(fakeDb(modeOff));
    const restricted = await listedReadCondition(fakeDb(enforcedForR));
    // Sanity: on `enforce` the restriction narrows the lookup.
    expect(restricted).not.toEqual(asModeOff);

    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    // The failing db proves the switch skips the read; the enforced db proves
    // `enforce` then behaves exactly as mode `off`.
    expect(await listedReadCondition(fakeDb(failingRead))).toEqual(asModeOff);
    expect(await listedReadCondition(fakeDb(enforcedForR))).toEqual(asModeOff);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
