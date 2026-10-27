import { describe, expect, it, vi } from "vitest";
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

function fakeApi(failPutFor?: string) {
  const put = vi.fn(async (path: string) => {
    if (failPutFor && path.includes(failPutFor)) throw new Error("Paperclip answered 500");
    return {};
  });
  const post = vi.fn(async () => ({}));
  const get = vi.fn(async () => ({}));
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
});
