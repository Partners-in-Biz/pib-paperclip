import { describe, expect, it } from "vitest";
import type { ApprovalIssuePort, FeaturesPort, GrowthStore as KitGrowthStore, ScopeResolver } from "@partnersinbiz/pib-plugin-kit";
import { proposeExperiment, type GrowthActor, type GrowthEnv } from "../src/growth/service.js";
import type { CoreGrowthStore, SocialFeaturesPort } from "../src/growth/store.js";
import { sqlGrowthStore } from "../src/growth/sql.js";
import { fakeCtx } from "./helpers.js";
import { memoryStore } from "./memory-store.js";

const AGENT: GrowthActor = { companyId: "co", userId: null, agentId: "agent-1", isAgent: true };

describe("growth ports", () => {
  it("a host fills the kit ports with its own row types", () => {
    const { store } = memoryStore();
    // Compile-time: the same object satisfies the kit's generic ports and Social's named aliases.
    const core: CoreGrowthStore = store;
    const features: SocialFeaturesPort = store;
    const kitStore: KitGrowthStore = core as KitGrowthStore;
    const kitFeatures: FeaturesPort = features;
    for (const method of ["findProgram", "insertExperiment", "updateChange", "listItems"] as const) expect(typeof kitStore[method]).toBe("function");
    for (const method of ["setPostExperiment", "experimentPosts", "metricRows", "upsertScore", "postFeatures"] as const) expect(typeof kitFeatures[method]).toBe("function");
  });

  it("the SQL store is the core store plus the features port", () => {
    const store = sqlGrowthStore(fakeCtx());
    for (const method of ["findProgram", "savePlaybook", "setPostExperiment", "experimentPosts", "metricRows", "existingScores", "upsertScore"] as const) {
      expect(typeof store[method]).toBe("function");
    }
  });

  it("the service uses the approval-issue and scope ports it is given", async () => {
    const { store } = memoryStore();
    const calls: string[] = [];
    const issues: ApprovalIssuePort<Parameters<GrowthEnvIssues["createApproval"]>[0]> = {
      async createApproval(input) {
        calls.push(`create:${input.title}`);
        return { id: "fake-1" };
      },
      async isOpen() {
        return true;
      },
      async setStatus(_c, id, status) {
        calls.push(`status:${id}:${status}`);
      },
      async comment(_c, id, body) {
        calls.push(`comment:${id}:${body.split("\n")[0]}`);
      },
    };
    const scopes: ScopeResolver<Record<string, unknown>, { scope: null; client: null }> = {
      async fromParams() {
        calls.push("scope");
        return { scope: null, client: null };
      },
      toParam: () => "own",
    };
    const ctx = fakeCtx({
      companies: { get: async () => ({ id: "co", issuePrefix: "PIB", defaultResponsibleUserId: "p1" }) },
      projects: { managed: { get: async () => ({ projectId: "proj" }) } },
    });
    const env: GrowthEnv = { ctx, store, now: () => new Date(), issues, scopes };
    const arms = [{ key: "control", description: "Statement hook" }, { key: "variant", description: "Question hook" }];
    const first = await proposeExperiment(env, AGENT, { hypothesis: "Question hooks win", hypothesisType: "hook:question", variable: "opening", arms });
    expect(first.approvalIssueId).toBe("fake-1");
    await proposeExperiment(env, AGENT, { hypothesis: "Video beats image", hypothesisType: "format:video", variable: "format", arms });
    expect(calls[0]).toBe("scope");
    expect(calls.filter((c) => c.startsWith("create:"))).toHaveLength(1);
    expect(calls.some((c) => c.startsWith("comment:fake-1"))).toBe(true);
  });
});

type GrowthEnvIssues = NonNullable<GrowthEnv["issues"]>;
