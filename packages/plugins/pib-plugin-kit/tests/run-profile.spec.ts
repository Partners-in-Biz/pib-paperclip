import { describe, expect, it } from "vitest";
import {
  CLAUDE_HAIKU_MODEL,
  CLAUDE_SONNET_MODEL,
  DEFAULT_RUN_PROFILE,
  RUN_PROFILES,
  TEAM_ROLES,
  agentRunProfileProblems,
  hireTaskDraft,
  runProfileConfig,
  runProfileForRole,
  runProfileRows,
  unpinnedRunProfileCheck,
  type HireRole,
} from "../src/index.js";

const hireRole = (patch: Partial<HireRole> = {}): HireRole => ({
  pluginKey: "partnersinbiz.seo",
  pluginName: "SEO",
  roleKey: "seo-specialist",
  displayName: "SEO Specialist",
  title: "SEO Specialist",
  role: "general",
  capabilities: "Runs sprints.",
  adapterPreference: ["hermes_local", "claude_local"],
  skills: [{ key: "plugin/partnersinbiz-seo/seo-sprint", slug: "pib-seo-sprint", purpose: "The sprint" }],
  budgetMonthlyCents: 0,
  instructions: "Do it.",
  pluginSetup: [],
  toolPlugins: [],
  ...patch,
});

describe("run profiles per role", () => {
  it("gives every team role a profile, and the registry and the roles agree", () => {
    expect(Object.keys(RUN_PROFILES).sort()).toEqual(TEAM_ROLES.map((r) => r.key).sort());
    for (const role of TEAM_ROLES) expect(role.runProfile).toBe(RUN_PROFILES[role.key]);
  });

  it("never allows an unlimited run, an unpinned model or an absurd concurrency", () => {
    for (const [key, profile] of Object.entries(RUN_PROFILES)) {
      expect(profile.timeoutSec, key).toBeGreaterThan(0);
      expect(profile.timeoutSec, key).toBeLessThanOrEqual(3600);
      expect(profile.model, key).toMatch(/^claude-/);
      expect(profile.maxTurnsPerRun, key).toBeLessThan(1000);
      expect(profile.maxConcurrentRuns, key).toBeGreaterThanOrEqual(2);
      expect(profile.maxConcurrentRuns, key).toBeLessThanOrEqual(6);
    }
  });

  it("keeps the quality gate and money roles on Sonnet, and cheap families only for high-volume work", () => {
    for (const key of ["reviewer", "operator", "bookkeeper", "payroll-clerk", "deal-desk", "account-manager", "social"] as const) {
      expect(RUN_PROFILES[key].model, key).toBe(CLAUDE_SONNET_MODEL);
      expect(RUN_PROFILES[key].hermes, key).toBeUndefined();
    }
    for (const key of ["sales-lead", "inbound-qualifier", "crm-data-steward", "seo-specialist"] as const) {
      expect(RUN_PROFILES[key].hermes?.model, key).toBe("deepseek/deepseek-v4-flash-0731");
    }
    expect(RUN_PROFILES["inbound-qualifier"].model).toBe(CLAUDE_HAIKU_MODEL);
    expect(RUN_PROFILES["crm-data-steward"].model).toBe(CLAUDE_HAIKU_MODEL);
    expect(RUN_PROFILES["seo-specialist"].maxConcurrentRuns).toBe(6);
  });

  it("falls back to the default for a role the registry does not know", () => {
    expect(runProfileForRole("seo-specialist")).toBe(RUN_PROFILES["seo-specialist"]);
    expect(runProfileForRole("something-new")).toBe(DEFAULT_RUN_PROFILE);
    // Social's hire role key is not its team role key: it must still get the Social profile, not the fallback that merely equals it today
    expect(runProfileForRole("social-media-manager")).toBe(RUN_PROFILES.social);
    expect(runProfileForRole(null)).toBe(DEFAULT_RUN_PROFILE);
  });

  it("builds the settings the host stores", () => {
    expect(runProfileConfig(RUN_PROFILES.reviewer)).toEqual({
      adapterConfig: { model: CLAUDE_SONNET_MODEL, effort: "medium", timeoutSec: 3600, maxTurnsPerRun: 200 },
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 4 } },
    });
    const hermes = runProfileConfig(RUN_PROFILES["seo-specialist"], "hermes_local");
    expect(hermes.adapterConfig).toMatchObject({ provider: "nous", model: "deepseek/deepseek-v4-flash-0731", timeoutSec: 3600 });
    // A role with no Hermes pair keeps its Claude model even on hermes_local.
    expect(runProfileConfig(RUN_PROFILES.reviewer, "hermes_local").adapterConfig).toMatchObject({ model: CLAUDE_SONNET_MODEL });
  });
});

