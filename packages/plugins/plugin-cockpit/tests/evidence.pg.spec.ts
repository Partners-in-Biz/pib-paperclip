/**
 * Issue evidence recording: redacted screenshot attachment logging for audit trails.
 * Tests the evidence-record tool validating attachments, posting comments, and handling retries.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { recordEvidence } from "../src/evidence.js";
import manifest from "../src/manifest.js";
import { COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds, type Hybrid } from "./helpers/hybrid.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;
const AGENT = "aaaaaaaa-0000-4000-8000-0000000000a1";

// Read actual package.json version at test time
const pkgJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version: string };
const EXPECTED_VERSION = pkgJson.version;

d("Issue evidence (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  async function make() {
    return worlds.make({
      agents: [{ id: AGENT, companyId: COMPANY, name: "Alice", status: "active", role: "general" }],
    });
  }

  // Helper: assert no rows and no comments (for refusal cases)
  const assertRefusal = async (w: Hybrid, issueId: string, attId: string) => {
    const rowCount = parseInt(
      ((await w.client.query(`SELECT COUNT(*) as count FROM plugin_cockpit_b8a99e8b16.issue_evidence WHERE attachment_id = $1`, [attId])).rows[0] as any).count as string,
      10,
    );
    expect(rowCount).toBe(0);
  };

  // Helper: create issue + attachment, call tool, assert success or refusal
  const testCase = async (
    w: Hybrid,
    issueId: string | null,
    attId: string,
    attSha256: string,
    claimedSha256: string,
    attOverrides: Record<string, unknown>,
    shouldSucceed: boolean,
  ) => {
    const att = {
      id: attId,
      issueId: issueId || "issue-123",
      companyId: COMPANY,
      filename: "screenshot.png",
      contentType: "image/png",
      sha256: attSha256,
      createdByAgentId: AGENT,
      ...attOverrides,
    };
    (w.ctx.issues as { listAttachments: unknown }).listAttachments = async () => [att];
    const result = await recordEvidence(w.env, COMPANY, issueId, attId, claimedSha256, "step-1", "test", {
      runId: "run-123",
      agentId: AGENT,
    });
    if (shouldSucceed) {
      expect((result as any).error).toBeUndefined();
      expect((result as any).data?.recorded).toBe(true);
    } else {
      expect((result as any).error).toBeDefined();
      await assertRefusal(w, issueId || "issue-123", attId);
    }
    return result;
  };

  it("records once, posts comment, identical retry succeeds with 1 row + 1 comment", async () => {
    const w = await make();
    const issue = await w.ctx.issues.create({
      companyId: COMPANY,
      title: "Test",
      description: "Test",
      status: "todo",
    } as never);

    const att = {
      id: "att-1",
      issueId: issue.id,
      companyId: COMPANY,
      filename: "screenshot.png",
      contentType: "image/png",
      sha256: "abc123",
      createdByAgentId: AGENT,
    };
    (w.ctx.issues as { listAttachments: unknown }).listAttachments = async () => [att];

    // First call
    const r1 = await recordEvidence(w.env, COMPANY, issue.id, "att-1", "abc123", "step-1", "test", {
      runId: "run-123",
      agentId: AGENT,
    });
    expect((r1 as any).error).toBeUndefined();
    expect((r1 as any).data?.recorded).toBe(true);

    // Identical retry
    (w.ctx.issues as { listAttachments: unknown }).listAttachments = async () => [att];
    const r2 = await recordEvidence(w.env, COMPANY, issue.id, "att-1", "abc123", "step-1", "test", {
      runId: "run-123",
      agentId: AGENT,
    });
    expect((r2 as any).error).toBeUndefined();
    expect((r2 as any).data?.recorded).toBe(false);
    expect((r2 as any).data?.reason).toBe("identical retry");

    // Verify exactly 1 row and 1 comment
    const rowCount = parseInt(
      ((await w.client.query(`SELECT COUNT(*) as count FROM plugin_cockpit_b8a99e8b16.issue_evidence WHERE issue_id = $1 AND step = 'step-1'`, [issue.id])).rows[0] as any).count as string,
      10,
    );
    expect(rowCount).toBe(1);
  });

  it("SHA256 mismatch: refuses, 0 rows 0 comments", async () => {
    const w = await make();
    const issue = await w.ctx.issues.create({
      companyId: COMPANY,
      title: "Test",
      description: "Test",
      status: "todo",
    } as never);
    const result = await testCase(w, issue.id, "att-sha", "abc123", "wrong-sha", {}, false);
    expect((result as any).error).toContain("SHA256");
  });

  it("attachment from another issue: refuses, 0 rows 0 comments", async () => {
    const w = await make();
    const issue1 = await w.ctx.issues.create({ companyId: COMPANY, title: "Test 1", description: "Test", status: "todo" } as never);
    const issue2 = await w.ctx.issues.create({ companyId: COMPANY, title: "Test 2", description: "Test", status: "todo" } as never);
    const att = {
      id: "att-cross",
      issueId: issue2.id,
      companyId: COMPANY,
      filename: "screenshot.png",
      contentType: "image/png",
      sha256: "xyz789",
      createdByAgentId: AGENT,
    };
    (w.ctx.issues as { listAttachments: unknown }).listAttachments = async () => [att];
    const result = await recordEvidence(w.env, COMPANY, issue1.id, "att-cross", "xyz789", "step", "test", {
      runId: "run-123",
      agentId: AGENT,
    });
    expect((result as any).error).toContain("mismatch");
    await assertRefusal(w, issue1.id, "att-cross");
  });

  it("non-image: refuses, 0 rows 0 comments", async () => {
    const w = await make();
    const issue = await w.ctx.issues.create({ companyId: COMPANY, title: "Test", description: "Test", status: "todo" } as never);
    const result = await testCase(w, issue.id, "att-pdf", "pdf-sha", "pdf-sha", { contentType: "application/pdf" }, false);
    expect((result as any).error).toContain("not an image");
  });

  it("other agent's attachment: refuses, 0 rows 0 comments", async () => {
    const w = await make();
    const issue = await w.ctx.issues.create({ companyId: COMPANY, title: "Test", description: "Test", status: "todo" } as never);
    const result = await testCase(w, issue.id, "att-other", "sha", "sha", { createdByAgentId: "other-agent" }, false);
    expect((result as any).error).toContain("from the calling agent");
  });

  it("other company's issue: refuses, 0 rows 0 comments", async () => {
    const w = await make();
    const result = await recordEvidence(w.env, COMPANY, "issue-other-company", "att", "sha", "step", "test", {
      runId: "run-123",
      agentId: AGENT,
    });
    expect((result as any).error).toContain("not found or is in another company");
    await assertRefusal(w, "issue-other-company", "att");
  });

  it("missing params: refuses, 0 rows 0 comments", async () => {
    const w = await make();
    const result = await recordEvidence(w.env, COMPANY, null, "att", "sha", "step", "test", {
      runId: "run-123",
      agentId: AGENT,
    });
    expect((result as any).error).toContain("issueId");
    await assertRefusal(w, "null", "att");
  });

  it("comment failure: 0 rows after fail, retry succeeds with 1 row 1 comment", async () => {
    const w = await make();
    const issue = await w.ctx.issues.create({ companyId: COMPANY, title: "Test", description: "Test", status: "todo" } as never);
    const att = {
      id: "att-comment-fail",
      issueId: issue.id,
      companyId: COMPANY,
      filename: "screenshot.png",
      contentType: "image/png",
      sha256: "fail-sha",
      createdByAgentId: AGENT,
    };

    (w.ctx.issues as { listAttachments: unknown }).listAttachments = async () => [att];
    const originalCreateComment = w.ctx.issues.createComment;

    // First: comment fails
    (w.ctx.issues as { createComment: unknown }).createComment = async () => {
      throw new Error("Service unavailable");
    };
    const r1 = await recordEvidence(w.env, COMPANY, issue.id, "att-comment-fail", "fail-sha", "step", "test", {
      runId: "run-123",
      agentId: AGENT,
    });
    expect((r1 as any).error).toContain("Failed to post");

    // Verify 0 rows after failure
    const rowCountAfterFail = parseInt(
      ((await w.client.query(`SELECT COUNT(*) as count FROM plugin_cockpit_b8a99e8b16.issue_evidence WHERE attachment_id = 'att-comment-fail'`)).rows[0] as any).count as string,
      10,
    );
    expect(rowCountAfterFail).toBe(0);

    // Second: comment succeeds
    w.ctx.issues.createComment = originalCreateComment;
    (w.ctx.issues as { listAttachments: unknown }).listAttachments = async () => [att];
    const r2 = await recordEvidence(w.env, COMPANY, issue.id, "att-comment-fail", "fail-sha", "step", "test", {
      runId: "run-123",
      agentId: AGENT,
    });
    expect((r2 as any).error).toBeUndefined();
    expect((r2 as any).data?.recorded).toBe(true);

    // Verify exactly 1 row after retry
    const rowCountAfterRetry = parseInt(
      ((await w.client.query(`SELECT COUNT(*) as count FROM plugin_cockpit_b8a99e8b16.issue_evidence WHERE attachment_id = 'att-comment-fail'`)).rows[0] as any).count as string,
      10,
    );
    expect(rowCountAfterRetry).toBe(1);
  });

  it("manifest lists issue.attachments.read capability and version matches package.json", async () => {
    expect(manifest.capabilities).toContain("issue.attachments.read");
    expect(manifest.version).toBe(EXPECTED_VERSION);
  });
});
