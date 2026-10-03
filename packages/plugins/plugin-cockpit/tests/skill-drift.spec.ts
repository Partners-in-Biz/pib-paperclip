/**
 * Is the company's copy of a skill what the plugin ships? (the blocking finding on the eval harness)
 *
 * The first version compared `resolved.skill.markdown` with the shipped markdown. The host stores
 * a managed skill with a `key: "plugin/<plugin>/<skill>"` line injected into the frontmatter, so
 * the two were never equal: every live `record` and `baseline` refused. The answer is the host's
 * own `defaultDrift` verdict. These tests use the host's real storage shape (helpers/host-skills.ts,
 * a copy of its source, checked against the live company_skills rows) and not hand-built text.
 */
import { describe, expect, it } from "vitest";
import { candidateSlugFor, ownSkills, ranMismatch, ranSkillName, skillDrift, withoutManagedKey } from "../src/evals.js";
import { canonicalSkillKey, declarationOf, hostDefaultDrift, installedLikeHost, withManagedSkillKey } from "./helpers/host-skills.js";

const skills = ownSkills();

describe("the host's storage shape (the premise of the bug)", () => {
  it("every shipped skill is stored with a key line added, so the stored text is never the shipped text", () => {
    expect(skills.length).toBeGreaterThanOrEqual(4);
    for (const s of skills) {
      const stored = installedLikeHost(s.skillKey).markdown!;
      expect(stored, s.slug).not.toBe(s.markdown);
      expect(stored, s.slug).toContain(`key: "${canonicalSkillKey(s.skillKey)}"`);
      // The live rows: name, slug, description, then the key line, then the closing fence.
      const head = stored.split("\n");
      expect(head[4], s.slug).toBe(`key: "plugin/partnersinbiz-cockpit/${s.skillKey}"`);
      expect(head[5], s.slug).toBe("---");
    }
  });

  it("an unedited copy has no drift by the host's own rule, a changed SKILL.md or reference file has", () => {
    for (const s of skills) {
      const declaration = declarationOf(s.skillKey);
      const host = installedLikeHost(s.skillKey);
      expect(hostDefaultDrift(declaration, host), s.slug).toBeNull();
      expect(hostDefaultDrift(declaration, { ...host, markdown: `${host.markdown}\nx` }), s.slug)?.toEqual({ changedFiles: ["SKILL.md"] });
    }
    const operator = skills.find((s) => s.slug === "pib-operator")!;
    const path = operator.files[0]!.path;
    const host = installedLikeHost(operator.skillKey);
    expect(hostDefaultDrift(declarationOf(operator.skillKey), { ...host, files: { ...host.files, [path]: "changed" } })).toEqual({ changedFiles: [path] });
    // The shipped bytes as the company's copy is NOT how the host leaves it: that is drift, the very case the first version took for "same".
    expect(hostDefaultDrift(declarationOf(operator.skillKey), { ...host, markdown: operator.markdown })).toEqual({ changedFiles: ["SKILL.md"] });
  });
});