describe("the hire task carries the run profile", () => {
  it("prints model, effort, timeout, turns and concurrency as rows, plus the JSON to set and why a plugin cannot", () => {
    const text = hireTaskDraft(hireRole()).description;
    expect(text).toContain("| **Model** | `claude-sonnet-5-5` on `claude_local`; on `hermes_local`: `deepseek/deepseek-v4-flash-0731`");
    expect(text).toContain("| **Effort** | medium |");
    expect(text).toContain("| **Run timeout** | 3600 s (never 0: 0 means unlimited) |");
    expect(text).toContain("| **Max turns per run** | 200 |");
    expect(text).toContain("| **Concurrent runs** | 6 |");
    expect(text).toContain('"timeoutSec": 3600');
    expect(text).toContain("The plugin cannot change an agent's settings after the hire");
    // The table stays one table: the profile rows sit between Budget and Start.
    expect(text.indexOf("**Budget**")).toBeLessThan(text.indexOf("**Model**"));
    expect(text.indexOf("**Concurrent runs**")).toBeLessThan(text.indexOf("**Start**"));
  });

  it("takes the plugin's own profile when it sets one, and the default for an unknown role", () => {
    const custom = hireTaskDraft(hireRole({ runProfile: { ...DEFAULT_RUN_PROFILE, timeoutSec: 900, maxConcurrentRuns: 2 } })).description;
    expect(custom).toContain("900 s");
    expect(hireTaskDraft(hireRole({ roleKey: "brand-new" })).description).toContain("| **Concurrent runs** | 3 |");
  });

  it("tells the hirer to pick claude_local for a role with no Hermes model", () => {
    const rows = runProfileRows(RUN_PROFILES.reviewer, ["hermes_local", "claude_local"]);
    expect(rows.join("\n")).toContain("Choose `claude_local` for this role");
    expect(runProfileRows(RUN_PROFILES["seo-specialist"], ["hermes_local"]).join("\n")).not.toContain("Choose `claude_local`");
  });
});

describe("unpinnedRunProfileCheck", () => {
  const agent = (patch: Record<string, unknown>) => ({ id: String(patch.name), name: "A", status: "idle", adapterType: "claude_local", adapterConfig: { model: "claude-sonnet-5-5", timeoutSec: 3600 }, ...patch });

  it("flags claude_local agents with no model or no timeout (0 is unlimited), as live on 2026-10-03", () => {
    const check = unpinnedRunProfileCheck([
      agent({ name: "Reviewer", adapterConfig: { timeoutSec: 3600 } }),
      agent({ name: "PiB", adapterConfig: { model: "claude-sonnet-5-5", timeoutSec: 0, maxTurnsPerRun: 1000 } }),
      agent({ name: "Steve", adapterConfig: {} }),
      agent({ name: "Developer" }),
    ]);
    expect(check).toMatchObject({ key: "agents:run-profile", status: "warn" });
    expect(check!.detail).toContain("Reviewer: no model pinned");
    expect(check!.detail).toContain("PiB: no run timeout");
    expect(check!.detail).toContain("turn cap 1000 is no cap");
    expect(check!.detail).toContain("Steve: no model pinned (runs on the host default, Opus), no run timeout");
    expect(check!.detail).not.toContain("Developer");
    expect(check!.fix).toContain("full adapterConfig");
  });

  it("ignores pinned, other-adapter and ended agents, and is null when all is pinned", () => {
    expect(unpinnedRunProfileCheck([agent({ name: "ok" }), agent({ name: "hermes", adapterType: "hermes_local", adapterConfig: {} }), agent({ name: "gone", status: "terminated", adapterConfig: {} })])).toBeNull();
    expect(agentRunProfileProblems(agent({ adapterConfig: { model: " ", timeoutSec: "3600" } }))).toEqual(["no model pinned (runs on the host default, Opus)"]);
  });
});
