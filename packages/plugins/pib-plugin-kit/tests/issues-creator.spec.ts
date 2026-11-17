import { describe, expect, it } from "vitest";
import { createWorkIssue, creatorActor } from "../src/issues.js";
import { openApprovalIssue } from "../src/approvals.js";
import { fakeCtx } from "./helpers/fake-ctx.js";

describe("creatorActor", () => {
  it("returns the acting person, trimmed", () => {
    expect(creatorActor(" user-1 ")).toEqual({ actorUserId: "user-1" });
  });
  it("returns nothing for no person", () => {
    expect(creatorActor(null)).toBeUndefined();
    expect(creatorActor(undefined)).toBeUndefined();
    expect(creatorActor("  ")).toBeUndefined();
  });
});

describe("createWorkIssue creator", () => {
  const base = { companyId: "co-1", title: "Do it" };
  const make = () => fakeCtx({ companies: { "co-1": { name: "Co", issuePrefix: "TST" } } });

  it("records the acting person as creator", async () => {
    const fake = make();
    await createWorkIssue(fake.ctx, { ...base, actingUserId: "user-1", wake: false });
    expect((fake.issues[0] as any).actor).toEqual({ actorUserId: "user-1" });
    expect((fake.issues[0] as any).actingUserId).toBeUndefined();
  });

  it("leaves the creator off for automation-made tasks", async () => {
    const fake = make();
    await createWorkIssue(fake.ctx, { ...base, wake: false });
    expect((fake.issues[0] as any).actor).toBeUndefined();
  });

  it("an explicit actor wins over actingUserId", async () => {
    const fake = make();
    await createWorkIssue(fake.ctx, { ...base, actingUserId: "user-1", actor: { actorAgentId: "agent-9" }, wake: false });
    expect((fake.issues[0] as any).actor).toEqual({ actorAgentId: "agent-9" });
  });
});

describe("openApprovalIssue creator", () => {
  const input = { companyId: "co-1", title: "Approve it", description: "d", originKind: "plugin:partnersinbiz.test", originId: "x:1" };
  it("records createdByUserId as the creator, and leaves it off without one", async () => {
    const fake = fakeCtx({ companies: { "co-1": { name: "Co", issuePrefix: "TST" } } });
    await openApprovalIssue(fake.ctx, { ...input, createdByUserId: "user-1" });
    await openApprovalIssue(fake.ctx, { ...input, actorUserId: "user-2" });
    expect((fake.issues[0] as any).actor).toEqual({ actorUserId: "user-1" });
    expect((fake.issues[1] as any).actor).toBeUndefined();
  });
});
