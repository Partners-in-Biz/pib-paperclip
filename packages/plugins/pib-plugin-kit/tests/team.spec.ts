import { describe, expect, it } from "vitest";
import {
  activeTeamRoles,
  COMPANY_OS_SKILL_KEY,
  TEAM_ROLES,
  teamRole,
  teamRoleChain,
  teamRoleForSetupItem,
  teamRoleHealth,
  teamSetupPath,
  teamSkillKey,
} from "../src/team.js";

describe("team roles", () => {
  it("lists every recommended PiB agent once, with its plugin's actions", () => {
    expect(TEAM_ROLES.map((r) => r.key)).toEqual(["operator", "reviewer", "account-manager", "sales-lead", "inbound-qualifier", "crm-data-steward", "deal-desk", "seo-specialist", "social", "bookkeeper", "payroll-clerk"]);
    expect(new Set(TEAM_ROLES.map((r) => `${r.pluginKey}:${r.setupItemKey}`)).size).toBe(TEAM_ROLES.length);
    for (const role of TEAM_ROLES) {
      expect(role.actions.options).toMatch(/\.hire-options$/);
      expect(role.actions.start).toMatch(/\.start-hire$/);
      if (role.cockpitRole) expect(role.actions.link).toBeUndefined();
      else expect(role.actions.link).toBe(`${role.actions.options.split(".")[0]}.link-agent`);
      expect(role.skills.length).toBeGreaterThan(1);
      expect(role.skills.at(-1)).toBe(COMPANY_OS_SKILL_KEY);
    }
    expect(teamRole("account-manager").pluginKey).toBe("partnersinbiz.crm");
    expect(teamRole("reviewer").required).toBe(false);
    expect(teamRole("payroll-clerk").required).toBe(false);
  });

  it("makes the sales roles optional CRM roles covered by the Account Manager", () => {
    for (const key of ["sales-lead", "inbound-qualifier", "crm-data-steward", "deal-desk"] as const) {
      const role = teamRole(key);
      expect(role.pluginKey).toBe("partnersinbiz.crm");
      expect(role.required).toBe(false);
      expect(role.coveredBy).toBe("account-manager");
      expect(role.actions.params).toEqual({ role: key });
      expect(role.skills[0]).toBe("plugin/partnersinbiz-crm/crm-records");
      expect(teamRoleChain(key)).toEqual([key, "account-manager"]);
    }
    expect(teamRole("account-manager").actions.params).toBeUndefined();
    expect(teamRoleChain("bookkeeper")).toEqual(["bookkeeper"]);
  });

  it("tells the Social agent to carry out social work, and keeps social media off the Account Manager", () => {
    // Live 2026-10-03: the Social agent declined social tasks as another role's job while the Account Manager's text claimed social media.
    const social = teamRole("social").summary;
    expect(social).toMatch(/^Does the social work itself/);
    expect(social).toContain("Carries out every social task");
    expect(social).toContain("never declines one");
    const manager = teamRole("account-manager").summary;
    expect(manager).toContain("Not social media: that is the Social agent's job.");
    expect(manager.replace("Not social media: that is the Social agent's job.", "")).not.toMatch(/social/i);
    // No other role claims social posts or the social inbox.
    for (const role of TEAM_ROLES.filter((r) => r.key !== "social")) expect(role.summary.replace("Not social media: that is the Social agent's job.", ""), role.key).not.toMatch(/social (post|inbox|media)|schedules and publishes posts/i);
  });

  it("builds canonical skill keys like the host", () => {
    expect(teamSkillKey("partnersinbiz.seo", "seo-sprint")).toBe("plugin/partnersinbiz-seo/seo-sprint");
  });

  it("finds the role behind a setup checklist item", () => {
    expect(teamRoleForSetupItem("partnersinbiz.cockpit", "operator_agent")?.key).toBe("operator");
    expect(teamRoleForSetupItem("partnersinbiz.seo", "agent")?.key).toBe("seo-specialist");
    expect(teamRoleForSetupItem("partnersinbiz.social", "agent")?.key).toBe("social");
    expect(teamRoleForSetupItem("partnersinbiz.payroll", "clerk")?.key).toBe("payroll-clerk");
    expect(teamRoleForSetupItem("partnersinbiz.seo", "settings")).toBeNull();
  });

  it("keeps roles for switched-on modules only", () => {
    expect(activeTeamRoles(null)).toHaveLength(TEAM_ROLES.length);
    expect(activeTeamRoles({ payroll: false, social: false }).map((r) => r.key)).toEqual(["operator", "reviewer", "account-manager", "sales-lead", "inbound-qualifier", "crm-data-steward", "deal-desk", "seo-specialist", "bookkeeper"]);
    expect(activeTeamRoles({ crm: false }).some((r) => r.pluginKey === "partnersinbiz.crm")).toBe(false);
  });

  it("rates a role: missing, hiring, attention or ok", () => {
    expect(teamRoleHealth({ agentStatus: null, hireOpen: false })).toBe("missing");
    expect(teamRoleHealth({ agentStatus: "terminated", hireOpen: true })).toBe("hiring");
    expect(teamRoleHealth({ agentStatus: "paused", hireOpen: false })).toBe("attention");
    expect(teamRoleHealth({ agentStatus: "idle", hireOpen: false, missingSkills: 1 })).toBe("attention");
    expect(teamRoleHealth({ agentStatus: "active", hireOpen: false })).toBe("ok");
  });

  it("links to Setup → Team", () => {
    expect(teamSetupPath()).toBe("/setup?section=team");
    expect(teamSetupPath("bookkeeper")).toBe("/setup?section=team#team-bookkeeper");
  });
});
