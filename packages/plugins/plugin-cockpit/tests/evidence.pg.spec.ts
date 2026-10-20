/**
 * Issue evidence recording: redacted screenshot attachment logging for audit trails.
 * Tests the evidence-record tool validating attachments, posting comments, and handling retries.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordEvidence } from "../src/evidence.js";
import { COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds, type Hybrid } from "./helpers/hybrid.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;
const AGENT = "aaaaaaaa-0000-4000-8000-0000000000a1";

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

  // Helper: create issue + attachment, call tool with claimed sha256, assert outcome
  const testCase = async (
    w: Hybrid,
    issueId: string | null,
    attId: string,
    attSha256: string, // actual attachment sha256
    claimedSha256: string, // claimed sha256 (may differ)
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
    }
    return result;
  };

  it("records evidence once and posts comment, then identical retry succeeds", async () => {
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

    // First call succeeds
    const r1 = await recordEvidence(w.env, COMPANY, issue.id, "att-1", "abc123", "step-1", "test", {
      runId: "run-123",
      agentId: AGENT,
    });
    expect((r1 as any).error).toBeUndefined();
    expect((r1 as any).data?.recorded).toBe(true);

    // Identical retry: success but recorded=false
    const r2 = await recordEvidence(w.env, COMPANY, issue.id, "att-1", "abc123", "step-1", "test", {
      runId: "run-123",
      agentId: AGENT,
    });
    expect((r2 as any).error).toBeUndefined();
    expect((r2 as any).data?.recorded).toBe(false);
    expect((r2 as any).data?.reason).toBe("identical retry");
  });

  it("SHA256 mismatch: refuses, no row created", async () => {
    const w = await make();
    const issue = await w.ctx.issues.create({
      companyId: COMPANY,
      title: "Test",
      description: "Test",
      status: "todo",
    } as never);
    const result = await testCase(w, issue.id, "att-sha", "abc123", "wrong-sha", {}, false);
    expect((result as any).error).toContain("SHA256");
    const countRow = (await w.client.query(`SELECT COUNT(*) as count FROM plugin_cockpit_b8a99e8b16.issue_evidence WHERE attachment_id = 'att-sha'`)).rows[0] as any;
    expect(parseInt(countRow.count as string, 10)).toBe(0);
  });

  it("attachment from another issue: refuses with company/issue mismatch", async () => {
    const w = await make();
    const issue1 = await w.ctx.issues.create({
      companyId: COMPANY,
      title: "Test 1",
      description: "Test",
      status: "todo",
    } as never);
    const issue2 = await w.ctx.issues.create({
      companyId: COMPANY,
      title: "Test 2",
      description: "Test",
      status: "todo",
    } as never);

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
  });

  it("non-image: refuses", async () => {
    const w = await make();
    const issue = await w.ctx.issues.create({
      companyId: COMPANY,
      title: "Test",
      description: "Test",
      status: "todo",
    } as never);
    const result = await testCase(w, issue.id, "att-pdf", "pdf-sha", "pdf-sha", { contentType: "application/pdf" }, false);
    expect((result as any).error).toContain("not an image");
  });

  it("other agent's attachment: refuses", async () => {
    const w = await make();
    const issue = await w.ctx.issues.create({
      companyId: COMPANY,
      title: "Test",
      description: "Test",
      status: "todo",
    } as never);
    const result = await testCase(w, issue.id, "att-other", "sha", "sha", { createdByAgentId: "other-agent" }, false);
    expect((result as any).error).toContain("from the calling agent");
  });

  it("other company's issue: refuses", async () => {
    const w = await make();
    const result = await recordEvidence(w.env, COMPANY, "issue-other-company", "att", "sha", "step", "test", {
      runId: "run-123",
      agentId: AGENT,
    });
    expect((result as any).error).toContain("not found or is in another company");
  });

  it("comment failure: rolls back row, retry succeeds", async () => {
    const w = await make();
    const issue = await w.ctx.issues.create({
      companyId: COMPANY,
      title: "Test",
      description: "Test",
      status: "todo",
    } as never);

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

    // Second: comment succeeds
    w.ctx.issues.createComment = originalCreateComment;
    (w.ctx.issues as { listAttachments: unknown }).listAttachments = async () => [att];
    const r2 = await recordEvidence(w.env, COMPANY, issue.id, "att-comment-fail", "fail-sha", "step", "test", {
      runId: "run-123",
      agentId: AGENT,
    });
    expect((r2 as any).error).toBeUndefined();
    expect((r2 as any).data?.recorded).toBe(true);
  });

  it("missing params and normalized inputs", async () => {
    const w = await make();
    const issue = await w.ctx.issues.create({
      companyId: COMPANY,
      title: "Test",
      description: "Test",
      status: "todo",
    } as never);

    // Missing params
    const r1 = await recordEvidence(w.env, COMPANY, null, "att", "sha", "step", "test", {
      runId: "run-123",
      agentId: AGENT,
    });
    expect((r1 as any).error).toContain("issueId");

    // Normalized: trimmed, case-insensitive SHA, collapsed spaces
    const att = {
      id: "att-norm",
      issueId: issue.id,
      companyId: COMPANY,
      filename: "screenshot.png",
      contentType: "image/png",
      sha256: "ABC123DEF456",
      createdByAgentId: AGENT,
    };
    (w.ctx.issues as { listAttachments: unknown }).listAttachments = async () => [att];
    const r2 = await recordEvidence(
      w.env,
      COMPANY,
      `  ${issue.id}  `,
      `  att-norm  `,
      `  abc123def456  `,
      `  step  `,
      `  Multiple   spaces  `,
      { runId: "run-123", agentId: AGENT },
    );
    expect((r2 as any).error).toBeUndefined();
    expect((r2 as any).data?.recorded).toBe(true);
  });

  it("version is 0.9.0 for stop-first release with new migration", async () => {
    const w = await make();
    // manifest capabilities and version are checked in worker.spec.ts
    const version = require("../package.json").version;
    expect(version).toBe("0.9.0");
  });
});
