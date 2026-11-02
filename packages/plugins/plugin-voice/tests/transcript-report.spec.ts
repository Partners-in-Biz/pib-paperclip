import { describe, expect, it, vi } from "vitest";
import { failureMessage } from "../src/ui/save-notice.js";
import { newUuid } from "../src/ui/uuid.js";
import { buildRecap, buildTranscriptDocument, documentKey, hasSpeech, saveLiveTranscript, type CallRecord, type ReportApi } from "../src/ui/transcript-report.js";

const START = new Date(2026, 9, 27, 10, 0, 0).getTime();
const CALL: CallRecord = {
  startedAt: START,
  endedAt: START + 125_000,
  entries: [
    { who: "voice", text: "Hi, what do you need?", at: START + 1000 },
    { who: "you", text: "Ask the SEO agent about rankings", at: START + 8000 },
    { who: "note", text: "Posted to PAR-12.", at: START + 30_000 },
    { who: "voice", text: "Done, I posted it.", at: START + 32_000 },
  ],
};

function fakeApi(failPutFor?: string, existingRevision?: string, getError?: string) {
  const put = vi.fn(async (path: string, _body?: unknown) => {
    if (failPutFor && path.includes(failPutFor)) throw new Error("Paperclip answered 500");
    return {};
  });
  const post = vi.fn(async (_path: string, _body?: unknown) => ({}));
  const get = vi.fn(async () => {
    if (existingRevision) return { latestRevisionId: existingRevision };
    throw new Error(getError ?? "Paperclip answered 404 for /issues/i1/documents/k");
  });
  return { api: { get, post, put } as unknown as ReportApi, put, post };
}

