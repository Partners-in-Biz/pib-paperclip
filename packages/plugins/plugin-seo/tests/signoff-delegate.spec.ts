/** PAR-10548 T6: the sign-off delegate is told by one issue per sprint (create + wake, comment + wake on growth, cancel when empty). */
import { beforeEach, describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => ({ delegate: "agent-del" as string | null, grantable: new Set<string>() }));
vi.mock("../src/cockpit.js", async (orig) => ({
  ...(await orig<typeof import("../src/cockpit.js")>()),
  delegateWaitsOn: vi.fn(async (_e: unknown, _c: string, _s: string, taskId: string, delegate: string | null) =>
    delegate && gate.grantable.has(taskId) ? { kind: "agent", agentId: delegate } : null),
}));
vi.mock("../src/service/signoff.js", async (orig) => ({
  ...(await orig<typeof import("../src/service/signoff.js")>()),
  delegateAgentIds: vi.fn(async () => (gate.delegate ? [gate.delegate] : [])),
}));

import { ORIGIN } from "../src/constants.js";
import { syncSignoffDelegateIssue } from "../src/service/signoff-delegate.js";
import { needsYouRoutes, seoHost, sprintRoutes, type Row } from "./helpers/seo-host.js";

const item = (n: number, extra: Row = {}) => ({ key: `pr:t${n}`, kind: "pr", title: `Approve page ${n}`, check: "manual", status: "open", taskIds: [`t${n}`], steps: [], after: "", ...extra });

function setup(items: unknown[], existing: Row[] = []) {
  const h = seoHost({ routes: [...sprintRoutes, ...needsYouRoutes(items)] });
  const issues: Row[] = [...existing];
  (h.ctx.issues as any).list = vi.fn(async () => issues);
  (h.ctx.issues as any).get = vi.fn(async (id: string) => issues.find((i) => i.id === id) ?? { id, status: "todo" });
  (h.ctx.issues as any).create = vi.fn(async (input: Row) => {
    const row = { id: `issue-${200 + issues.length}`, status: "todo", createdAt: "2026-10-03T08:00:00Z", ...input };
    issues.push(row);
    h.created.push({ id: String(row.id), input });
    return row;
  });
  return { h, issues };
}
const sync = (h: ReturnType<typeof seoHost>) => syncSignoffDelegateIssue(h.env, "co-1", "sp-1");

beforeEach(() => {
  gate.delegate = "agent-del";
  gate.grantable = new Set(["t1", "t2"]);
});

describe("syncSignoffDelegateIssue", () => {
  it("1. first grantable item: one issue for the delegate, woken, with the call and the key", async () => {
    const { h } = setup([item(1)]);
    await sync(h);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.input).toMatchObject({ originKind: ORIGIN.signoffDelegate, originId: "signoff-delegate:sp-1", assigneeAgentId: "agent-del", projectId: "proj-client" });
    expect(String(h.created[0]!.input.description)).toMatch(/pr:t1[\s\S]*partnersinbiz\.seo:approve-page-apply[\s\S]*needsYouKey[\s\S]*person can still decide/);
    expect(h.wakeups).toEqual(["issue-200"]);
  });

  it("2. the same items again: no new issue, no wake", async () => {
    const { h } = setup([item(1)]);
    await sync(h);
    h.wakeups.length = 0;
    await sync(h);
    expect(h.created).toHaveLength(1);
    expect(h.wakeups).toEqual([]);
    expect(h.comments).toEqual([]);
  });

  it("3. a new item: a comment and a wake on the same issue", async () => {
    const first = setup([item(1)]);
    await sync(first.h);
    const { h } = setup([item(1), item(2)], first.issues);
    await sync(h);
    expect(h.created).toHaveLength(0);
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]).toMatchObject({ id: "issue-200" });
    expect(h.comments[0]!.body).toContain("pr:t2");
    expect(h.wakeups).toEqual(["issue-200"]);
  });

  it("a shrinking set updates the description with no comment and no wake", async () => {
    const first = setup([item(1), item(2)]);
    await sync(first.h);
    const { h } = setup([item(1)], first.issues);
    await sync(h);
    expect(h.updates[0]).toMatchObject({ id: "issue-200" });
    expect(String(h.updates[0]!.patch.description)).not.toContain("pr:t2");
    expect(h.comments).toEqual([]);
    expect(h.wakeups).toEqual([]);
  });

  it("4. the last item resolved: the issue is cancelled", async () => {
    const first = setup([item(1)]);
    await sync(first.h);
    const { h } = setup([item(1, { status: "done" })], first.issues);
    await sync(h);
    expect(h.updates).toEqual([{ id: "issue-200", patch: { status: "cancelled" } }]);
  });

  it("5. two open issues: the newer is cancelled", async () => {
    const row = (id: string, createdAt: string) => ({ id, status: "todo", createdAt, description: "Needs you key: `pr:t1`" });
    const { h } = setup([item(1)], [row("new", "2026-10-03T09:00:00Z"), row("old", "2026-10-03T08:00:00Z")]);
    await sync(h);
    expect(h.updates).toContainEqual({ id: "new", patch: { status: "cancelled" } });
    expect(h.updates.some((u) => u.id === "old" && u.patch.status === "cancelled")).toBe(false);
  });

  it("6. no delegate: no issue", async () => {
    gate.delegate = null;
    const { h } = setup([item(1)]);
    await sync(h);
    expect(h.created).toHaveLength(0);
    expect(h.wakeups).toEqual([]);
  });
});
