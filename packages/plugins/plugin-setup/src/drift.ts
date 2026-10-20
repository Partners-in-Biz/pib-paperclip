// Pure template drift detection: agents vs. their templates.
// No I/O, deterministic. Mid-run agents flagged separately, not counted as drifted.
// Host-owned templates skipped. Absent attachedSkills entry means unknown, not checked.

import { renderHash } from "./render-hash.js";
import {
  MAX_INSTRUCTION_CHARS,
  matchTemplate,
  type AgentTemplate,
  type AgentLike,
  type TemplateVars,
} from "./templates.js";
import { renderInstructions } from "./templates-render.js";
import {
  agentRunProfileProblems,
  skillAttached,
  type AgentRunLike,
} from "@partnersinbiz/pib-plugin-kit";

export interface PibPack {
  pack: string;
  version: number;
  key: string;
  hash: string;
  appliedAt: string;
  evalFile?: string;
}

export function parsePibPack(raw: unknown): PibPack | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.pack !== "string" || obj.pack.length < 1 || obj.pack.length > 32)
    return null;
  if (!Number.isInteger(obj.version) || (obj.version as number) < 0) return null;
  if (typeof obj.key !== "string" || obj.key.length < 1 || obj.key.length > 64)
    return null;
  if (typeof obj.hash !== "string" || !/^[0-9a-f]{16}$/.test(obj.hash)) return null;
  if (
    typeof obj.appliedAt !== "string" ||
    !Number.isFinite(Date.parse(obj.appliedAt)) ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T/.test(obj.appliedAt)
  )
    return null;
  if (obj.evalFile !== undefined) {
    if (
      typeof obj.evalFile !== "string" ||
      obj.evalFile.length < 1 ||
      obj.evalFile.length > 80
    )
      return null;
  }
  return {
    pack: obj.pack,
    version: obj.version as number,
    key: obj.key,
    hash: obj.hash,
    appliedAt: obj.appliedAt,
    ...(obj.evalFile ? { evalFile: obj.evalFile } : {}),
  };
}

export type DriftReason =
  | { code: "behind_no_metadata" }
  | { code: "behind_malformed_metadata" }
  | { code: "hash_mismatch"; expected: string; actual: string }
  | { code: "run_profile"; problems: string[] }
  | { code: "skill_missing"; skill: string }
  | { code: "over_budget"; chars: number; budget: number }
  | { code: "mid_run" };

export interface AgentDrift {
  agentId: string;
  templateKey: string;
  reasons: DriftReason[];
  midRun: boolean;
  drifted: boolean;
}

type DriftAgent = AgentLike & Partial<AgentRunLike> & { metadata?: { pibPack?: unknown } | null };

export function computeDrift(input: {
  templates: AgentTemplate[];
  agents: readonly AgentLike[];
  vars: TemplateVars;
  attachedSkills: Record<string, string[]>;
}): AgentDrift[] {
  const results: AgentDrift[] = [];

  for (const template of input.templates) {
    if (template.hostOwned) continue;
    const matched = matchTemplate(template, input.agents);
    if (!matched) continue;

    const agentId = matched.id;
    const agent = matched as DriftAgent;
    const reasons: DriftReason[] = [];

    // Parse and validate pibPack
    const pibPackValue = agent.metadata?.pibPack;
    const pibPack =
      pibPackValue === null || pibPackValue === undefined
        ? null
        : parsePibPack(pibPackValue);
    if (pibPackValue === null || pibPackValue === undefined) {
      reasons.push({ code: "behind_no_metadata" });
    } else if (pibPack === null) {
      reasons.push({ code: "behind_malformed_metadata" });
    }

    // Render once per template (always, for budget check)
    const rendered = renderInstructions(template, input.vars);
    const expectedHash = renderHash(rendered);

    // Compare hash if pack is valid
    if (pibPack) {
      if (expectedHash !== pibPack.hash) {
        reasons.push({
          code: "hash_mismatch",
          expected: expectedHash,
          actual: pibPack.hash,
        });
      }
    }

    // Check run profile
    const runProblems = agentRunProfileProblems(agent);
    if (runProblems.length > 0) {
      reasons.push({ code: "run_profile", problems: runProblems });
    }

    // Check skills (only if attachedSkills has an entry for this agent)
    if (agentId in input.attachedSkills) {
      const attached = input.attachedSkills[agentId] ?? [];
      for (const desired of template.desiredSkills) {
        if (!skillAttached(attached, desired)) {
          reasons.push({ code: "skill_missing", skill: desired });
        }
      }
    }

    // Check budget always
    if (rendered.length > MAX_INSTRUCTION_CHARS) {
      reasons.push({
        code: "over_budget",
        chars: rendered.length,
        budget: MAX_INSTRUCTION_CHARS,
      });
    }

    // Check mid-run (flagged but not counted as drifted)
    const midRun = agent.status === "running";
    if (midRun) {
      reasons.push({ code: "mid_run" });
    }

    const drifted = reasons.some((r) => r.code !== "mid_run");
    results.push({ agentId, templateKey: template.key, reasons, midRun, drifted });
  }

  return results;
}
