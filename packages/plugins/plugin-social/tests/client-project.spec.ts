/**
 * 0.8.0 (Q1a-12): a client's Social issues open in the client's own Paperclip project (the CRM's client-to-project link), never in
 * PiB's shared Social project. Own work, and a client with no linked project, keep using the Social project.
 */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { rememberClientProjects } from "@partnersinbiz/pib-plugin-kit";
import { openPublishFailureIssue, openReconnectIssue, projectIdFor, projectIdForRow } from "../src/issues.js";
import { transitionPost } from "../src/service.js";
import { account, approvalWorld, postRow, SOCIAL_AGENT } from "./world.js";
import type { AccountRow, DestinationRow } from "../src/db.js";

const CLIENT = { kind: "company" as const, id: "c1" };

describe("which project an issue opens in", () => {
  it("own work uses the Social project", async () => {
    const w = approvalWorld({ client: null });
    expect(await projectIdFor(w.ctx, "co", null)).toBe("proj-social");
    expect(await projectIdForRow(w.ctx, "co", { client_kind: null, client_ref: null })).toBe("proj-social");
  });

  it("a client with a linked project gets it; the first when several are linked", async () => {
    const one = approvalWorld({ clientProjects: ["proj-acme"] });
    expect(await projectIdFor(one.ctx, "co", CLIENT)).toBe("proj-acme");
    const two = approvalWorld({ clientProjects: ["proj-acme", "proj-acme-2"] });
    expect(await projectIdFor(two.ctx, "co", CLIENT)).toBe("proj-acme");
    expect(await projectIdForRow(one.ctx, "co", { client_kind: "company", client_ref: "c1" })).toBe("proj-acme");
  });

  it("a client with no link uses the Social project, never another client's", async () => {
    const none = approvalWorld({});
    expect(await projectIdFor(none.ctx, "co", CLIENT)).toBe("proj-social");
    expect(await projectIdFor(none.ctx, "co", { kind: "company", id: "someone-else" })).toBe("proj-social");
    const empty = approvalWorld({ clientProjects: [] });
    expect(await projectIdFor(empty.ctx, "co", CLIENT)).toBe("proj-social");
  });

  it("a linked project that was archived is skipped (the plugin reads projects now), and the next linked one is used", async () => {
    const w = approvalWorld({ clientProjects: ["proj-old", "proj-new"], archivedProjects: ["proj-old"] });
    expect(await projectIdFor(w.ctx, "co", CLIENT)).toBe("proj-new");
    const allGone = approvalWorld({ clientProjects: ["proj-old"], archivedProjects: ["proj-old"] });
    expect(await projectIdFor(allGone.ctx, "co", CLIENT)).toBe("proj-social");
  });

  it("without any project it answers undefined (the host then opens the issue with none), and a lookup failure falls back", async () => {
    const w = approvalWorld({ clientProjects: ["proj-acme"] });
    (w.ctx.projects.managed.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("no project"));
    (w.ctx.projects.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("forbidden"));
    // Reading fails: the link is trusted (the kit's rule when the plugin cannot read projects).
    expect(await projectIdFor(w.ctx, "co", CLIENT)).toBe("proj-acme");
    expect(await projectIdFor(w.ctx, "co", null)).toBeUndefined();
  });

  it("the CRM's link list reaches the plugin as plugin state, newest list wins", async () => {
    const store = new Map<string, unknown>();
    const ctx = { state: { get: async (k: { stateKey: string }) => store.get(k.stateKey) ?? null, set: async (k: { stateKey: string }, v: unknown) => void store.set(k.stateKey, v) } } as never;
    expect(await rememberClientProjects(ctx, "co", { clientKind: "company", clientRef: "c1", projectIds: ["p1"], updatedAt: "2026-10-03T08:00:00Z" })).toBe(true);
    expect(await rememberClientProjects(ctx, "co", { clientKind: "company", clientRef: "c1", projectIds: ["p-stale"], updatedAt: "2026-10-03T07:00:00Z" })).toBe(false);
    expect(await rememberClientProjects(ctx, "co", { clientKind: "company", clientRef: "c1", projectIds: [], updatedAt: "2026-10-03T09:00:00Z" })).toBe(true);
    expect(store.get("client-projects:company:c1")).toEqual({ projectIds: [], updatedAt: "2026-10-03T09:00:00Z" });
  });
});

describe("the call sites", () => {
  it("a failed publish, a reconnect and a review for a client open in the client's project; for own work in the Social project", async () => {
    const w = approvalWorld({ clientProjects: ["proj-acme"] });
    const failedDest = { id: "d1", account_id: "a1", attempts: 5, last_error: "boom" } as unknown as DestinationRow;
    await openPublishFailureIssue(w.ctx, { companyId: "co", post: postRow(w), failed: [{ destination: failedDest, account: account("a1") as AccountRow }], published: 0 });
    await openReconnectIssue(w.ctx, "co", account("a1", { client_kind: "company", client_ref: "c1", client_name: "Acme" }), "expired");
    expect(w.created.map((c) => c.projectId)).toEqual(["proj-acme", "proj-acme"]);
    const own = approvalWorld({ client: null, clientProjects: ["proj-acme"] });
    await openPublishFailureIssue(own.ctx, { companyId: "co", post: postRow(own), failed: [{ destination: failedDest, account: account("a1") as AccountRow }], published: 0 });
    await openReconnectIssue(own.ctx, "co", account("a1"), "expired");
    expect(own.created.map((c) => c.projectId)).toEqual(["proj-social", "proj-social"]);
  });

  it("a post sent for review (client approves) and the time task after approval open in the client's project", async () => {
    const w = approvalWorld({ clientProjects: ["proj-acme"], policy: { require_owner: false, require_client: true } });
    w.post.status = "draft";
    await transitionPost(w.ctx, SOCIAL_AGENT, "p1", "review");
    expect(w.created[0]).toMatchObject({ originId: "review:p1", projectId: "proj-acme" });
    const unscheduled = approvalWorld({ clientProjects: ["proj-acme"] });
    await transitionPost(unscheduled.ctx, { companyId: "co", userId: "owner-1", agentId: null, runId: null, isAgent: false }, "p1", "approved");
    expect(unscheduled.created[0]).toMatchObject({ originId: expect.stringMatching(/^schedule:company:c1:p1$/), projectId: "proj-acme" });
  });

  it("no call site that opens a scope's issue still passes the shared Social project", () => {
    // socialProjectId (the shared project) may only be the fallback inside issues.ts and the Cockpit health link.
    const dir = new URL("../src/", import.meta.url);
    const offenders: string[] = [];
    const walk = (path: URL) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), path);
        if (entry.isDirectory()) walk(child);
        else if (/\.tsx?$/.test(entry.name)) {
          const text = readFileSync(child, "utf8");
          if (/\bsocialProjectId\(/.test(text) && !/src\/(issues|cockpit)\.ts$/.test(child.pathname)) offenders.push(child.pathname.split("/src/")[1]!);
        }
      }
    };
    walk(dir);
    expect(offenders).toEqual([]);
    for (const file of ["review.ts", "schedule.ts", "triage.ts", "plan-trigger.ts", "handoff.ts", "issues.ts", "growth/service.ts"]) {
      expect(readFileSync(new URL(file, dir), "utf8"), file).toMatch(/projectIdFor(Row)?\(/);
    }
  });
});
