import { describe, expect, it } from "vitest";
import {
  extractHermesSessionId,
  parseHermesStreamJsonLine,
  parseHermesStreamJsonOutput,
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
