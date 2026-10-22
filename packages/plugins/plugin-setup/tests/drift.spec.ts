import { describe, expect, it } from "vitest";
import { loadPack, templateVars, type AgentLike } from "../src/templates.js";
import { renderHash } from "../src/render-hash.js";
import { renderInstructions } from "../src/templates-render.js";
import { parsePibPack, computeDrift, type PibPack } from "../src/drift.js";

const vars = templateVars({
  company: "Test Co",
  prefix: "TST",
  owner: "Owner",
  ceo: { name: "CEO", urlKey: "ceo" },
});
const pack = loadPack();
const ceoTemplate = pack.templates.find((t) => t.key === "ceo")!;
const validHash = renderHash(renderInstructions(ceoTemplate, vars));

const agent = (id: string, name: string, extra: Record<string, unknown> = {}): AgentLike =>
  ({
    id,
    name,
    title: null,
    role: "general",
    status: "idle",
    ...extra,
  } as unknown as AgentLike);

const validPibPack = (): PibPack => ({
  pack: "Q7-5",
  version: 2,
  key: "ceo",
  hash: validHash,
  appliedAt: "2026-10-20T10:00:00.000Z",
});

describe("parsePibPack", () => {
  it("accepts valid pibPack, returns as-is (strict, no normalization)", () => {
    const input = {
      pack: "Q7-5",
      version: 2,
      key: "ceo",
      hash: "a1b2c3d4e5f6a1b2",
      appliedAt: "2026-10-20T10:00:00.000Z",
      evalFile: "eval.json",
    };
    expect(parsePibPack(input)).toEqual(input);
  });

  it("rejects uppercase hex hash", () => {
    expect(
      parsePibPack({
        pack: "Q7-5",
        version: 2,
        key: "ceo",
        hash: "A1B2C3D4E5F6A1B2",
        appliedAt: "2026-10-20T10:00:00.000Z",
      })
    ).toBeNull();
  });

  it.each([
    ["pack empty", { pack: "", version: 1, key: "k", hash: "a1b2c3d4e5f6a1b2", appliedAt: "2026-10-20T10:00:00.000Z" }],
    ["pack 33 chars", { pack: "x".repeat(33), version: 1, key: "k", hash: "a1b2c3d4e5f6a1b2", appliedAt: "2026-10-20T10:00:00.000Z" }],
    ["version not int", { pack: "p", version: 1.5, key: "k", hash: "a1b2c3d4e5f6a1b2", appliedAt: "2026-10-20T10:00:00.000Z" }],
    ["version -1", { pack: "p", version: -1, key: "k", hash: "a1b2c3d4e5f6a1b2", appliedAt: "2026-10-20T10:00:00.000Z" }],
    ["key 65 chars", { pack: "p", version: 1, key: "x".repeat(65), hash: "a1b2c3d4e5f6a1b2", appliedAt: "2026-10-20T10:00:00.000Z" }],
    ["key empty", { pack: "p", version: 1, key: "", hash: "a1b2c3d4e5f6a1b2", appliedAt: "2026-10-20T10:00:00.000Z" }],
    ["hash 15 chars", { pack: "p", version: 1, key: "k", hash: "a1b2c3d4e5f6a1b", appliedAt: "2026-10-20T10:00:00.000Z" }],
    ["hash non-hex", { pack: "p", version: 1, key: "k", hash: "g1b2c3d4e5f6a1b2", appliedAt: "2026-10-20T10:00:00.000Z" }],
    ["appliedAt no time", { pack: "p", version: 1, key: "k", hash: "a1b2c3d4e5f6a1b2", appliedAt: "2026-10-20" }],
    ["evalFile 81 chars", { pack: "p", version: 1, key: "k", hash: "a1b2c3d4e5f6a1b2", appliedAt: "2026-10-20T10:00:00.000Z", evalFile: "x".repeat(81) }],
    ["evalFile empty", { pack: "p", version: 1, key: "k", hash: "a1b2c3d4e5f6a1b2", appliedAt: "2026-10-20T10:00:00.000Z", evalFile: "" }],
  ])("rejects malformed: %s", (_label, input) => {
    expect(parsePibPack(input as unknown)).toBeNull();
  });

  it("rejects incomplete object {pack:p} (no other fields)", () => {
    expect(parsePibPack({ pack: "p" })).toBeNull();
  });

  it.each([[null], [""], [123], [true], [[1, 2, 3]]])("rejects non-objects: %o", (input) => {
    expect(parsePibPack(input)).toBeNull();
  });
});

