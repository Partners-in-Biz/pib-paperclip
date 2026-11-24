/**
 * Backup approver (17 Nov 2026): when the delegated approver writes a post itself (Rhea is both the Social agent and the
 * own-brand delegate), the backup approves it after the Reviewer's pass instead of it falling back to a person. The writer
 * never approves its own post, and the backup acts only on the delegate's own posts.
 */
import { describe, expect, it } from "vitest";
import { approvePostByDelegate } from "../src/approval-flow.js";
import { approverOf, assertDelegateNotEditing, setDelegate, setDelegateBackup } from "../src/approval-delegate.js";
import { delegateForPost } from "../src/review.js";
import { postRow } from "./world.js";
import { BRAND, delegateWorld, OTHER, RHEA } from "./delegate-world.js";

const POLICY = { requireOwner: true, requireClient: false };

function withBackup(backup = "ag-other") {
  const w = delegateWorld();
  const entry = w.store.get("delegates") as Record<string, Record<string, unknown>>;
  entry[BRAND] = { ...entry[BRAND], backupAgentId: backup, backupSetBy: "owner-1", backupSetAt: new Date().toISOString() };
  return w;
}

describe("approverOf", () => {
  it("is the delegate for anyone else's post, the backup for the delegate's own, none without a backup", () => {
    expect(approverOf({ agentId: "a", backupAgentId: "b" }, "x")).toBe("a");
    expect(approverOf({ agentId: "a", backupAgentId: "b" }, null)).toBe("a");
    expect(approverOf({ agentId: "a", backupAgentId: "b" }, "a")).toBe("b");
    expect(approverOf({ agentId: "a" }, "a")).toBeNull();
    expect(approverOf({ agentId: "a", backupAgentId: "a" }, "a")).toBeNull();
  });
});

describe("routing", () => {
  it("the delegate's own post goes to the backup", async () => {
    const w = withBackup();
    w.post.created_by_agent_id = "ag-rhea";
    expect((await delegateForPost(w.ctx as never, "co", postRow(w), POLICY))?.agentId).toBe("ag-other");
  });

  it("without a backup the delegate's own post goes to a person, as before", async () => {
    const w = delegateWorld();
    w.post.created_by_agent_id = "ag-rhea";
    expect(await delegateForPost(w.ctx as never, "co", postRow(w), POLICY)).toBeNull();
  });

  it("another agent's post still goes to the delegate", async () => {
    const w = withBackup();
    w.post.created_by_agent_id = "ag-social";
    expect((await delegateForPost(w.ctx as never, "co", postRow(w), POLICY))?.agentId).toBe("ag-rhea");
  });

  it("a backup that is the Reviewer never acts", async () => {
    const w = withBackup("rev-1");
    w.post.created_by_agent_id = "ag-rhea";
    expect(await delegateForPost(w.ctx as never, "co", postRow(w), POLICY)).toBeNull();
  });
});

describe("the approve gate", () => {
  it("the backup approves the delegate's own post after the Reviewer's pass", async () => {
    const w = withBackup();
    w.post.created_by_agent_id = "ag-rhea";
    w.pass();
    await approvePostByDelegate(w.ctx as never, OTHER, postRow(w));
    expect(w.post.status).toBe("approved");
    expect(w.ownerRows()).toMatchObject([{ via: "delegate", actor_agent_id: "ag-other" }]);
  });

  it("the delegate still cannot approve its own post, and is told the backup does", async () => {
    const w = withBackup();
    w.post.created_by_agent_id = "ag-rhea";
    w.pass();
    await expect(approvePostByDelegate(w.ctx as never, RHEA, postRow(w))).rejects.toThrow("The backup approver approves it.");
    expect(w.post.status).toBe("review");
  });

  it("the backup cannot approve a post the delegate did not write", async () => {
    const w = withBackup();
    w.post.created_by_agent_id = "ag-social";
    w.pass();
    await expect(approvePostByDelegate(w.ctx as never, OTHER, postRow(w))).rejects.toThrow("You are the backup approver");
    expect(w.ownerRows()).toEqual([]);
  });
});

describe("storage", () => {
  it("names and clears a backup, keeps it when the delegate changes, refuses the delegate itself", async () => {
    const w = delegateWorld();
    await setDelegateBackup(w.ctx as never, "co", { kind: "company", id: BRAND.slice(8) } as never, "ag-other", "owner-1");
    expect((w.store.get("delegates") as Record<string, { backupAgentId?: string }>)[BRAND]?.backupAgentId).toBe("ag-other");
    await expect(setDelegateBackup(w.ctx as never, "co", { kind: "company", id: BRAND.slice(8) } as never, "ag-rhea", "owner-1")).rejects.toThrow("another agent");
    await setDelegate(w.ctx as never, "co", { kind: "company", id: BRAND.slice(8) } as never, "ag-social", "owner-1");
    expect((w.store.get("delegates") as Record<string, { agentId: string; backupAgentId?: string }>)[BRAND]).toMatchObject({ agentId: "ag-social", backupAgentId: "ag-other" });
    await setDelegateBackup(w.ctx as never, "co", { kind: "company", id: BRAND.slice(8) } as never, null, "owner-1");
    expect((w.store.get("delegates") as Record<string, { backupAgentId?: string }>)[BRAND]?.backupAgentId).toBeUndefined();
  });

  it("the backup may not edit posts other agents created in its scope", async () => {
    const w = withBackup();
    await expect(assertDelegateNotEditing(w.ctx as never, { companyId: "co", agentId: "ag-other", isAgent: true }, { created_by_agent_id: "ag-social" }, [{ kind: "company", id: BRAND.slice(8) } as never])).rejects.toThrow("delegated approver");
  });
});
