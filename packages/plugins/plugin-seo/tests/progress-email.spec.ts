import { describe, expect, it } from "vitest";
import { progressEmail, type ProgressSite } from "../src/engine/progress-email.js";

const site: ProgressSite = {
  siteName: "Hunt and Gun",
  siteUrl: "huntandgun.co.za",
  day: 20,
  done: [{ week: 0, titles: ["Site audit"] }, { week: 1, titles: ["Fix titles <b>"] }],
  open: [{ title: "Merchant Center account", waitingFor: "you" }],
  pages: { prepared: 5, asked: 4, approved: 0, held: 1 },
  next: [{ week: 4, titles: ["Blog post"] }],
};

describe("progressEmail", () => {
  it("covers done, open and the next weeks, and promises approval first", () => {
    const m = progressEmail({ greetingName: "Pieter", sites: [site], signature: "Partners in Biz" });
    expect(m.subject).toBe("SEO progress: Hunt and Gun");
    expect(m.text).toContain("Hi Pieter,");
    expect(m.text).toContain("Before launch: Site audit");
    expect(m.text).toContain("Week 4: Blog post");
    expect(m.text).toContain("waiting for you");
    expect(m.text).toContain("Nothing on a website changes until the owner");
  });
  it("escapes html", () => {
    expect(progressEmail({ greetingName: null, sites: [site], signature: "x" }).html).toContain("Fix titles &lt;b&gt;");
  });
});
