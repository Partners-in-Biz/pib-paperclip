import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertAgentTransition, assertDestination, createPost, publishResult,
  aggregateMetrics,
  assertMetric,
  createMediaAsset,
  createRssFeed,
  createTemplate,} from "../src/domain.js";
import { NAMESPACE } from "../src/namespace.js";

describe("social", () => {
  it("uses the host namespace", () => {
    expect(NAMESPACE).toBe("plugin_social_e70c4e79f2");
    const sql = readFileSync(new URL("../migrations/001_social.sql", import.meta.url), "utf8");
    expect(sql).toContain(`CREATE TABLE ${NAMESPACE}.posts`);
    expect(sql).toContain(`CREATE TABLE ${NAMESPACE}.accounts`);
    expect(sql).toContain(`CREATE TABLE ${NAMESPACE}.destinations`);
  });

  it("refuses a personal account on an organisation post", () => {
    expect(() => assertDestination({
      postScope: "org",
      accountScope: "personal",
      accountOwnerUserId: "user-1",
      actorUserId: "user-1",
    })).toThrow(/personal account/);
  });

  it("requires the owning member for a personal account", () => {
    expect(() => assertDestination({
      postScope: "personal",
      accountScope: "personal",
      accountOwnerUserId: "user-1",
      actorUserId: "user-2",
    })).toThrow(/owning member|owner/);
  });

  it("lets an agent submit review and refuses approval", () => {
    expect(() => assertAgentTransition("draft", "review")).not.toThrow();
    expect(() => assertAgentTransition("review", "approved")).toThrow(/approves/);
  });

  it("fails publishing when the account has no credential reference", () => {
    expect(publishResult(null).status).toBe("failed");
    expect(publishResult("secret://linkedin").status).toBe("published");
    expect(createPost({ companyId: "co", body: "Hello", ownerUserId: "user-1" }).status).toBe("draft");
  });
});

describe("social templates", () => {
  it("creates a template with a platform", () => {
    const template = createTemplate({ companyId: "workspace-a", name: "Launch", body: "We are live!", platform: "linkedin" });
    expect(template.name).toBe("Launch");
    expect(template.platform).toBe("linkedin");
  });

  it("rejects a blank name or body", () => {
    expect(() => createTemplate({ companyId: "workspace-a", name: "  ", body: "x" })).toThrow(/name is required/);
    expect(() => createTemplate({ companyId: "workspace-a", name: "x", body: "  " })).toThrow(/body is required/);
  });
});

describe("social metrics", () => {
  it("rejects a negative or fractional metric", () => {
    expect(assertMetric(5, "views")).toBe(5);
    expect(() => assertMetric(-1, "likes")).toThrow(/non-negative/);
    expect(() => assertMetric(1.5, "shares")).toThrow(/non-negative/);
  });

  it("aggregates metrics across snapshots", () => {
    const totals = aggregateMetrics([
      { views: 100, likes: 10, comments: 2, shares: 1 },
      { views: 50, likes: 5, comments: 1, shares: 0 },
    ]);
    expect(totals).toEqual({ views: 150, likes: 15, comments: 3, shares: 1 });
  });
});

describe("social media assets", () => {
  it("creates an image asset", () => {
    const asset = createMediaAsset({ companyId: "workspace-a", name: "Hero", url: "https://cdn.test/hero.png" });
    expect(asset.kind).toBe("image");
    expect(asset.url).toBe("https://cdn.test/hero.png");
  });

  it("rejects a blank url and an invalid kind", () => {
    expect(() => createMediaAsset({ companyId: "workspace-a", name: "X", url: "  " })).toThrow(/URL is required/);
    expect(() => createMediaAsset({ companyId: "workspace-a", name: "X", url: "u", kind: "audio" })).toThrow(/image or video/);
  });
});

describe("social rss feeds", () => {
  it("creates an active feed", () => {
    const feed = createRssFeed({ companyId: "workspace-a", url: "https://blog.test/feed.xml" });
    expect(feed.isActive).toBe(true);
    expect(feed.url).toBe("https://blog.test/feed.xml");
  });

  it("rejects a blank or non-http url", () => {
    expect(() => createRssFeed({ companyId: "workspace-a", url: "  " })).toThrow(/URL is required/);
    expect(() => createRssFeed({ companyId: "workspace-a", url: "ftp://x" })).toThrow(/http/);
  });
});