describe("transcript report", () => {
  it("builds a speaker-labelled, timestamped document with both sides", () => {
    const doc = buildTranscriptDocument(CALL);
    expect(doc).toContain("**Voice** (10:00:01): Hi, what do you need?");
    expect(doc).toContain("**You** (10:00:08): Ask the SEO agent about rankings");
    expect(doc).toContain("_10:00:30 Posted to PAR-12._");
    expect(doc).toContain("2 min 5 s");
  });

  it("recaps topics and actions and names the document", () => {
    const recap = buildRecap(CALL, documentKey(START));
    expect(recap).toContain("1 turns from you and 2 from the voice");
    expect(recap).toContain("- Ask the SEO agent about rankings");
    expect(recap).toContain("- Posted to PAR-12.");
    expect(recap).toContain("live-chat-transcript-20261027-100000");
  });

  it("says so when nothing was done", () => {
    const recap = buildRecap({ ...CALL, entries: CALL.entries.filter((e) => e.who !== "note") }, "k");
    expect(recap).toContain("No messages posted and no tasks created.");
  });

  it("skips an empty call", async () => {
    const { api, put, post } = fakeApi();
    const call = { ...CALL, entries: [{ who: "note" as const, text: "Hung up after four quiet minutes.", at: START }] };
    expect(hasSpeech(call.entries)).toBe(false);
    const result = await saveLiveTranscript(api, call, [{ issueId: "i1", ref: "PAR-1" }]);
    expect(result.saved).toEqual([]);
    expect(put).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("writes the document before the recap, once per task, even if a task is listed twice", async () => {
    const { api, put, post } = fakeApi();
    const result = await saveLiveTranscript(api, CALL, [
      { issueId: "i1", ref: "PAR-1" },
      { issueId: "i1", ref: "PAR-1" },
      { issueId: "i2", ref: "PAR-2" },
    ]);
    expect(result.saved).toEqual(["PAR-1", "PAR-2"]);
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[0]![0]).toBe("/issues/i1/documents/live-chat-transcript-20261027-100000");
    expect(post).toHaveBeenCalledTimes(2);
    expect(put.mock.invocationCallOrder[0]!).toBeLessThan(post.mock.invocationCallOrder[0]!);
  });

  it("posts no recap on a task whose document write failed, and carries on with the rest", async () => {
    const { api, post } = fakeApi("/issues/i1/");
    const result = await saveLiveTranscript(api, CALL, [
      { issueId: "i1", ref: "PAR-1" },
      { issueId: "i2", ref: "PAR-2" },
    ]);
    expect(result.failed).toEqual([{ ref: "PAR-1", error: "Paperclip answered 500" }]);
    expect(result.saved).toEqual(["PAR-2"]);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("updates an existing document with its latest revision id, so a retry does not 409", async () => {
    const { api, put, post } = fakeApi(undefined, "11111111-1111-4111-8111-111111111111");
    const result = await saveLiveTranscript(api, CALL, [{ issueId: "i1", ref: "PAR-1" }]);
    expect(result.saved).toEqual(["PAR-1"]);
    expect(put.mock.calls[0]![1]).toMatchObject({ baseRevisionId: "11111111-1111-4111-8111-111111111111" });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("sends no base revision on a first save", async () => {
    const { api, put } = fakeApi();
    await saveLiveTranscript(api, CALL, [{ issueId: "i1", ref: "PAR-1" }]);
    expect(put.mock.calls[0]![1]).not.toHaveProperty("baseRevisionId");
  });

  it("counts tasks past the limit instead of dropping them silently", async () => {
    const { api } = fakeApi();
    const targets = Array.from({ length: 7 }, (_, i) => ({ issueId: `i${i}`, ref: `PAR-${i}` }));
    const result = await saveLiveTranscript(api, CALL, targets);
    expect(result.saved).toHaveLength(5);
    expect(result.skipped).toBe(2);
    expect(failureMessage(result)).toContain("2 more tasks");
  });

  it("names the failed tasks in the notice text", () => {
    expect(failureMessage({ saved: [], skipped: 0, failed: [{ ref: "PAR-1", error: "Paperclip answered 500" }] })).toContain("PAR-1");
  });

  it("makes a valid UUID even without crypto.randomUUID", () => {
    const original = crypto.randomUUID;
    // @ts-expect-error simulate an insecure context
    crypto.randomUUID = undefined;
    try {
      expect(newUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      crypto.randomUUID = original;
    }
  });

  it("does not treat a non-404 failure on the lookup as a first save", async () => {
    const { api, put, post } = fakeApi(undefined, undefined, "Paperclip answered 500 for /issues/i1/documents/k");
    const result = await saveLiveTranscript(api, CALL, [{ issueId: "i1", ref: "PAR-1" }]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.error).toContain("500");
    expect(put).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("reuses the recap request id when a retry follows a failed comment post", async () => {
    const { api, post } = fakeApi();
    post.mockRejectedValueOnce(new Error("Paperclip answered 502"));
    const call = { ...CALL };
    const first = await saveLiveTranscript(api, call, [{ issueId: "i1", ref: "PAR-1" }]);
    expect(first.failed).toHaveLength(1);
    const second = await saveLiveTranscript(api, call, [{ issueId: "i1", ref: "PAR-1" }]);
    expect(second.saved).toEqual(["PAR-1"]);
    const ids = post.mock.calls.map((c) => (c[1] as { clientRequestId: string }).clientRequestId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it("writes only the document, with the same key, when the comment is off (autosave)", async () => {
    const { api, put, post } = fakeApi(undefined, "11111111-1111-4111-8111-111111111111");
    const result = await saveLiveTranscript(api, CALL, [{ issueId: "i1", ref: "PAR-1" }], { comment: false, changeSummary: "Autosaved" });
    expect(result.saved).toEqual(["PAR-1"]);
    expect(put.mock.calls[0]![0]).toBe(`/issues/i1/documents/${documentKey(START)}`);
    expect(put.mock.calls[0]![1]).toMatchObject({ baseRevisionId: "11111111-1111-4111-8111-111111111111", changeSummary: "Autosaved" });
    expect(post).not.toHaveBeenCalled();
  });

  it("looks up the latest revision on every autosave and posts the comment once at the end", async () => {
    const { api, put, post } = fakeApi();
    const get = api.get as unknown as ReturnType<typeof vi.fn>;
    const target = [{ issueId: "i1", ref: "PAR-1" }];
    get.mockRejectedValueOnce(new Error("Paperclip answered 404 for /x"));
    get.mockResolvedValueOnce({ latestRevisionId: "r1" });
    get.mockResolvedValueOnce({ latestRevisionId: "r2" });
    await saveLiveTranscript(api, CALL, target, { comment: false });
    await saveLiveTranscript(api, CALL, target, { comment: false });
    expect(post).not.toHaveBeenCalled();
    await saveLiveTranscript(api, CALL, target);
    expect(put.mock.calls.map((c) => (c[1] as { baseRevisionId?: string }).baseRevisionId)).toEqual([undefined, "r1", "r2"]);
    expect(post).toHaveBeenCalledTimes(1);
  });
});
