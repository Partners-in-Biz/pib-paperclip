/**
 * PAR-4159 (C30): Media rule loading and post tags.
 * Tests for: get-playbook returns mediaRule, default vs stored, scope isolation, post tags.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { getPlaybookRecord } from "../src/growth/service.js";
import { growthEnv } from "../src/growth/host.js";
import { createPostRecord, updatePostRecord, getPostDetail } from "../src/service.js";
import { approvalWorld, SOCIAL_AGENT, postRow } from "./world.js";

describe("playbook media rule and post tags (PAR-4159)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("get-playbook returns default media rule when no playbook block", async () => {
    const w = approvalWorld({ playbookText: "# Playbook\n\nNo media rule here." });
    const env = growthEnv(w.ctx);
    const result = await getPlaybookRecord(env, SOCIAL_AGENT, { client: "own" });
    expect(result.mediaRule).toBeDefined();
    expect(result.mediaRuleSource).toBe("default");
    expect(result.playbook).toContain("No media rule here");
  });

  it("get-playbook returns stored media rule when block present", async () => {
    const w = approvalWorld({
      playbookText: `# Playbook\n\n\`\`\`media-rule\nenforce: block\nalt_text: required\n\`\`\`\n\nRest of playbook.`,
    });
    const env = growthEnv(w.ctx);
    const result = await getPlaybookRecord(env, SOCIAL_AGENT, { client: "own" });
    expect(result.mediaRuleSource).toBe("stored");
    expect(result.mediaRule.enforce).toBe("block");
  });

  it("TWO-SCOPE ISOLATION: scope A stored block, scope B default advise", async () => {
    // Scope A (own work) with block
    const w1 = approvalWorld({
      playbookText: `# Playbook A\n\n\`\`\`media-rule\nenforce: block\n\`\`\`\n`,
    });
    const env = growthEnv(w1.ctx);
    const result1 = await getPlaybookRecord(env, SOCIAL_AGENT, { client: "own" });
    expect(result1.mediaRuleSource).toBe("stored");
    expect(result1.mediaRule.enforce).toBe("block");

    // Scope B (client) with default
    const w2 = approvalWorld({
      client: { kind: "company", id: "c2", name: "Client B" },
      playbookText: "# Playbook B\n\nNo media rule block here.",
    });
    const result2 = await getPlaybookRecord(env, SOCIAL_AGENT, { client: "company:c2" });
    expect(result2.mediaRuleSource).toBe("default");
  });

  it("create-post accepts tags parameter", async () => {
    const w = approvalWorld();
    const { createPostRecord } = await import("../src/service.js");
    const result = await createPostRecord(w.ctx, SOCIAL_AGENT, {
      body: "Test post",
      accountIds: ["a1"],
      tags: ["text-native", "experiment"],
    });
    expect(result.tags).toContain("text-native");
    expect(result.tags).toContain("experiment");
  });

  it("update-post merges tags with overrides", async () => {
    const w = approvalWorld();
    w.post.overrides = { some_field: "value" };
    w.post.id = "p1";
    const { updatePostRecord } = await import("../src/service.js");
    const result = await updatePostRecord(w.ctx, SOCIAL_AGENT, {
      postId: "p1",
      tags: ["text-native"],
      overrides: { some_field: "new_value" },
    });
    expect(result.overrides).toHaveProperty("tags");
  });

  it("post tags are preserved in get-post", async () => {
    const w = approvalWorld();
    const { createPostRecord, getPostDetail } = await import("../src/service.js");
    const created = await createPostRecord(w.ctx, SOCIAL_AGENT, {
      body: "Tagged post",
      accountIds: ["a1"],
      tags: ["experiment-variant"],
    });
    const detail = await getPostDetail(w.ctx, SOCIAL_AGENT, created.id);
    expect(detail.tags).toContain("experiment-variant");
  });
});