describe("computeDrift", () => {
  it("skips host-owned templates", () => {
    const r = computeDrift({
      templates: [{ ...ceoTemplate, hostOwned: true }],
      agents: [agent("id", "CEO", { name: "CEO" })],
      vars,
      attachedSkills: {},
    });
    expect(r).toHaveLength(0);
  });
  it("no drift when current", () => {
    const a = agent("id", "CEO", {
      name: "CEO",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {
        model: "claude-sonnet-5-5",
        effort: "medium",
        timeoutSec: 3600,
        maxTurnsPerRun: 300,
      },
      metadata: { pibPack: validPibPack() },
    });
    const r = computeDrift({
      templates: [ceoTemplate],
      agents: [a],
      vars,
      attachedSkills: { id: ceoTemplate.desiredSkills },
    });
    expect(r).toHaveLength(1);
    expect(r[0]!.reasons).toHaveLength(0);
    expect(r[0]!.drifted).toBe(false);
  });

  it("hash mismatch", () => {
    const a = agent("id", "CEO", {
      name: "CEO",
      metadata: { pibPack: { ...validPibPack(), hash: "0000000000000000" } },
    });
    const r = computeDrift({
      templates: [ceoTemplate],
      agents: [a],
      vars,
      attachedSkills: {},
    });
    const reason = r[0]!.reasons.find((x) => x.code === "hash_mismatch") as unknown as {
      expected: string;
      actual: string;
    };
    expect(reason).toBeDefined();
    expect(reason.expected).toBe(validHash);
    expect(reason.actual).toBe("0000000000000000");
  });

  it("detects behind_no_metadata", () => {
    const r = computeDrift({
      templates: [ceoTemplate],
      agents: [agent("id", "CEO", { name: "CEO", metadata: {} })],
      vars,
      attachedSkills: {},
    });
    expect(r[0]!.reasons.some((x) => x.code === "behind_no_metadata")).toBe(true);
  });

  it("detects behind_malformed_metadata", () => {
    const r = computeDrift({
      templates: [ceoTemplate],
      agents: [agent("id", "CEO", { name: "CEO", metadata: { pibPack: { pack: "p" } } })],
      vars,
      attachedSkills: {},
    });
    expect(r[0]!.reasons.some((x) => x.code === "behind_malformed_metadata")).toBe(true);
  });

  it("detects skill_missing", () => {
    const a = agent("id", "CEO", {
      name: "CEO",
      metadata: { pibPack: validPibPack() },
    });
    const r = computeDrift({
      templates: [ceoTemplate],
      agents: [a],
      vars,
      attachedSkills: { id: [] },
    });
    const skills = r[0]!.reasons.filter((x) => x.code === "skill_missing");
    expect(skills.length).toBeGreaterThan(0);
    expect((skills[0] as unknown as { skill: string }).skill).toBeTruthy();
  });

  it("detects run_profile problems", () => {
    const a = agent("id", "CEO", {
      name: "CEO",
      adapterType: "claude_local",
      adapterConfig: { model: "", effort: "medium", timeoutSec: 0, maxTurnsPerRun: 300 },
      metadata: { pibPack: validPibPack() },
    });
    const r = computeDrift({
      templates: [ceoTemplate],
      agents: [a],
      vars,
      attachedSkills: { id: ceoTemplate.desiredSkills },
    });
    const reason = r[0]!.reasons.find((x) => x.code === "run_profile") as unknown as {
      problems: string[];
    };
    expect(reason?.problems.length).toBeGreaterThan(0);
  });

  it("over_budget with other reasons", () => {
    const bigVars = { ...vars, company: "x".repeat(15000) };
    const a = agent("id", "CEO", {
      name: "CEO",
      metadata: { pibPack: validPibPack() },
    });
    const r = computeDrift({
      templates: [ceoTemplate],
      agents: [a],
      vars: bigVars,
      attachedSkills: { id: ceoTemplate.desiredSkills },
    });
    const reason = r[0]!.reasons.find((x) => x.code === "over_budget") as unknown as {
      chars: number;
      budget: number;
    };
    expect(reason?.chars).toBeGreaterThan(14500);
    expect(reason?.budget).toBe(14500);
  });

  it("mid-run alone: midRun=true, drifted=false", () => {
    const a = agent("id", "CEO", {
      name: "CEO",
      status: "running",
      adapterType: "claude_local",
      adapterConfig: {
        model: "claude-sonnet-5-5",
        effort: "medium",
        timeoutSec: 3600,
        maxTurnsPerRun: 300,
      },
      metadata: { pibPack: validPibPack() },
    });
    const r = computeDrift({
      templates: [ceoTemplate],
      agents: [a],
      vars,
      attachedSkills: { id: ceoTemplate.desiredSkills },
    });
    expect(r[0]!.midRun).toBe(true);
    expect(r[0]!.reasons.some((x) => x.code === "mid_run")).toBe(true);
    expect(r[0]!.drifted).toBe(false);
  });

  it("mid-run + mismatch: drifted=true", () => {
    const a = agent("id", "CEO", {
      name: "CEO",
      status: "running",
      metadata: { pibPack: { ...validPibPack(), hash: "0000000000000000" } },
    });
    const r = computeDrift({
      templates: [ceoTemplate],
      agents: [a],
      vars,
      attachedSkills: {},
    });
    const codes = r[0]!.reasons.map((x) => x.code);
    expect(codes).toContain("hash_mismatch");
    expect(codes).toContain("mid_run");
    expect(r[0]!.drifted).toBe(true);
  });

  it("skips skills when unknown", () => {
    const a = agent("id", "CEO", {
      name: "CEO",
      metadata: { pibPack: validPibPack() },
      adapterType: "claude_local",
      adapterConfig: {
        model: "claude-sonnet-5-5",
        effort: "medium",
        timeoutSec: 3600,
        maxTurnsPerRun: 300,
      },
    });
    const r = computeDrift({
      templates: [ceoTemplate],
      agents: [a],
      vars,
      attachedSkills: {},
    });
    expect(r[0]!.reasons.some((x) => x.code === "skill_missing")).toBe(false);
  });

  it("null pibPack: behind_no_metadata", () => {
    const a = agent("id", "CEO", {
      name: "CEO",
      metadata: { pibPack: null },
    });
    const r = computeDrift({
      templates: [ceoTemplate],
      agents: [a],
      vars,
      attachedSkills: {},
    });
    expect(r[0]!.reasons.map((x) => x.code)).toEqual(["behind_no_metadata"]);
  });

  it("reason order: hash, profile, skill, budget, mid_run", () => {
    const bigVars = { ...vars, company: "x".repeat(15000) };
    const a = agent("id", "CEO", {
      name: "CEO",
      status: "running",
      adapterType: "claude_local",
      adapterConfig: { model: "", effort: "medium", timeoutSec: 0, maxTurnsPerRun: 300 },
      metadata: { pibPack: { ...validPibPack(), hash: "0000000000000000" } },
    });
    const r = computeDrift({
      templates: [ceoTemplate],
      agents: [a],
      vars: bigVars,
      attachedSkills: { id: [] },
    });
    const codes = r[0]!.reasons.map((x) => x.code);
    const idxHash = codes.indexOf("hash_mismatch");
    const idxProf = codes.indexOf("run_profile");
    const idxSkill = codes.indexOf("skill_missing");
    const idxBudget = codes.indexOf("over_budget");
    const idxMid = codes.indexOf("mid_run");
    expect(idxHash < idxProf).toBe(true);
    expect(idxProf < idxSkill).toBe(true);
    expect(idxSkill < idxBudget).toBe(true);
    expect(idxBudget < idxMid).toBe(true);
  });
});
