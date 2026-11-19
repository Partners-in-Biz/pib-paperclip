import { describe, expect, it } from "vitest";
import { classifyPaperclipSkillLink, type PaperclipSkillLinkEntry } from "./skill-link-classify.js";

const root = "/data/companies/c1/skills";
const entry: PaperclipSkillLinkEntry = {
  key: "acme/tools/deploy", runtimeName: "deploy--0123456789", skillId: "s1", versionId: "v1", currentVersionId: "v2",
};
const source = `${root}/__versions__/s1/v1`;
const classify = (resolvedTarget: string | null, overrides: Partial<PaperclipSkillLinkEntry> = {},
  resolvedSource: string | null = source) =>
  classifyPaperclipSkillLink({ resolvedTarget, resolvedSource, entry: { ...entry, ...overrides } });

describe("classifyPaperclipSkillLink", () => {
  describe("same", () => {
    it("accepts a target equal to the source", () => {
      expect(classify(source)).toEqual({ kind: "same", atRequestedVersion: true });
      expect(classify(`${root}/__runtime__/deploy--0123456789`, {}, `${root}/__runtime__/deploy--0123456789/`))
        .toEqual({ kind: "same", atRequestedVersion: true });
    });
    it("keeps a link at the current version when the run pins an older one, flagged", () => {
      expect(classify(`${root}/__versions__/s1/v2`)).toEqual({ kind: "same", atRequestedVersion: false });
    });
    it("accepts a link at the requested version when the source is elsewhere", () => {
      expect(classify(`${root}/__versions__/s1/v1`, {}, `${root}/__runtime__/deploy--0123456789`))
        .toEqual({ kind: "same", atRequestedVersion: true });
    });
  });

  describe("ours-stale", () => {
    it("a: another version of this skill", () => {
      expect(classify(`${root}/__versions__/s1/v0`)).toEqual({ kind: "ours-stale" });
    });
    it("a: takes the skill id from a version source when the entry has none", () => {
      expect(classify(`${root}/__versions__/s1/v0`, { skillId: undefined })).toEqual({ kind: "ours-stale" });
    });
    it("b: this skill's runtime projection", () => {
      expect(classify(`${root}/__runtime__/deploy--0123456789`)).toEqual({ kind: "ours-stale" });
    });
    it("c: this skill's catalog projection", () => {
      expect(classify(`${root}/__catalog__/deploy--0123456789`)).toEqual({ kind: "ours-stale" });
    });
    it("d: the direct-child slug folder", () => {
      expect(classify(`${root}/deploy`)).toEqual({ kind: "ours-stale" });
    });
    it("e: a bundled Paperclip skill in an installed release folder", () => {
      expect(classify("/usr/lib/node_modules/@paperclipai/server/skills/paperclip",
        { key: "paperclipai/paperclip/paperclip", runtimeName: "paperclip" })).toEqual({ kind: "ours-stale" });
    });
  });

  describe("foreign", () => {
    it("another skill id's version folder", () => {
      expect(classify(`${root}/__versions__/s2/v1`)).toEqual({ kind: "foreign" });
    });
    it("another company's root", () => {
      expect(classify("/data/companies/c2/skills/__versions__/s1/v1")).toEqual({ kind: "foreign" });
      expect(classify("/data/companies/c2/skills/__runtime__/deploy--0123456789")).toEqual({ kind: "foreign" });
    });
    it("a path that only shares a string prefix with the company root", () => {
      expect(classify(`${root}-x/__versions__/s1/v2`)).toEqual({ kind: "foreign" });
      expect(classify(`${root}-x/deploy`)).toEqual({ kind: "foreign" });
    });
    it("a personal Claude skill", () => {
      expect(classify("/home/u/.claude/skills/x", { runtimeName: "x" })).toEqual({ kind: "foreign" });
    });
    it("a version link when the skill id is unknown", () => {
      expect(classify(`${root}/__versions__/s1/v0`, { skillId: null }, `${root}/__runtime__/deploy--0123456789`))
        .toEqual({ kind: "foreign" });
    });
    it("a repo checkout for a paperclipai/paperclip key", () => {
      expect(classify("/home/u/repo/skills/paperclip",
        { key: "paperclipai/paperclip/paperclip", runtimeName: "paperclip" })).toEqual({ kind: "foreign" });
    });
    it("a release folder for a non-Paperclip key", () => {
      expect(classify("/usr/lib/node_modules/@paperclipai/server/skills/deploy--0123456789")).toEqual({ kind: "foreign" });
    });
    it("an unrelated sibling or reserved name", () => {
      expect(classify(`${root}/other`)).toEqual({ kind: "foreign" });
      expect(classify(`${root}/__runtime__/other--0123456789`)).toEqual({ kind: "foreign" });
    });
  });

  describe("fails closed", () => {
    it("on a null target or source", () => {
      expect(classify(null)).toEqual({ kind: "foreign" });
      expect(classify(source, {}, null)).toEqual({ kind: "foreign" });
    });
    it("on a source with no derivable company root", () => {
      expect(classify("/__versions__/s1/v0", {}, "/__versions__/s1/v1")).toEqual({ kind: "foreign" });
      expect(classify("/deploy", {}, "/x")).toEqual({ kind: "foreign" });
      expect(classify(`${root}/__versions__/s1/v0`, {}, "relative/__versions__/s1/v1")).toEqual({ kind: "foreign" });
    });
  });
});
