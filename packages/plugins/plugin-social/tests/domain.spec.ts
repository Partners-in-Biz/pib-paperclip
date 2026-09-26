import { describe, expect, it } from "vitest";
import {
  aggregateMetrics,
  assertAgentTransition,
  assertDestination,
  assertEditable,
  assertMetric,
  assertTransition,
  canTransition,
  createInboxItem,
  createMediaAsset,
  createRssFeed,
  createTemplate,
  normalizeSubreddit,
} from "../src/domain.js";

describe("post transitions", () => {
  it("follows draft → review → approved → scheduled → publishing → published", () => {
    expect(() => assertTransition("draft", "review")).not.toThrow();
    expect(() => assertTransition("review", "approved")).not.toThrow();
    expect(() => assertTransition("approved", "scheduled")).not.toThrow();
    expect(() => assertTransition("scheduled", "publishing")).not.toThrow();
    expect(canTransition("publishing", "partially_published")).toBe(true);
    expect(canTransition("partially_published", "publishing")).toBe(true);
    expect(canTransition("failed", "publishing")).toBe(true);
    expect(() => assertTransition("draft", "scheduled")).toThrow(/cannot move/);
    expect(() => assertTransition("published", "draft")).toThrow();
  });

  it("lets an agent submit review and schedule but never approve", () => {
    expect(() => assertAgentTransition("draft", "review")).not.toThrow();
    expect(() => assertAgentTransition("approved", "scheduled")).not.toThrow();
    expect(() => assertAgentTransition("review", "approved")).toThrow(/approves/);
  });

  it("only edits drafts and posts in review", () => {
    expect(() => assertEditable("draft")).not.toThrow();
    expect(() => assertEditable("review")).not.toThrow();
    expect(() => assertEditable("scheduled")).toThrow(/cannot be edited/);
  });
});

describe("destinations", () => {
  it("refuses a personal account on an organisation post", () => {
    expect(() => assertDestination({ postScope: "org", accountScope: "personal", accountOwnerUserId: "user-1", actorUserId: "user-1" })).toThrow(/personal account/);
  });

  it("requires the owner for a personal account", () => {
    expect(() => assertDestination({ postScope: "personal", accountScope: "personal", accountOwnerUserId: "user-1", actorUserId: "user-2" })).toThrow(/owner/);
  });
});

describe("records", () => {
  it("creates templates and rejects blanks", () => {
    expect(createTemplate({ companyId: "c", name: "Launch", body: "Live!", platform: "linkedin" })).toMatchObject({ name: "Launch", platform: "linkedin" });
    expect(() => createTemplate({ companyId: "c", name: " ", body: "x" })).toThrow(/name is required/);
    expect(() => createTemplate({ companyId: "c", name: "x", body: " " })).toThrow(/body is required/);
  });

  it("validates metrics", () => {
    expect(assertMetric(5, "views")).toBe(5);
    expect(() => assertMetric(-1, "likes")).toThrow(/non-negative/);
    expect(() => assertMetric(1.5, "shares")).toThrow(/non-negative/);
    expect(aggregateMetrics([{ views: 100, likes: 10, comments: 2, shares: 1 }, { views: 50, likes: 5, comments: 1, shares: 0 }])).toEqual({ views: 150, likes: 15, comments: 3, shares: 1 });
  });

  it("requires https media URLs", () => {
    expect(createMediaAsset({ companyId: "c", name: "Hero", url: "https://cdn.test/hero.png" }).kind).toBe("image");
    expect(() => createMediaAsset({ companyId: "c", name: "X", url: " " })).toThrow(/URL is required/);
    expect(() => createMediaAsset({ companyId: "c", name: "X", url: "http://x/y.png" })).toThrow(/https/);
    expect(() => createMediaAsset({ companyId: "c", name: "X", url: "https://u", kind: "audio" })).toThrow(/image or video/);
  });

  it("validates feeds and inbox items", () => {
    expect(createRssFeed({ companyId: "c", url: "https://blog.test/feed.xml" }).isActive).toBe(true);
    expect(() => createRssFeed({ companyId: "c", url: "ftp://x" })).toThrow(/http/);
    expect(createInboxItem({ companyId: "c", kind: "mention", body: "@us", author: "ada" })).toMatchObject({ status: "new", kind: "mention" });
    expect(() => createInboxItem({ companyId: "c", kind: "like", body: "x" })).toThrow(/mention, comment, or message/);
  });

  it("normalises subreddits", () => {
    expect(normalizeSubreddit("/r/SmallBusiness/")).toBe("SmallBusiness");
    expect(normalizeSubreddit("r/sa")).toBe("sa");
    expect(normalizeSubreddit("bad name!")).toBeNull();
  });
});
