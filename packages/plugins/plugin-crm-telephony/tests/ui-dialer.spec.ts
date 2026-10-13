import { describe, it, expect } from "vitest";
import {
  parseDialerParams,
  formatDuration,
  isValidDtmf,
  softphoneReducer,
  initialSoftphoneState,
  type SoftphoneState,
} from "../src/ui/dialer.js";

describe("Dialer UI utilities", () => {
  describe("parseDialerParams", () => {
    it("parses empty search string", () => {
      expect(parseDialerParams("")).toEqual({});
    });

    it("parses to parameter", () => {
      expect(parseDialerParams("?to=%2B27123456789")).toEqual({ to: "+27123456789" });
    });

    it("parses contactId parameter", () => {
      expect(parseDialerParams("?contactId=contact-123")).toEqual({ contactId: "contact-123" });
    });

    it("parses both parameters", () => {
      expect(parseDialerParams("?to=%2B27123456789&contactId=contact-123")).toEqual({
        to: "+27123456789",
        contactId: "contact-123",
      });
    });

    it("ignores unknown parameters", () => {
      expect(parseDialerParams("?to=%2B27123456789&unknown=value")).toEqual({
        to: "+27123456789",
      });
    });

    it("returns undefined for missing parameters", () => {
      expect(parseDialerParams("?to=%2B27123456789").contactId).toBeUndefined();
    });
  });

  describe("formatDuration", () => {
    it("formats duration without hours", () => {
      expect(formatDuration(65)).toBe("01:05");
    });

    it("formats duration with hours", () => {
      expect(formatDuration(3665)).toBe("01:01:05");
    });

    it("formats zero seconds", () => {
      expect(formatDuration(0)).toBe("00:00");
    });

    it("formats 59 seconds", () => {
      expect(formatDuration(59)).toBe("00:59");
    });

    it("formats multiple hours", () => {
      expect(formatDuration(7325)).toBe("02:02:05");
    });
  });

  describe("isValidDtmf", () => {
    it("accepts digits 0-9", () => {
      for (let i = 0; i < 10; i++) {
        expect(isValidDtmf(String(i))).toBe(true);
      }
    });

    it("accepts * and #", () => {
      expect(isValidDtmf("*")).toBe(true);
      expect(isValidDtmf("#")).toBe(true);
    });

    it("rejects non-DTMF characters", () => {
      expect(isValidDtmf("a")).toBe(false);
      expect(isValidDtmf("+")).toBe(false);
      expect(isValidDtmf(" ")).toBe(false);
      expect(isValidDtmf("")).toBe(false);
    });

    it("rejects multi-character strings", () => {
      expect(isValidDtmf("12")).toBe(false);
    });
  });

  describe("softphoneReducer", () => {
    let state: SoftphoneState;

    const setUpInitial = () => {
      state = initialSoftphoneState;
    };

    it("starts in idle state", () => {
      setUpInitial();
      expect(state.status).toBe("idle");
      expect(state.durationSeconds).toBe(0);
      expect(state.isMuted).toBe(false);
      expect(state.isRecording).toBe(false);
    });

    it("transitions to dialing on dial action", () => {
      setUpInitial();
      state = softphoneReducer(state, { type: "dial", number: "+27123456789" });
      expect(state.status).toBe("dialing");
      expect(state.currentNumber).toBe("+27123456789");
      expect(state.durationSeconds).toBe(0);
      expect(state.error).toBeUndefined();
    });

    it("transitions to ringing on ring action", () => {
      setUpInitial();
      state = softphoneReducer(state, { type: "dial", number: "+27123456789" });
      state = softphoneReducer(state, { type: "ring" });
      expect(state.status).toBe("ringing");
    });

    it("transitions to connected and resets duration", () => {
      setUpInitial();
      state = softphoneReducer(state, { type: "dial", number: "+27123456789" });
      state = softphoneReducer(state, { type: "connect" });
      expect(state.status).toBe("connected");
      expect(state.durationSeconds).toBe(0);
      expect(state.isMuted).toBe(false);
    });

    it("increments duration on tick when connected", () => {
      setUpInitial();
      state = softphoneReducer(state, { type: "dial", number: "+27123456789" });
      state = softphoneReducer(state, { type: "connect" });
      state = softphoneReducer(state, { type: "tick" });
      expect(state.durationSeconds).toBe(1);
      state = softphoneReducer(state, { type: "tick" });
      expect(state.durationSeconds).toBe(2);
    });

    it("ignores tick when not connected", () => {
      setUpInitial();
      state = softphoneReducer(state, { type: "dial", number: "+27123456789" });
      state = softphoneReducer(state, { type: "tick" });
      expect(state.durationSeconds).toBe(0);
    });

    it("resets to idle on hangup", () => {
      setUpInitial();
      state = softphoneReducer(state, { type: "dial", number: "+27123456789" });
      state = softphoneReducer(state, { type: "connect" });
      state = softphoneReducer(state, { type: "tick" });
      state = softphoneReducer(state, { type: "hangup" });
      expect(state.status).toBe("idle");
      expect(state.durationSeconds).toBe(0);
      expect(state.currentNumber).toBeUndefined();
    });

    it("toggles mute state", () => {
      setUpInitial();
      state = softphoneReducer(state, { type: "dial", number: "+27123456789" });
      state = softphoneReducer(state, { type: "connect" });
      expect(state.isMuted).toBe(false);
      state = softphoneReducer(state, { type: "mute" });
      expect(state.isMuted).toBe(true);
      state = softphoneReducer(state, { type: "unmute" });
      expect(state.isMuted).toBe(false);
    });

    it("toggles recording state", () => {
      setUpInitial();
      expect(state.isRecording).toBe(false);
      state = softphoneReducer(state, { type: "recordingStart" });
      expect(state.isRecording).toBe(true);
      state = softphoneReducer(state, { type: "recordingStop" });
      expect(state.isRecording).toBe(false);
    });

    it("sets error state with message", () => {
      setUpInitial();
      state = softphoneReducer(state, { type: "error", message: "Connection failed" });
      expect(state.status).toBe("error");
      expect(state.error).toBe("Connection failed");
    });

    it("resets to initial state", () => {
      setUpInitial();
      state = softphoneReducer(state, { type: "dial", number: "+27123456789" });
      state = softphoneReducer(state, { type: "connect" });
      state = softphoneReducer(state, { type: "tick" });
      state = softphoneReducer(state, { type: "mute" });
      state = softphoneReducer(state, { type: "reset" });
      expect(state).toEqual(initialSoftphoneState);
    });
  });
});
