/**
 * Edge watch integration tests (Postgres).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds } from "./helpers/hybrid.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

const DEPLOY_TIME = "2026-10-03T10:00:00.000Z";
const EDGE_TIME = "2026-10-03T11:00:00.000Z";
const BEFORE_DEPLOY = "2026-10-03T09:00:00.000Z";

d("edge watch (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  async function make() {
    return await worlds.make({ savedConfigs: { [COMPANY]: { edgeWatch: { enabled: true } } } }, DEPLOY_TIME);
  }

  it("announces owner-assigned blocker on both issues", async () => {
    const w = await make();

    const blocker1 = uuid();
    const blocked1 = uuid();

    // Create two issues in both Postgres and fake context
    const now = new Date().toISOString();
    await w.pg.addIssueToDb({ id: blocker1, companyId: COMPANY, identifier: "PAR-101", title: "Blocker", status: "todo", assigneeUserId: "owner" });
    w.issues.set(blocker1, { id: blocker1, companyId: COMPANY, identifier: "PAR-101", title: "Blocker", status: "todo", assigneeUserId: "owner", assigneeAgentId: null, description: "", createdAt: now, updatedAt: now });

    await w.pg.addIssueToDb({ id: blocked1, companyId: COMPANY, identifier: "PAR-100", title: "Blocked", status: "todo" });
    w.issues.set(blocked1, { id: blocked1, companyId: COMPANY, identifier: "PAR-100", title: "Blocked", status: "todo", assigneeUserId: null, assigneeAgentId: null, description: "", createdAt: now, updatedAt: now });

    // Create a blocker relation after deploy
    w.clock.set(EDGE_TIME);
    await w.pg.addRelationToDb(COMPANY, blocker1, blocked1, EDGE_TIME);

    // Fire the relation updated event
    await w.fire("issue.relations.updated", {
      companyId: COMPANY,
      entityId: blocked1,
      payload: { blockedByIssueIds: [blocker1] },
    });

    // Check comments on both issues
    const blockedComments = w.comments.filter((c) => c.issueId === blocked1);
    const blockerComments = w.comments.filter((c) => c.issueId === blocker1);

    expect(blockedComments.length).toBe(1);
    expect(blockerComments.length).toBe(1);
    expect(blockedComments[0]?.body).toContain("PAR-101");
    expect(blockedComments[0]?.body).toContain("waiting on a person");
    expect(blockedComments[0]?.body).toContain(`<!-- edge-watch:${blocked1}-${blocker1} -->`);
    expect(blockerComments[0]?.body).toContain("PAR-100");
  });

  it("announces unassigned blocker on both issues", async () => {
    const w = await make();

    const blocker2 = uuid();
    const blocked2 = uuid();

    const now = new Date().toISOString();
    await w.pg.addIssueToDb({ id: blocker2, companyId: COMPANY, identifier: "PAR-102", title: "Blocker", status: "todo" });
    w.issues.set(blocker2, { id: blocker2, companyId: COMPANY, identifier: "PAR-102", title: "Blocker", status: "todo", assigneeUserId: null, assigneeAgentId: null, description: "", createdAt: now, updatedAt: now });

    await w.pg.addIssueToDb({ id: blocked2, companyId: COMPANY, identifier: "PAR-103", title: "Blocked", status: "todo" });
    w.issues.set(blocked2, { id: blocked2, companyId: COMPANY, identifier: "PAR-103", title: "Blocked", status: "todo", assigneeUserId: null, assigneeAgentId: null, description: "", createdAt: now, updatedAt: now });

    w.clock.set(EDGE_TIME);
    await w.pg.addRelationToDb(COMPANY, blocker2, blocked2, EDGE_TIME);

    await w.fire("issue.relations.updated", {
      companyId: COMPANY,
      entityId: blocked2,
      payload: { blockedByIssueIds: [blocker2] },
    });

    const blockedComments = w.comments.filter((c) => c.issueId === blocked2);
    expect(blockedComments.length).toBe(1);
    expect(blockedComments[0]?.body).toContain("unassigned");
  });

  it("skips agent-assigned blocker", async () => {
    const w = await make();

    const blocker3 = uuid();
    const blocked3 = uuid();
    const agentId = uuid();

    const now = new Date().toISOString();
    await w.pg.addIssueToDb({ id: blocker3, companyId: COMPANY, identifier: "PAR-104", title: "Blocker", status: "todo", assigneeAgentId: agentId });
    w.issues.set(blocker3, { id: blocker3, companyId: COMPANY, identifier: "PAR-104", title: "Blocker", status: "todo", assigneeUserId: null, assigneeAgentId: agentId, description: "", createdAt: now, updatedAt: now });

    await w.pg.addIssueToDb({ id: blocked3, companyId: COMPANY, identifier: "PAR-105", title: "Blocked", status: "todo" });
    w.issues.set(blocked3, { id: blocked3, companyId: COMPANY, identifier: "PAR-105", title: "Blocked", status: "todo", assigneeUserId: null, assigneeAgentId: null, description: "", createdAt: now, updatedAt: now });

    w.clock.set(EDGE_TIME);
    await w.pg.addRelationToDb(COMPANY, blocker3, blocked3, EDGE_TIME);

    await w.fire("issue.relations.updated", {
      companyId: COMPANY,
      entityId: blocked3,
      payload: { blockedByIssueIds: [blocker3] },
    });

    const blockedComments = w.comments.filter((c) => c.issueId === blocked3);
    expect(blockedComments.length).toBe(0);
  });

  it("dedupes on same edge handled twice", async () => {
    const w = await make();

    const blocker4 = uuid();
    const blocked4 = uuid();

    const now = new Date().toISOString();
    await w.pg.addIssueToDb({ id: blocker4, companyId: COMPANY, identifier: "PAR-106", title: "Blocker", status: "todo" });
    w.issues.set(blocker4, { id: blocker4, companyId: COMPANY, identifier: "PAR-106", title: "Blocker", status: "todo", assigneeUserId: null, assigneeAgentId: null, description: "", createdAt: now, updatedAt: now });

    await w.pg.addIssueToDb({ id: blocked4, companyId: COMPANY, identifier: "PAR-107", title: "Blocked", status: "todo" });
    w.issues.set(blocked4, { id: blocked4, companyId: COMPANY, identifier: "PAR-107", title: "Blocked", status: "todo", assigneeUserId: null, assigneeAgentId: null, description: "", createdAt: now, updatedAt: now });

    w.clock.set(EDGE_TIME);
    await w.pg.addRelationToDb(COMPANY, blocker4, blocked4, EDGE_TIME);

    // Fire twice
    await w.fire("issue.relations.updated", {
      companyId: COMPANY,
      entityId: blocked4,
      payload: { blockedByIssueIds: [blocker4] },
    });

    await w.fire("issue.relations.updated", {
      companyId: COMPANY,
      entityId: blocked4,
      payload: { blockedByIssueIds: [blocker4] },
    });

    const blockedComments = w.comments.filter((c) => c.issueId === blocked4);
    const blockerComments = w.comments.filter((c) => c.issueId === blocker4);
    // Should only have 2 total (one per issue), not 4
    expect(blockedComments.length).toBe(1);
    expect(blockerComments.length).toBe(1);
  });

  it("skips edge older than cutoff", async () => {
    const w = await make();

    const blocker5 = uuid();
    const blocked5 = uuid();

    const now = new Date().toISOString();
    await w.pg.addIssueToDb({ id: blocker5, companyId: COMPANY, identifier: "PAR-108", title: "Blocker", status: "todo" });
    w.issues.set(blocker5, { id: blocker5, companyId: COMPANY, identifier: "PAR-108", title: "Blocker", status: "todo", assigneeUserId: null, assigneeAgentId: null, description: "", createdAt: now, updatedAt: now });

    await w.pg.addIssueToDb({ id: blocked5, companyId: COMPANY, identifier: "PAR-109", title: "Blocked", status: "todo" });
    w.issues.set(blocked5, { id: blocked5, companyId: COMPANY, identifier: "PAR-109", title: "Blocked", status: "todo", assigneeUserId: null, assigneeAgentId: null, description: "", createdAt: now, updatedAt: now });

    // Add relation with timestamp before deploy
    await w.pg.addRelationToDb(COMPANY, blocker5, blocked5, BEFORE_DEPLOY);

    w.clock.set(EDGE_TIME);
    await w.fire("issue.relations.updated", {
      companyId: COMPANY,
      entityId: blocked5,
      payload: { blockedByIssueIds: [blocker5] },
    });

    const blockedComments = w.comments.filter((c) => c.issueId === blocked5);
    expect(blockedComments.length).toBe(0);
  });

  it("skips terminal blocked issue", async () => {
    const w = await make();

    const blocker6 = uuid();
    const blocked6 = uuid();

    const now = new Date().toISOString();
    await w.pg.addIssueToDb({ id: blocker6, companyId: COMPANY, identifier: "PAR-110", title: "Blocker", status: "todo" });
    w.issues.set(blocker6, { id: blocker6, companyId: COMPANY, identifier: "PAR-110", title: "Blocker", status: "todo", assigneeUserId: null, assigneeAgentId: null, description: "", createdAt: now, updatedAt: now });

    await w.pg.addIssueToDb({ id: blocked6, companyId: COMPANY, identifier: "PAR-111", title: "Blocked", status: "done" });
    w.issues.set(blocked6, { id: blocked6, companyId: COMPANY, identifier: "PAR-111", title: "Blocked", status: "done", assigneeUserId: null, assigneeAgentId: null, description: "", createdAt: now, updatedAt: now });

    w.clock.set(EDGE_TIME);
    await w.pg.addRelationToDb(COMPANY, blocker6, blocked6, EDGE_TIME);

    await w.fire("issue.relations.updated", {
      companyId: COMPANY,
      entityId: blocked6,
      payload: { blockedByIssueIds: [blocker6] },
    });

    const blockedComments = w.comments.filter((c) => c.issueId === blocked6);
    expect(blockedComments.length).toBe(0);
  });

  it("respects edgeWatch disabled config", async () => {
    const w = await worlds.make({ savedConfigs: { [COMPANY]: { edgeWatch: { enabled: false } } } }, DEPLOY_TIME);

    const blocker7 = uuid();
    const blocked7 = uuid();

    const now = new Date().toISOString();
    await w.pg.addIssueToDb({ id: blocker7, companyId: COMPANY, identifier: "PAR-112", title: "Blocker", status: "todo" });
    w.issues.set(blocker7, { id: blocker7, companyId: COMPANY, identifier: "PAR-112", title: "Blocker", status: "todo", assigneeUserId: null, assigneeAgentId: null, description: "", createdAt: now, updatedAt: now });

    await w.pg.addIssueToDb({ id: blocked7, companyId: COMPANY, identifier: "PAR-113", title: "Blocked", status: "todo" });
    w.issues.set(blocked7, { id: blocked7, companyId: COMPANY, identifier: "PAR-113", title: "Blocked", status: "todo", assigneeUserId: null, assigneeAgentId: null, description: "", createdAt: now, updatedAt: now });

    w.clock.set(EDGE_TIME);
    await w.pg.addRelationToDb(COMPANY, blocker7, blocked7, EDGE_TIME);

    await w.fire("issue.relations.updated", {
      companyId: COMPANY,
      entityId: blocked7,
      payload: { blockedByIssueIds: [blocker7] },
    });

    const blockedComments = w.comments.filter((c) => c.issueId === blocked7);
    expect(blockedComments.length).toBe(0);
  });
});