describe("skillDrift", () => {
  const operator = skills.find((s) => s.slug === "pib-operator")!;
  const host = installedLikeHost(operator.skillKey);

  it("uses the host's verdict: null and an empty list are in sync, a list is drift and names the files", () => {
    expect(skillDrift({ skill: { markdown: host.markdown }, defaultDrift: null }, operator.markdown)).toEqual({ drifted: false, changedFiles: [], source: "host" });
    expect(skillDrift({ skill: { markdown: host.markdown }, defaultDrift: { changedFiles: [] } }, operator.markdown).drifted).toBe(false);
    expect(skillDrift({ skill: { markdown: host.markdown }, defaultDrift: { changedFiles: ["SKILL.md", "references/a.md"] } }, operator.markdown)).toEqual({ drifted: true, changedFiles: ["SKILL.md", "references/a.md"], source: "host" });
  });

  it("the host's verdict wins over the text: host-shaped text that differs byte for byte from the shipped text is still in sync", () => {
    expect(host.markdown).not.toBe(operator.markdown);
    expect(skillDrift({ skill: { markdown: host.markdown }, defaultDrift: null }, operator.markdown).drifted).toBe(false);
    // And a verdict of drift is believed even when the SKILL.md text looks the same (a reference file changed).
    expect(skillDrift({ skill: { markdown: host.markdown }, defaultDrift: { changedFiles: ["references/x.md"] } }, operator.markdown).drifted).toBe(true);
  });

  it("with no verdict at all it compares SKILL.md with the managed key line taken out of both sides", () => {
    expect(skillDrift({ skill: { markdown: host.markdown } }, operator.markdown)).toEqual({ drifted: false, changedFiles: [], source: "text" });
    expect(skillDrift({ skill: { markdown: `${host.markdown}\nEdited.` } }, operator.markdown)).toEqual({ drifted: true, changedFiles: ["SKILL.md"], source: "text" });
    // Windows line endings in the stored copy are not an edit.
    expect(skillDrift({ skill: { markdown: host.markdown!.replace(/\n/g, "\r\n") } }, operator.markdown).drifted).toBe(false);
  });

  it("no copy to look at is no verdict, never a pass dressed as one", () => {
    expect(skillDrift(null, operator.markdown)).toEqual({ drifted: false, changedFiles: [], source: "unknown" });
    expect(skillDrift({ skill: null }, operator.markdown).source).toBe("unknown");
    expect(skillDrift({ skill: { markdown: null } }, operator.markdown).source).toBe("unknown");
  });
});

describe("withoutManagedKey", () => {
  it("removes only the key line of the frontmatter", () => {
    const text = "---\nname: a\nkey: \"plugin/x/a\"\ndescription: \"d\"\n---\n\nbody\nkey: kept in the body\n";
    expect(withoutManagedKey(text)).toBe("---\nname: a\ndescription: \"d\"\n---\n\nbody\nkey: kept in the body\n");
  });

  it("undoes the host's own rewrite exactly, for every shipped skill", () => {
    for (const s of skills) expect(withoutManagedKey(withManagedSkillKey(s.markdown, canonicalSkillKey(s.skillKey))), s.slug).toBe(withoutManagedKey(s.markdown));
  });
});

describe("which skill a harness run tested", () => {
  it("reads the name from the host's title", () => {
    expect(ranSkillName("Skill test: pib-operator")).toBe("pib-operator");
    expect(ranSkillName("  skill test:  pib-operator-candidate-abc123 ")).toBe("pib-operator-candidate-abc123");
    expect(ranSkillName("Fix the build")).toBeNull();
    expect(ranSkillName(null)).toBeNull();
  });

  it("live needs exactly the skill; a candidate needs the test copy named after its hash", () => {
    const hash = "0123456789abcdef";
    const copy = candidateSlugFor("pib-operator", hash);
    expect(copy).toBe("pib-operator-candidate-012345");
    expect(ranMismatch("pib-operator", "live", "pib-operator", hash)).toBeNull();
    expect(ranMismatch("PIB-Operator", "live", "pib-operator", hash)).toBeNull();
    expect(ranMismatch(copy, "live", "pib-operator", hash)).toContain("not run on the live skill text");
    expect(ranMismatch("pib-reviewer", "live", "pib-operator", hash)).toContain("not pib-operator");
    expect(ranMismatch(copy, "candidate", "pib-operator", hash)).toBeNull();
    expect(ranMismatch("pib-operator", "candidate", "pib-operator", hash)).toContain("not the candidate's test copy");
    // Another candidate's copy (a different text) is not this one.
    expect(ranMismatch(candidateSlugFor("pib-operator", "fedcba9876543210"), "candidate", "pib-operator", hash)).toContain("not the candidate's test copy");
    expect(ranMismatch(null, "live", "pib-operator", hash)).toContain("no skill name");
  });
});
