import { describe, expect, it } from "vitest";
import { CLIENT_PROJECT_EVENTS, clientProjectIds, registerClientProjectWatch, rememberClientProjects, resolveClientProjectId, type ClientProjectsEvent } from "../src/index.js";
import { fakeCtx } from "./helpers/fake-ctx.js";

const EVENT = `plugin.partnersinbiz.crm.${CLIENT_PROJECT_EVENTS.updated}`;
const acme = { kind: "company" as const, id: "acme" };
const event = (patch: Record<string, unknown> = {}): ClientProjectsEvent => ({ clientKind: "company", clientRef: "acme", projectIds: ["p-acme"], updatedAt: "2026-10-01T10:00:00.000Z", ...patch }) as ClientProjectsEvent;

describe("the CRM's client-to-project links", () => {
  it("keeps the CRM's list for each client, newest wins, and an unlink is a shorter list", async () => {
    const fake = fakeCtx();
    registerClientProjectWatch(fake.ctx);
    await fake.deliver(EVENT, "co-1", event());
    expect(await clientProjectIds(fake.ctx, "co-1", acme)).toEqual(["p-acme"]);
    await fake.deliver(EVENT, "co-1", event({ projectIds: ["p-acme", "p-acme-web"], updatedAt: "2026-10-02T10:00:00.000Z" }));
    expect(await clientProjectIds(fake.ctx, "co-1", acme)).toEqual(["p-acme", "p-acme-web"]);
    await fake.deliver(EVENT, "co-1", event({ projectIds: ["p-acme"], updatedAt: "2026-10-01T09:00:00.000Z" }));
    expect(await clientProjectIds(fake.ctx, "co-1", acme)).toEqual(["p-acme", "p-acme-web"]);
    await fake.deliver(EVENT, "co-1", event({ projectIds: [], updatedAt: "2026-10-03T10:00:00.000Z" }));
    expect(await clientProjectIds(fake.ctx, "co-1", acme)).toEqual([]);
  });

  it("is per company and per client, and refuses a malformed event", async () => {
    const fake = fakeCtx();
    expect(await rememberClientProjects(fake.ctx, "co-1", event({ clientKind: "team" }) as never)).toBe(false);
    expect(await rememberClientProjects(fake.ctx, "co-1", event({ projectIds: "p" }) as never)).toBe(false);
    await rememberClientProjects(fake.ctx, "co-1", event());
    expect(await clientProjectIds(fake.ctx, "co-2", acme)).toEqual([]);
    expect(await clientProjectIds(fake.ctx, "co-1", { kind: "contact", id: "acme" })).toEqual([]);
    expect(await clientProjectIds(fake.ctx, "co-1", null)).toEqual([]);
  });
});

describe("resolveClientProjectId", () => {
  it("opens a client's work in the client's own project", async () => {
    const fake = fakeCtx({ projects: { "p-acme": {}, "social-managed": {} } });
    await rememberClientProjects(fake.ctx, "co-1", event());
    expect(await resolveClientProjectId(fake.ctx, "co-1", acme, { fallbackProjectId: "social-managed" })).toEqual({ projectId: "p-acme", source: "client-link", linked: ["p-acme"] });
  });

  it("puts own work in the plugin's own project", async () => {
    const fake = fakeCtx();
    expect(await resolveClientProjectId(fake.ctx, "co-1", null, { fallbackProjectId: "social-managed" })).toEqual({ projectId: "social-managed", source: "own", linked: [] });
    expect((await resolveClientProjectId(fake.ctx, "co-1", null)).source).toBe("none");
  });

  it("falls back to the plugin's own project for a client with no link, never another client's", async () => {
    const fake = fakeCtx({ projects: { "p-acme": {} } });
    await rememberClientProjects(fake.ctx, "co-1", event());
    const other = await resolveClientProjectId(fake.ctx, "co-1", { kind: "company", id: "globex" }, { fallbackProjectId: "social-managed" });
    expect(other).toEqual({ projectId: "social-managed", source: "fallback", linked: [] });
    expect((await resolveClientProjectId(fake.ctx, "co-1", { kind: "company", id: "globex" })).source).toBe("none");
  });

  it("skips a linked project that was deleted or archived, and trusts the link when projects cannot be read", async () => {
    const fake = fakeCtx({ projects: { "p-live": {}, "p-old": { archivedAt: "2026-09-30T00:00:00.000Z" } } });
    await rememberClientProjects(fake.ctx, "co-1", event({ projectIds: ["p-gone", "p-old", "p-live"] }));
    expect((await resolveClientProjectId(fake.ctx, "co-1", acme, { fallbackProjectId: "fb" })).projectId).toBe("p-live");
    await rememberClientProjects(fake.ctx, "co-1", event({ projectIds: ["p-gone"], updatedAt: "2026-10-04T00:00:00.000Z" }));
    expect((await resolveClientProjectId(fake.ctx, "co-1", acme, { fallbackProjectId: "fb" })).projectId).toBe("fb");
    const noRead = fakeCtx();
    (noRead.ctx.projects as { get: unknown }).get = async () => {
      throw new Error("projects.read is not granted");
    };
    await rememberClientProjects(noRead.ctx, "co-1", event());
    expect((await resolveClientProjectId(noRead.ctx, "co-1", acme, { fallbackProjectId: "fb" })).projectId).toBe("p-acme");
    expect((await resolveClientProjectId(noRead.ctx, "co-1", acme, { verify: false })).source).toBe("client-link");
  });

  it("lets the caller choose among several linked projects", async () => {
    const fake = fakeCtx({ projects: { a: {}, b: {} } });
    await rememberClientProjects(fake.ctx, "co-1", event({ projectIds: ["a", "b"] }));
    expect((await resolveClientProjectId(fake.ctx, "co-1", acme)).projectId).toBe("a");
    expect((await resolveClientProjectId(fake.ctx, "co-1", acme, { pick: (ids) => ids[ids.length - 1]! })).projectId).toBe("b");
  });
});
