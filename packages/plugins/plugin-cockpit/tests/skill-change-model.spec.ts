/**
 * From a reviewed proposal to a pull request, the pure part (Q10-4, Q2-4): the
 * diff is applied to the real text or refused, the guardrails each have a case
 * that trips them, and the package says where to edit and what must pass.
 */
import { describe, expect, it } from "vitest";
import {
  applyUnifiedDiff,
  branchName,
  budgetFor,
  diffAddedLines,
  diffHash,
  droppedRules,
  pullRequestPackage,
  reviewProposal,
  SkillChangeError,
  sourceFor,
} from "../src/skill-change-model.js";

const SKILL = ["# Demo skill", "", "## Steps", "1. Read the brief.", "2. Do the work.", "3. Close the issue with evidence.", "", "## Never", "- Never approve money items.", "- Never send anything yourself.", "- Never write a secret anywhere.", ""].join("\n");

const diff = (body: string[]) => body.join("\n");

describe("applyUnifiedDiff", () => {
  it("applies a hunk where its line numbers say", () => {
    const d = diff(["--- a/SKILL.md", "+++ b/SKILL.md", "@@ -4,3 +4,4 @@", " 1. Read the brief.", "+1b. Read the last three comments too.", " 2. Do the work.", " 3. Close the issue with evidence."]);
    const out = applyUnifiedDiff(SKILL, d);
    expect(out.text).toContain("1. Read the brief.\n1b. Read the last three comments too.\n2. Do the work.");
    expect(out).toMatchObject({ added: 1, removed: 0, hunks: 1 });
  });

  it("finds a hunk by its context when the numbers are off or missing", () => {
    const off = diff(["@@ -40,2 +40,2 @@", "-2. Do the work.", "+2. Do the work, small steps first."]);
    expect(applyUnifiedDiff(SKILL, off).text).toContain("2. Do the work, small steps first.");
    const bare = diff(["@@ @@", " 2. Do the work.", "+2b. Say what you did not check."]);
    expect(applyUnifiedDiff(SKILL, bare).text).toContain("2. Do the work.\n2b. Say what you did not check.");
  });

  it("counts added and removed lines net, and applies several hunks in order", () => {
    const d = diff(["@@ -4,1 +4,1 @@", "-1. Read the brief.", "+1. Read the brief and the thread.", "@@ -6,1 +6,2 @@", " 3. Close the issue with evidence.", "+4. Leave a Learned line."]);
    const out = applyUnifiedDiff(SKILL, d);
    expect(out.text).toContain("1. Read the brief and the thread.");
    expect(out.text).toContain("3. Close the issue with evidence.\n4. Leave a Learned line.");
    expect(out).toMatchObject({ added: 2, removed: 1, hunks: 2 });
  });

  it("refuses a hunk whose text is not in the skill, and says where it started", () => {
    const d = diff(["@@ -4,1 +4,1 @@", "-1. Read the whole company wiki.", "+1. Read nothing."]);
    expect(() => applyUnifiedDiff(SKILL, d)).toThrow(/Hunk 1 does not apply.*Read the whole company wiki/);
  });

  it("refuses an ambiguous hunk rather than guess", () => {
    const twice = `${SKILL}\n## Again\n- Never approve money items.\n`;
    const d = diff(["@@ @@", "-- Never approve money items.", "+- Approve small money items."]);
    expect(() => applyUnifiedDiff(twice, d)).toThrow(/ambiguous.*2 places/);
  });

  it("refuses a diff with no hunks, and an insertion that says nowhere", () => {
    expect(() => applyUnifiedDiff(SKILL, "just some text")).toThrow(SkillChangeError);
    expect(() => applyUnifiedDiff(SKILL, diff(["@@ @@", "+a new line"]))).toThrow(/only adds lines and says nowhere/);
  });

  it("keeps the text's own line endings and ignores diff headers", () => {
    const crlf = SKILL.replace(/\n/g, "\r\n");
    const d = diff(["diff --git a/x b/x", "index 1..2 100644", "--- a/x", "+++ b/x", "@@ @@", "-2. Do the work.", "+2. Do the work well."]);
    const out = applyUnifiedDiff(crlf, d);
    expect(out.text).toContain("2. Do the work well.\r\n");
    expect(out.text).not.toMatch(/[^\r]\n/);
  });
});

