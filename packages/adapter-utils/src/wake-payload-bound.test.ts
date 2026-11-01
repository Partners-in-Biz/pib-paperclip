import { describe, expect, it } from "vitest";
import { stringifyPaperclipWakePayload, stringifyPaperclipWakePayloadForEnv } from "./server-utils.js";
import {
  WAKE_ENV_DEFAULT_MAX_BYTES,
  boundWakePayloadJson,
  wakeEnvMaxBytes,
} from "./wake-payload-bound.js";

const KERNEL_STRING_LIMIT = 131072;

function message(id: string, body: string, extra: Record<string, unknown> = {}) {
  return { id, authorType: "user", body, ...extra };
}

function bigPayload(opts: { count?: number; bodyChars?: number } = {}) {
  const count = opts.count ?? 60;
  const bodyChars = opts.bodyChars ?? 2500;
  const messages = Array.from({ length: count }, (_, i) =>
    message(`m${String(i).padStart(3, "0")}`, `message ${i} ` + "x".repeat(bodyChars), {
      authorType: i % 2 === 0 ? "user" : "agent",
      createdByRunId: i % 2 === 0 ? null : `run-${i}`,
    }),
  );
  return {
    reason: "issue_commented",
    issue: { id: "issue-1", identifier: "PAR-1", title: "Big task", status: "in_progress" },
    commentIds: ["m010"],
    latestCommentId: "m010",
    executionContinuation: {
      version: 1,
      companyId: "c1",
      issueId: "issue-1",
      objective: "Do the thing",
      originCommentIds: ["m010"],
      messages,
      unresolvedInteractionIds: [],
      coverage: { kind: "full_task_history", throughCommentId: null, summaryThroughCommentId: null },
    },
  };
}

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

describe("wakeEnvMaxBytes", () => {
  it("defaults to 120000 and clamps PIB_WAKE_PAYLOAD_MAX_BYTES to 8000..125000", () => {
    expect(wakeEnvMaxBytes({})).toBe(WAKE_ENV_DEFAULT_MAX_BYTES);
    expect(wakeEnvMaxBytes({ PIB_WAKE_PAYLOAD_MAX_BYTES: "50000" })).toBe(50000);
    expect(wakeEnvMaxBytes({ PIB_WAKE_PAYLOAD_MAX_BYTES: "10" })).toBe(8000);
    expect(wakeEnvMaxBytes({ PIB_WAKE_PAYLOAD_MAX_BYTES: "999999" })).toBe(125000);
    expect(wakeEnvMaxBytes({ PIB_WAKE_PAYLOAD_MAX_BYTES: "nope" })).toBe(WAKE_ENV_DEFAULT_MAX_BYTES);
  });
});

describe("boundWakePayloadJson", () => {
  it("returns a payload under the limit unchanged", () => {
    const json = JSON.stringify(bigPayload({ count: 3, bodyChars: 100 }));
    expect(boundWakePayloadJson(json)).toBe(json);
  });

  it("returns non-JSON and non-object input unchanged", () => {
    const junk = "x".repeat(130000);
    expect(boundWakePayloadJson(junk)).toBe(junk);
    const array = JSON.stringify(["x".repeat(130000)]);
    expect(boundWakePayloadJson(array)).toBe(array);
    expect(boundWakePayloadJson(null)).toBeNull();
  });

  it("bounds an oversized payload, drops the oldest history first and notes it", () => {
    const json = JSON.stringify(bigPayload());
    expect(bytes(json)).toBeGreaterThan(KERNEL_STRING_LIMIT);
    const out = boundWakePayloadJson(json)!;
    expect(bytes(out)).toBeLessThanOrEqual(WAKE_ENV_DEFAULT_MAX_BYTES);
    const parsed = JSON.parse(out);
    const ids: string[] = parsed.executionContinuation.messages.map((m: { id: string }) => m.id);
    expect(ids).toContain("m059");
    expect(ids).toContain("m010");
    expect(ids).not.toContain("m000");
    expect(ids).toEqual([...ids].sort());
    expect(parsed.fallbackFetchNeeded).toBe(true);
    expect(parsed.envTruncation).toMatchObject({
      truncatedForEnv: true,
      originalBytes: bytes(json),
      maxBytes: WAKE_ENV_DEFAULT_MAX_BYTES,
    });
    expect(parsed.envTruncation.droppedMessages).toBe(60 - ids.length);
    expect(parsed.envTruncation.droppedMessageBytes).toBeGreaterThan(0);
  });

  it("honours an explicit smaller limit and still keeps the messages the request points at", () => {
    const out = boundWakePayloadJson(JSON.stringify(bigPayload()), 20000)!;
    expect(bytes(out)).toBeLessThanOrEqual(20000);
    const ids = JSON.parse(out).executionContinuation.messages.map((m: { id: string }) => m.id);
    expect(ids).toContain("m010");
    expect(ids).toContain("m059");
  });

  it("clips a single huge message body when trimming history is not enough", () => {
    const payload = bigPayload({ count: 3, bodyChars: 50 });
    payload.executionContinuation.messages[2].body = "y".repeat(200000);
    const out = boundWakePayloadJson(JSON.stringify(payload))!;
    expect(bytes(out)).toBeLessThanOrEqual(WAKE_ENV_DEFAULT_MAX_BYTES);
    const parsed = JSON.parse(out);
    expect(parsed.envTruncation.clipped).toContain("message bodies");
    expect(parsed.executionContinuation.messages.at(-1).body).toContain("[truncated");
  });

  it("falls back to the task identity when nothing else fits", () => {
    const payload = bigPayload({ count: 2, bodyChars: 10 });
    (payload.executionContinuation as Record<string, unknown>).objective = "z".repeat(60000);
    payload.issue = { ...payload.issue, description: "d".repeat(60000) } as typeof payload.issue;
    const out = boundWakePayloadJson(JSON.stringify(payload), 8000)!;
    expect(bytes(out)).toBeLessThanOrEqual(8000);
    const parsed = JSON.parse(out);
    expect(parsed.issue.identifier).toBe("PAR-1");
    expect(parsed.fallbackFetchNeeded).toBe(true);
    expect(parsed.envTruncation.truncatedForEnv).toBe(true);
  });
});

describe("stringifyPaperclipWakePayloadForEnv", () => {
  const huge = {
    reason: "issue_assigned",
    issue: { id: "i1", identifier: "PAR-3", title: "Big", description: "w".repeat(180000) },
  };

  it("leaves a small payload without an envTruncation note", () => {
    const json = stringifyPaperclipWakePayloadForEnv({
      reason: "issue_assigned",
      issue: { id: "i1", identifier: "PAR-2", title: "Small" },
    });
    expect(JSON.parse(json!).envTruncation).toBeUndefined();
  });

  it("bounds the env copy but never the prompt copy", () => {
    const env = stringifyPaperclipWakePayloadForEnv(huge)!;
    expect(bytes(env)).toBeLessThanOrEqual(WAKE_ENV_DEFAULT_MAX_BYTES);
    expect(JSON.parse(env).envTruncation.truncatedForEnv).toBe(true);
    const prompt = stringifyPaperclipWakePayload(huge)!;
    expect(JSON.parse(prompt).envTruncation).toBeUndefined();
    expect(bytes(prompt)).toBeGreaterThan(KERNEL_STRING_LIMIT);
  });
});
