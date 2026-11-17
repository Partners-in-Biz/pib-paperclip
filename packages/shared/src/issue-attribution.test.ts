import { describe, expect, it } from "vitest";
import { deriveIssueCreator, deriveOriginatingActor, deriveResponsibleUser } from "./issue-attribution.js";

describe("deriveResponsibleUser", () => {
  it("prefers an explicit responsible user", () => {
    expect(
      deriveResponsibleUser({
        responsibleUserId: "user-responsible",
        createdByUserId: "user-creator",
      }),
    ).toEqual({
      userId: "user-responsible",
      source: "explicit",
      isAutoDerived: false,
    });
  });

  it("falls back to the creator user as an auto-derived responsible user", () => {
    expect(
      deriveResponsibleUser({
        responsibleUserId: null,
        createdByUserId: "user-creator",
      }),
    ).toEqual({
      userId: "user-creator",
      source: "creator",
      isAutoDerived: true,
    });
  });

  it("returns none when no human is available", () => {
    expect(
      deriveResponsibleUser({
        responsibleUserId: null,
        createdByUserId: null,
      }),
    ).toEqual({
      userId: null,
      source: "none",
      isAutoDerived: false,
    });
  });
});

describe("deriveOriginatingActor", () => {
  it("prefers the human creator over an explicit responsible user", () => {
    expect(
      deriveOriginatingActor({
        createdByUserId: "user-creator",
        createdByAgentId: null,
        responsibleUserId: "user-responsible",
      }),
    ).toEqual({ kind: "user", id: "user-creator" });
  });

  it("attributes an agent-created issue to the transitive responsible user via the agent", () => {
    expect(
      deriveOriginatingActor({
        createdByUserId: null,
        createdByAgentId: "agent-claude",
        responsibleUserId: "user-responsible",
      }),
    ).toEqual({ kind: "user", id: "user-responsible", viaAgentId: "agent-claude" });
  });

  it("falls back to the creating agent when no responsible user is known", () => {
    expect(
      deriveOriginatingActor({
        createdByUserId: null,
        createdByAgentId: "agent-claude",
        responsibleUserId: null,
      }),
    ).toEqual({ kind: "agent", id: "agent-claude" });
  });

  it("surfaces the responsible user for routine executions with no creator", () => {
    expect(
      deriveOriginatingActor({
        createdByUserId: null,
        createdByAgentId: null,
        responsibleUserId: "user-responsible",
      }),
    ).toEqual({ kind: "user", id: "user-responsible" });
  });

  it("returns null when nothing is attributable", () => {
    expect(
      deriveOriginatingActor({
        createdByUserId: null,
        createdByAgentId: null,
        responsibleUserId: null,
      }),
    ).toBeNull();
  });
});

describe("deriveIssueCreator", () => {
  const none = { createdByUserId: null, createdByAgentId: null };
  it("a person wins over an agent", () => {
    expect(deriveIssueCreator({ createdByUserId: "u1", createdByAgentId: "a1" })).toEqual({ kind: "person", id: "u1" });
  });
  it("shows the agent", () => {
    expect(deriveIssueCreator({ createdByUserId: null, createdByAgentId: "a1" })).toEqual({ kind: "agent", id: "a1" });
  });
  it("names plugin sources", () => {
    expect(deriveIssueCreator({ ...none, originKind: "plugin:partnersinbiz.seo" })).toEqual({ kind: "automation", name: "SEO" });
    expect(deriveIssueCreator({ ...none, originKind: "plugin:partnersinbiz.mailbox:operation" })).toEqual({ kind: "automation", name: "Mailbox" });
    expect(deriveIssueCreator({ ...none, originKind: "plugin:acme.lead-gen" })).toEqual({ kind: "automation", name: "Lead Gen" });
  });
  it("names routines, falling back when the name is unknown", () => {
    expect(deriveIssueCreator({ ...none, originKind: "routine_execution" }, { routineName: "Weekly report" })).toEqual({ kind: "automation", name: "Routine: Weekly report" });
    expect(deriveIssueCreator({ ...none, originKind: "routine_execution" })).toEqual({ kind: "automation", name: "Routine" });
  });
  it("never blank for system and manual-without-creator tasks", () => {
    expect(deriveIssueCreator({ ...none, originKind: "task_watchdog" })).toEqual({ kind: "automation", name: "System: Task Watchdog" });
    expect(deriveIssueCreator({ ...none, originKind: "manual" })).toEqual({ kind: "automation", name: "System" });
    expect(deriveIssueCreator(none)).toEqual({ kind: "automation", name: "System" });
  });
});