describe("the guardrails", () => {
  const review = (d: string, slug = "pib-demo", file = "SKILL.md", current = SKILL) => reviewProposal({ slug, file, current, diff: d });
  const small = diff(["@@ @@", " 2. Do the work.", "+2b. Say what you did not check."]);

  it("lets a small, safe change through", () => {
    const r = review(small);
    expect(r.allowed).toBe(true);
    expect(r.needsOwner).toBe(false);
    expect(r.checks.every((c) => c.ok)).toBe(true);
    expect(r.after - r.before).toBe("2b. Say what you did not check.\n".length);
  });

  it("blocks a change that takes the file over its budget, with the way out", () => {
    const big = diff(["@@ @@", " 2. Do the work.", `+${"x".repeat(100)}`]);
    const r = review(big, "pib-demo", "SKILL.md", `${SKILL}${"filler ".repeat(3000)}\n`);
    expect(r.allowed).toBe(false);
    expect(r.checks.find((c) => !c.ok)!.detail).toContain("over its 19000 budget");
    expect(r.checks.find((c) => !c.ok)!.detail).toContain("references");
  });

  it("holds the Operator and the references to their own budgets", () => {
    expect(budgetFor("pib-operator", "SKILL.md")).toBe(18_950);
    expect(budgetFor("pib-reviewer", "SKILL.md")).toBe(19_000);
    expect(budgetFor("pib-operator", "references/health-checks.md")).toBe(8_000);
  });

  it("blocks a change that grows the file by more than one change may", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `+Line ${i} says something new and long enough to add up over sixty lines of text.`);
    const r = review(diff(["@@ @@", " 2. Do the work.", ...lines]));
    expect(r.allowed).toBe(false);
    expect(r.checks.some((c) => !c.ok && c.detail.includes("Split it into smaller proposals"))).toBe(true);
  });

  it("blocks a rewrite by line count", () => {
    const lines = Array.from({ length: 130 }, (_, i) => `+${i}`);
    const r = review(diff(["@@ @@", " 2. Do the work.", ...lines]), "pib-demo", "SKILL.md", SKILL + "x".repeat(60_000).slice(0, 0));
    expect(r.checks.some((c) => !c.ok && c.detail.includes("a rewrite, not a change"))).toBe(true);
  });

  it("blocks a secret in what is added", () => {
    const r = review(diff(["@@ @@", " 2. Do the work.", "+Use token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 for the API."]));
    expect(r.allowed).toBe(false);
    expect(r.checks.some((c) => !c.ok && c.detail.includes("secret"))).toBe(true);
  });

  it("flags for the owner a change that drops a never-rule nothing replaces, and not one that rewords it", () => {
    const dropped = review(diff(["@@ @@", "-- Never send anything yourself.", "+- Send small things yourself."]));
    expect(dropped.needsOwner).toBe(true);
    expect(dropped.allowed).toBe(true);
    expect(dropped.checks.some((c) => !c.ok && c.detail.includes("Never send anything yourself"))).toBe(true);
    const reworded = review(diff(["@@ @@", "-- Never send anything yourself.", "+- Never send anything yourself, not even a draft email."]));
    expect(reworded.needsOwner).toBe(false);
    const deleted = review(diff(["@@ @@", " - Never approve money items.", "-- Never send anything yourself.", " - Never write a secret anywhere."]));
    expect(deleted.needsOwner).toBe(true);
  });

  it("droppedRules compares what is left, whatever the diff says", () => {
    expect(droppedRules(SKILL, SKILL)).toEqual([]);
    expect(droppedRules(SKILL, SKILL.replace("- Never approve money items.\n", ""))).toEqual(["- Never approve money items."]);
    expect(droppedRules(SKILL, SKILL.replace("Never approve money items.", "Never approve money items or legal items."))).toEqual([]);
  });

  it("reads the lines a diff adds", () => {
    expect(diffAddedLines(diff(["--- a", "+++ b", "@@ @@", " ctx", "+one", "-two", "+three"]))).toEqual(["one", "three"]);
  });
});

