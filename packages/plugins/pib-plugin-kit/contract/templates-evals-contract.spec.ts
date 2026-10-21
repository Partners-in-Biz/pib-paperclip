/**
 * Cross-plugin contract: Setup skeleton templates with evalFile must have matching
 * entries in Cockpit's results.json (baseline, candidate, or waiver); a missing eval
 * file is always a problem unless pending. Hash computed as sha256(rendered)[:16].
 */
import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const baseDir = fileURLToPath(new URL("../../plugin-setup", import.meta.url));
const cockpitEvalsDir = fileURLToPath(new URL("../../plugin-cockpit/evals", import.meta.url));

/** Eval files being added by sibling PAR-4013 children (not yet in repo). */
const PENDING_EVAL_FILES: Record<string, string> = {
  // delivery-lead.json: PAR-4013 sibling adds cockpit eval scenarios for delivery-lead template
  "delivery-lead.json": "PAR-4013 sibling child (delivery-lead eval scenarios)",
};

interface CheckInput {
  templates: Array<{ key: string; skeleton?: boolean; hostOwned?: boolean; evalFile?: string }>;
  evalFileExists: (path: string) => boolean;
  results: { enforce: boolean; skills: Record<string, any> };
  hashOf: (templateKey: string) => string | null;
}

/** Checks skeleton templates have eval files and results entries (or waivers when enforce=true). */
export function checkTemplateEvals(input: CheckInput): Array<{ template: string; message: string }> {
  const problems: Array<{ template: string; message: string }> = [];
  for (const t of input.templates) {
    if (!t.skeleton || t.hostOwned || !t.evalFile) continue;
    const hash = input.hashOf(t.key);
    if (hash === null) {
      problems.push({ template: t.key, message: `Could not compute hash for '${t.key}'` });
      continue;
    }
    const evalPath = join(cockpitEvalsDir, "agents", t.evalFile);
    if (!input.evalFileExists(evalPath) && !PENDING_EVAL_FILES[t.evalFile]) {
      problems.push({ template: t.key, message: `Eval file missing: evals/agents/${t.evalFile}` });
      continue;
    }
    if (!input.results.enforce) continue;
    // Check if hash is covered by ANY skill's baseline, candidates, or waivers
    const hashCovered = Object.values(input.results.skills).some((entry: any) =>
      entry.baseline?.hash === hash || entry.candidates?.[hash] || entry.waivers?.some((w: any) => w.hash === hash)
    );
    if (!hashCovered) {
      problems.push({ template: t.key, message: `No results entry for hash ${hash} (enforce=true)` });
    }
  }
  return problems;
}

/** Renders template by expanding includes and filling vars with defaults. */
function renderTemplate(file: string | undefined, files: Record<string, string>, blocks: Record<string, string>): string | null {
  if (!file) return null;
  let text = files[file];
  if (!text) return null;
  text = text.replace(/\{\{include:([a-z0-9-]+)\}\}/g, (_, name) => blocks[name]?.trimEnd() ?? "").trimEnd() + "\n";
  return text.replace(/\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g, (_, name) => ({
    company: "Example", prefix: "EX", owner: "owner", ceo: "CEO", ceoLink: "CEO", wikiRoot: "(none)",
  })[name as keyof typeof defaults] ?? "");
}

const defaults = { company: "Example", prefix: "EX", owner: "owner", ceo: "CEO", ceoLink: "CEO", wikiRoot: "(none)" };
function hashOfText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").substring(0, 16);
}

