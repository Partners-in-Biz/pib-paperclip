import { describe, expect, it } from "vitest";
import {
  extractHermesSessionId,
  isPlausibleHermesSessionId,
  parseHermesStreamJsonLine,
  parseHermesStreamJsonOutput,
  sessionCheckpointResumeEnabled,
} from "./session-checkpoint.js";

describe("hermes session checkpoint", () => {
  it("reads the session id from the stream-json init event", () => {
    const line =
      '{"type":"system","subtype":"init","session_id":"20261028_145531_817f3d","model":"xai"}';
    expect(extractHermesSessionId(line)).toBe("20261028_145531_817f3d");
    expect(parseHermesStreamJsonLine(line)?.subtype).toBe("init");
  });

  it("still reads the quiet-mode session_id line", () => {
    expect(extractHermesSessionId("session_id: 20261028_145531_817f3d\n")).toBe(
      "20261028_145531_817f3d",
    );
  });

  it("ignores non-session ids", () => {
    expect(extractHermesSessionId('{"session_id":"not-a-session"}')).toBeNull();
    expect(isPlausibleHermesSessionId("local-not-hex-at-all")).toBe(false);
  });

  it("accepts gateway-backed local-<sha256> session ids (PAR-13537)", () => {
    const id = `local-${"a83174a7".repeat(8)}`;
    expect(isPlausibleHermesSessionId(id)).toBe(true);
    expect(extractHermesSessionId(`{"type":"system","subtype":"init","session_id":"${id}"}`)).toBe(id);
    expect(extractHermesSessionId(`session_id: ${id}\n`)).toBe(id);
  });

  it("defaults the rollback flag on and honours an explicit off", () => {
    expect(sessionCheckpointResumeEnabled({})).toBe(true);
    expect(sessionCheckpointResumeEnabled({ PAPERCLIP_SESSION_CHECKPOINT: "0" })).toBe(false);
    expect(sessionCheckpointResumeEnabled({ PAPERCLIP_SESSION_CHECKPOINT: "off" })).toBe(false);
  });

  it("keeps the result text and usage when the process dies after init", () => {
    const stdout = [
      '{"type":"system","subtype":"init","session_id":"20261028_145531_817f3d"}',
      '{"type":"result","session_id":"20261028_145531_817f3d","exit_code":130,"text":"partial","tokens":{"input":12,"output":3,"cache_read":4}}',
    ].join("\n");
    expect(parseHermesStreamJsonOutput(stdout)).toEqual({
      sessionId: "20261028_145531_817f3d",
      response: "partial",
      usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 4 },
      errorMessage: undefined,
    });
  });
});