describe("the pull request package", () => {
  const d = diff(["@@ @@", " 2. Do the work.", "+2b. Say what you did not check."]);
  const review = reviewProposal({ slug: "pib-operator", file: "SKILL.md", current: SKILL, diff: d });
  const pkg = pullRequestPackage({
    slug: "pib-operator",
    file: "SKILL.md",
    reason: "The Operator closed blocked issues without a way out in three retros.",
    evidence: ["PAR-701 \"closed with no descriptor\"", "PAR-702"],
    diff: d,
    date: "2026-10-04",
    review,
    hash: { before: "aaaaaaaaaaaaaaaa", after: "bbbbbbbbbbbbbbbb" },
    improvement: { id: "imp123", metricKey: "company:blocked_no_descriptor", recheckAt: "2026-11-01T00:00:00.000Z" },
    sourceIssue: "/PAR/issues/PAR-950",
  });

  it("names a branch from the skill, the date and the diff, the same every time", () => {
    expect(pkg.branch).toBe(`skill/pib-operator/20261004-${diffHash(d)}`);
    expect(branchName("pib-operator", d, "2026-10-04")).toBe(pkg.branch);
    expect(diffHash(d)).toBe(diffHash(`${d}\n  \n`));
    expect(diffHash(d)).not.toBe(diffHash(d.replace("work", "job")));
  });

  it("goes into development, with the evidence, the diff and the checks in the body", () => {
    expect(pkg.base).toBe("development");
    // The title keeps the first 60 characters of the reason.
    expect(pkg.title).toBe("Skill pib-operator: The Operator closed blocked issues without a way out in thr…");
    for (const part of ["## Evidence", "PAR-701", "```diff", "+2b. Say what you did not check.", "## Checks the Cockpit ran", "ok: ", "`aaaaaaaaaaaaaaaa` to `bbbbbbbbbbbbbbbb`", "Proposal: /PAR/issues/PAR-950"]) expect(pkg.body, part).toContain(part);
  });

  it("says what must pass before merge, who reviews and merges, and how to roll back", () => {
    for (const part of ["skill-eval", "mode candidate", "evals/results.json", "No skill version ships if a scenario that passed at the baseline fails", "never `main`", "Code Reviewer", "Delivery Lead", "deploy-plugins.sh --rollback", "pib-deploy-request deploy", "agents cannot roll back", "`imp123`", "2026-11-01"]) expect(pkg.body, part).toContain(part);
  });

  it("lists the commands in order and the files to edit", () => {
    expect(pkg.steps[0]).toBe("git switch development && git pull --ff-only");
    expect(pkg.steps[1]).toContain(`git switch -c ${pkg.branch}`);
    expect(pkg.steps.join("\n")).toContain("gh pr create --base development");
    expect(pkg.files).toEqual(["packages/plugins/plugin-cockpit/src/skills.ts", "packages/plugins/plugin-cockpit/src/skill-references.ts"]);
  });

  it("for a skill the Cockpit does not ship, says it could not apply the diff and where to look", () => {
    const other = pullRequestPackage({ slug: "pib-crm-records", file: "SKILL.md", reason: "x", evidence: [], diff: d, date: "2026-10-04", review: null, hash: null, improvement: null, sourceIssue: null });
    expect(other.body).toContain("Not checked here: the Cockpit does not ship this skill");
    expect(other.body).toContain("(none given: a change with no evidence is a wish)");
    expect(other.steps.join("\n")).toContain('grep -rn "pib-crm-records" packages/plugins/*/src');
    expect(sourceFor("pib-crm-records").pluginDir).toContain("<plugin");
  });

  it("marks a blocking check and an owner check in the body", () => {
    const bad = reviewProposal({ slug: "pib-demo", file: "SKILL.md", current: SKILL, diff: diff(["@@ @@", "-- Never send anything yourself.", "+- Send small things yourself."]) });
    const body = pullRequestPackage({ slug: "pib-demo", file: "SKILL.md", reason: "x", evidence: [], diff: d, date: "2026-10-04", review: bad, hash: null, improvement: null, sourceIssue: null }).body;
    expect(body).toContain("OWNER: It drops 1");
  });
});
