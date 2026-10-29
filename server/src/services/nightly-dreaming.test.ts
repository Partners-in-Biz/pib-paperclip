import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { nightlyDreamingEnabled, nightlyDreamingMaySchedule, nightlyDreamingRunBlocked } from "./nightly-dreaming.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const routinePath = path.resolve(
  here,
  "../built-ins/agents/reflection-coach/routines/recent-agent-reflection.md",
);
const definitionPath = path.resolve(here, "built-in-agents.ts");

describe("nightly dreaming flag", () => {
  it("defaults off and accepts only the explicit on values", () => {
    expect(nightlyDreamingEnabled({})).toBe(false);
    expect(nightlyDreamingEnabled({ PAPERCLIP_NIGHTLY_DREAMING: "" })).toBe(false);
    expect(nightlyDreamingEnabled({ PAPERCLIP_NIGHTLY_DREAMING: "0" })).toBe(false);
    expect(nightlyDreamingEnabled({ PAPERCLIP_NIGHTLY_DREAMING: "off" })).toBe(false);
    expect(nightlyDreamingEnabled({ PAPERCLIP_NIGHTLY_DREAMING: "yes" })).toBe(false);
    expect(nightlyDreamingEnabled({ PAPERCLIP_NIGHTLY_DREAMING: "1" })).toBe(true);
    expect(nightlyDreamingEnabled({ PAPERCLIP_NIGHTLY_DREAMING: "true" })).toBe(true);
    expect(nightlyDreamingEnabled({ PAPERCLIP_NIGHTLY_DREAMING: "on" })).toBe(true);
  });

  it("gates only the dreaming routine key", () => {
    expect(nightlyDreamingMaySchedule("nightly-dreaming", {})).toBe(false);
    expect(nightlyDreamingMaySchedule("nightly-dreaming", { PAPERCLIP_NIGHTLY_DREAMING: "1" })).toBe(true);
    expect(nightlyDreamingMaySchedule("recent-agent-reflection", {})).toBe(true);
  });

  it("blocks a stored dreaming routine by origin when the flag is off", () => {
    const dreaming = {
      originKind: "built_in_agent_bundle",
      originId: "reflection-coach:nightly-dreaming",
    };
    expect(nightlyDreamingRunBlocked(dreaming, {})).toBe(true);
    expect(nightlyDreamingRunBlocked(dreaming, { PAPERCLIP_NIGHTLY_DREAMING: "1" })).toBe(false);
    expect(nightlyDreamingRunBlocked({
      originKind: "built_in_agent_bundle",
      originId: "reflection-coach:recent-agent-reflection",
    }, {})).toBe(false);
    expect(nightlyDreamingRunBlocked({ originKind: "manual", originId: "nightly-dreaming" }, {})).toBe(false);
  });
});

describe("reflection-coach dreaming stock", () => {
  const routine = readFileSync(routinePath, "utf8");
  const definition = readFileSync(definitionPath, "utf8");

  it("ships paused, with the nightly schedule disabled", () => {
    expect(routine).toContain("status: paused");
    expect(routine).toContain("enabled: false");
    expect(routine).toContain('cronExpression: "15 3 * * *"');
    expect(routine).toContain("timezone: Africa/Johannesburg");
    expect(routine).not.toContain("enabled: true");
    expect(routine).not.toMatch(/0 9 \* \* 1/);
  });

  it("drafts for Code Reviewer and never applies", () => {
    expect(routine).toMatch(/Never apply/);
    expect(routine).toContain("code-reviewer");
    expect(routine).toContain("Never open `request_confirmation`");
    expect(routine).toContain("Dream draft:");
  });

  it("keeps the built-in definition paused and on the dreaming stock version", () => {
    const block = definition.slice(definition.indexOf('key: "reflection-coach"'));
    expect(block).toContain('stockVersion: "2026-10-29"');
    expect(block).toContain('status: "paused"');
    expect(block).toContain("enabled: false");
    expect(block).toContain('cronExpression: "15 3 * * *"');
    expect(block).toContain('timezone: "Africa/Johannesburg"');
    expect(routine).toContain("routineKey: nightly-dreaming");
    expect(routine).toContain("[redacted]");
    expect(definition).toContain("\"grok_local\"");
    expect(definition).toContain("\"hermes_local\"");
    expect(definition).toContain("REFLECTION_COACH_REVOKED_APPLY_GRANTS");
    expect(definition).toContain("nightlyDreamingMaySchedule");
  });
});