describe("template evals contract", () => {
  const hash = "abc123def456";
  const stub = (enforce = true, entry?: any): CheckInput => ({
    templates: [{ key: "test", skeleton: true, evalFile: "test.json" }],
    evalFileExists: () => true,
    results: { enforce, skills: entry ? { test: entry } : {} },
    hashOf: () => hash,
  });

  it("fails when enforce=true with no entry", () => {
    const p = checkTemplateEvals(stub(true));
    expect(p).toHaveLength(1);
    expect(p[0]?.message).toMatch(/No results entry/);
  });

  it("passes with enforce=true and baseline", () => {
    expect(checkTemplateEvals(stub(true, { baseline: { hash, passRate: 1, scenarios: {} } }))).toHaveLength(0);
  });

  it("passes with enforce=true and candidate", () => {
    expect(checkTemplateEvals(stub(true, { candidates: { [hash]: { passRate: 0.8 } } }))).toHaveLength(0);
  });

  it("passes with enforce=true and waiver", () => {
    expect(checkTemplateEvals(stub(true, { waivers: [{ hash, reason: "ok", by: "test", at: "2026-01-01" }] }))).toHaveLength(0);
  });

  it("finds hash in any skill (not just template key)", () => {
    const input = stub(true);
    input.results.skills = { "different-slug": { candidates: { [hash]: { passRate: 0.9 } } } };
    expect(checkTemplateEvals(input)).toHaveLength(0);
  });

  it("passes with enforce=false", () => {
    expect(checkTemplateEvals(stub(false))).toHaveLength(0);
  });

  it("fails when eval file missing", () => {
    const input = stub();
    input.evalFileExists = () => false;
    const p = checkTemplateEvals(input);
    expect(p).toHaveLength(1);
    expect(p[0]?.message).toMatch(/Eval file missing/);
  });

  it("pending eval file with enforce false causes no problems", () => {
    const input: CheckInput = {
      templates: [{ key: "delivery-lead", skeleton: true, evalFile: "delivery-lead.json" }],
      evalFileExists: () => false,
      results: { enforce: false, skills: {} },
      hashOf: () => hash,
    };
    expect(checkTemplateEvals(input)).toHaveLength(0);
  });

  it("ignores non-skeleton", () => {
    expect(checkTemplateEvals({
      templates: [{ key: "test", skeleton: false, evalFile: "test.json" }],
      evalFileExists: () => false,
      results: { enforce: true, skills: {} },
      hashOf: () => hash,
    })).toHaveLength(0);
  });

  it("ignores host-owned", () => {
    expect(checkTemplateEvals({
      templates: [{ key: "test", skeleton: true, hostOwned: true, evalFile: "test.json" }],
      evalFileExists: () => false,
      results: { enforce: true, skills: {} },
      hashOf: () => hash,
    })).toHaveLength(0);
  });

  it("ignores templates without evalFile", () => {
    expect(checkTemplateEvals({
      templates: [{ key: "test", skeleton: true }],
      evalFileExists: () => true,
      results: { enforce: true, skills: {} },
      hashOf: () => hash,
    })).toHaveLength(0);
  });

  describe("real-data test", () => {
    it("parses evals/agents/results.json and validates against the live manifest", () => {
      const setupDir = join(baseDir, "templates");
      const manifestPath = join(setupDir, "manifest.json");
      const agentsDir = join(setupDir, "agents");
      const resultsPath = join(cockpitEvalsDir, "agents", "results.json");

      const manifestText = readFileSync(manifestPath, "utf8");
      const manifest = JSON.parse(manifestText);
      if (!Array.isArray(manifest.templates)) throw new Error("Invalid manifest");

      const files: Record<string, string> = {};
      for (const f of readdirSync(agentsDir).filter((x) => x.endsWith(".md") && !x.startsWith("_"))) {
        files[f.replace(/\.md$/, "")] = readFileSync(join(agentsDir, f), "utf8");
      }

      const blocks: Record<string, string> = {};
      for (const f of readdirSync(agentsDir).filter((x) => x.startsWith("_") && x.endsWith(".md"))) {
        blocks[f.replace(/^_/, "").replace(/\.md$/, "")] = readFileSync(join(agentsDir, f), "utf8");
      }

      const results = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, "utf8")) : { enforce: false, skills: {} };
      const input: CheckInput = {
        templates: manifest.templates,
        evalFileExists: (p) => existsSync(p),
        results,
        hashOf: (key: string) => {
          const t = manifest.templates.find((x: any) => x.key === key);
          const rendered = t ? renderTemplate(t.file, files, blocks) : null;
          return rendered ? hashOfText(rendered) : null;
        },
      };

      const problems = checkTemplateEvals(input);
      expect(problems).toEqual([]);
    });

    it("fails if a pending eval file exists on disk (remove from PENDING_EVAL_FILES when adding it)", () => {
      for (const evalFile of Object.keys(PENDING_EVAL_FILES)) {
        const path = join(cockpitEvalsDir, "agents", evalFile);
        if (existsSync(path)) {
          throw new Error(`Pending eval file exists on disk: evals/agents/${evalFile}. Remove it from PENDING_EVAL_FILES in this spec.`);
        }
      }
    });
  });
});
