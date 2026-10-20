import { describe, expect, it } from "vitest";
import { CLIENT_PROJECT_EVENTS, clientProjectIds, clientProjectLinks, registerClientProjectWatch, rememberClientProjects, resolveClientProjectId, type ClientProjectsEvent } from "../src/index.js";
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
    expect(await resolveClientProjectId(fake.ctx, "co-1", acme, { fallbackProjectId: "social-managed" })).toEqual({ projectId: "p-acme", source: "client-link", kind: null, linked: ["p-acme"] });
  });

  it("puts own work in the plugin's own project", async () => {
    const fake = fakeCtx();
    expect(await resolveClientProjectId(fake.ctx, "co-1", null, { fallbackProjectId: "social-managed" })).toEqual({ projectId: "social-managed", source: "own", kind: null, linked: [] });
    expect((await resolveClientProjectId(fake.ctx, "co-1", null)).source).toBe("none");
  });

  it("falls back to the plugin's own project for a client with no link, never another client's", async () => {
    const fake = fakeCtx({ projects: { "p-acme": {} } });
    await rememberClientProjects(fake.ctx, "co-1", event());
    const other = await resolveClientProjectId(fake.ctx, "co-1", { kind: "company", id: "globex" }, { fallbackProjectId: "social-managed" });
    expect(other).toEqual({ projectId: "social-managed", source: "fallback", kind: null, linked: [] });
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

  describe("with kind resolution", () => {
    // (a) kind wins over order
    it("chooses a project by kind even if not the first", async () => {
      const fake = fakeCtx({ projects: { "p-crm": {}, "p-web": {}, "p-seo": {} } });
      await rememberClientProjects(fake.ctx, "co-1", event({
        projects: [
          { projectId: "p-crm", kind: "crm" },
          { projectId: "p-web", kind: "web" },
          { projectId: "p-seo", kind: "seo" },
        ],
      }));
      const result = await resolveClientProjectId(fake.ctx, "co-1", acme, { kind: "web" });
      expect(result.projectId).toBe("p-web");
      expect(result.kind).toBe("web");
      expect(result.source).toBe("client-link");
    });

    // (b) no kind match -> platform
    it("falls back to platform when requested kind has no match", async () => {
      const fake = fakeCtx({ projects: { "p-crm": {}, "p-platform": {} } });
      await rememberClientProjects(fake.ctx, "co-1", event({
        projects: [
          { projectId: "p-crm", kind: "crm" },
          { projectId: "p-platform", kind: "platform" },
        ],
      }));
      const result = await resolveClientProjectId(fake.ctx, "co-1", acme, { kind: "web" });
      expect(result.projectId).toBe("p-platform");
      expect(result.kind).toBe("platform");
    });

    // (c) no match and no platform -> fallback, NOT first linked
    it("uses fallback when no kind match and no platform, never first linked", async () => {
      const fake = fakeCtx({ projects: { "p-crm": {}, "p-other": {} } });
      await rememberClientProjects(fake.ctx, "co-1", event({
        projects: [
          { projectId: "p-crm", kind: "crm" },
          { projectId: "p-other", kind: "other" },
        ],
      }));
      const result = await resolveClientProjectId(fake.ctx, "co-1", acme, { fallbackProjectId: "fb", kind: "web" });
      expect(result.projectId).toBe("fb");
      expect(result.source).toBe("fallback");
      expect(result.kind).toBe(null);
    });

    // (d) only NULL-kind links + kind asked -> fallback
    it("falls back when only null-kind links exist and kind is requested", async () => {
      const fake = fakeCtx({ projects: { "p-1": {}, "p-2": {} } });
      await rememberClientProjects(fake.ctx, "co-1", event({
        projects: [
          { projectId: "p-1", kind: null },
          { projectId: "p-2", kind: null },
        ],
      }));
      const result = await resolveClientProjectId(fake.ctx, "co-1", acme, { fallbackProjectId: "fb", kind: "web" });
      expect(result.projectId).toBe("fb");
      expect(result.source).toBe("fallback");
    });

    // (e) archived kind match falls through to platform
    it("skips archived projects even when they match the kind", async () => {
      const fake = fakeCtx({
        projects: {
          "p-web-old": { archivedAt: "2026-09-30T00:00:00.000Z" },
          "p-platform": {},
        },
      });
      await rememberClientProjects(fake.ctx, "co-1", event({
        projects: [
          { projectId: "p-web-old", kind: "web" },
          { projectId: "p-platform", kind: "platform" },
        ],
      }));
      const result = await resolveClientProjectId(fake.ctx, "co-1", acme, { fallbackProjectId: "fb", kind: "web" });
      expect(result.projectId).toBe("p-platform");
      expect(result.kind).toBe("platform");
    });

    // (f) archived link plus only a NULL-kind other link, kind asked -> fallback
    it("falls back when only archived and null-kind links exist for the requested kind", async () => {
      const fake = fakeCtx({
        projects: {
          "p-archived": { archivedAt: "2026-09-30T00:00:00.000Z" },
          "p-other": {},
        },
      });
      await rememberClientProjects(fake.ctx, "co-1", event({
        projects: [
          { projectId: "p-archived", kind: "web" },
          { projectId: "p-other", kind: null },
        ],
      }));
      const result = await resolveClientProjectId(fake.ctx, "co-1", acme, { fallbackProjectId: "fb", kind: "web" });
      expect(result.projectId).toBe("fb");
      expect(result.source).toBe("fallback");
    });

    // (g) legacy projectIds payload stored, resolves without kind as before, with kind asked -> fallback
    it("treats legacy projectIds as null-kind links and falls back when kind requested", async () => {
      const fake = fakeCtx({ projects: { "p-acme": {}, "p-fb": {} } });
      await rememberClientProjects(fake.ctx, "co-1", event({ projectIds: ["p-acme"] }));
      // Without kind, should get the link as before
      const noKind = await resolveClientProjectId(fake.ctx, "co-1", acme, { fallbackProjectId: "p-fb" });
      expect(noKind.projectId).toBe("p-acme");
      expect(noKind.kind).toBe(null);
      // With kind, should fall back because legacy links have null kind
      const withKind = await resolveClientProjectId(fake.ctx, "co-1", acme, { fallbackProjectId: "p-fb", kind: "web" });
      expect(withKind.projectId).toBe("p-fb");
      expect(withKind.source).toBe("fallback");
    });

    // (h) new projects payload stores both projectIds and projects
    it("stores both projectIds and projects when given the new format", async () => {
      const fake = fakeCtx();
      const projects = [
        { projectId: "p-crm", kind: "crm" },
        { projectId: "p-web", kind: "web" },
      ];
      await rememberClientProjects(fake.ctx, "co-1", event({ projects }));
      const links = await clientProjectLinks(fake.ctx, "co-1", acme);
      expect(links).toEqual(projects);
      const ids = await clientProjectIds(fake.ctx, "co-1", acme);
      expect(ids).toEqual(["p-crm", "p-web"]);
    });

    // (i) old stored state {projectIds, updatedAt} set directly reads as kinds unknown
    it("reads old stored state without projects key as null-kind links", async () => {
      const fake = fakeCtx();
      // Simulate old stored state
      const key = {
        scopeKind: "company" as const,
        scopeId: "co-1",
        namespace: "pib-kit",
        stateKey: "client-projects:company:acme",
      };
      await fake.ctx.state.set(key, {
        projectIds: ["p-1", "p-2"],
        updatedAt: "2026-10-01T10:00:00.000Z",
      });
      const links = await clientProjectLinks(fake.ctx, "co-1", acme);
      expect(links).toEqual([
        { projectId: "p-1", kind: null },
        { projectId: "p-2", kind: null },
      ]);
      const choice = await resolveClientProjectId(fake.ctx, "co-1", acme);
      expect(choice.kind).toBe(null);
    });

    // (j) no kind option gives the same result as before for a mixed-kind list, result kind is the link's kind
    it("preserves old behavior when no kind option is given, includes link kind in result", async () => {
      const fake = fakeCtx({ projects: { "p-crm": {}, "p-web": {} } });
      await rememberClientProjects(fake.ctx, "co-1", event({
        projects: [
          { projectId: "p-crm", kind: "crm" },
          { projectId: "p-web", kind: "web" },
        ],
      }));
      const result = await resolveClientProjectId(fake.ctx, "co-1", acme);
      expect(result.projectId).toBe("p-crm");
      expect(result.kind).toBe("crm");
      expect(result.source).toBe("client-link");
    });

    // (k) link-then-unlink with SAME updatedAt: projects [a] then projects [] -> later arrival wins
    it("allows later arrival with equal updatedAt to overwrite earlier state", async () => {
      const fake = fakeCtx();
      const ts = "2026-10-01T10:00:00.000Z";
      await rememberClientProjects(fake.ctx, "co-1", event({
        projects: [{ projectId: "p-a", kind: "crm" }],
        updatedAt: ts,
      }));
      let links = await clientProjectLinks(fake.ctx, "co-1", acme);
      expect(links.map((l) => l.projectId)).toEqual(["p-a"]);

      const stored = await rememberClientProjects(fake.ctx, "co-1", event({
        projects: [],
        updatedAt: ts,
      }));
      expect(stored).toBe(true);
      links = await clientProjectLinks(fake.ctx, "co-1", acme);
      expect(links).toEqual([]);

      // Older updatedAt after a newer is rejected
      const older = await rememberClientProjects(fake.ctx, "co-1", event({
        projects: [{ projectId: "p-b", kind: "web" }],
        updatedAt: "2026-09-30T10:00:00.000Z",
      }));
      expect(older).toBe(false);
      links = await clientProjectLinks(fake.ctx, "co-1", acme);
      expect(links).toEqual([]);
    });

    // (l) pick is applied among usable kind matches
    it("respects the pick function among kind-matched usable projects", async () => {
      const fake = fakeCtx({ projects: { "p-web-1": {}, "p-web-2": {}, "p-crm": {} } });
      await rememberClientProjects(fake.ctx, "co-1", event({
        projects: [
          { projectId: "p-web-1", kind: "web" },
          { projectId: "p-web-2", kind: "web" },
          { projectId: "p-crm", kind: "crm" },
        ],
      }));
      const result = await resolveClientProjectId(fake.ctx, "co-1", acme, {
        kind: "web",
        pick: (ids) => ids[ids.length - 1]!,
      });
      expect(result.projectId).toBe("p-web-2");
      expect(result.kind).toBe("web");
    });
  });
});
