import { describe, expect, it } from "vitest";
import { childPatch, parentPatch, parseCallStatusParams, TERMINAL_STATUSES } from "../src/call-status.js";
import { parseFormParams } from "../src/twilio-signature.js";

const PARENT = "CA" + "a".repeat(32);
const CHILD = "CA" + "b".repeat(32);

describe("parseCallStatusParams", () => {
  it("reads the parent leg's fields", () => {
    const e = parseCallStatusParams(parseFormParams(`CallSid=${PARENT}&CallStatus=completed&CallDuration=73&From=%2B27105550100&To=client%3Auser-1&Direction=outbound-api`));
    expect(e).toEqual({ callSid: PARENT, parentCallSid: null, status: "completed", durationSec: 73, from: "+27105550100", to: "client:user-1", direction: "outbound-api" });
  });

  it("reads a child leg with ParentCallSid and ignores a bad duration", () => {
    const e = parseCallStatusParams(parseFormParams(`CallSid=${CHILD}&ParentCallSid=${PARENT}&CallStatus=in-progress&CallDuration=abc`));
    expect(e?.parentCallSid).toBe(PARENT);
    expect(e?.durationSec).toBeNull();
  });

  it("rejects a malformed CallSid or a missing status", () => {
    expect(parseCallStatusParams(parseFormParams("CallSid=nope&CallStatus=ringing"))).toBeNull();
    expect(parseCallStatusParams(parseFormParams(`CallSid=${PARENT}`))).toBeNull();
  });
});

describe("childPatch (the contact's phone)", () => {
  const fresh = { status: "initiated", answered_at: null, ended_at: null };
  it("ringing marks the row ringing; answered sets answered_at and in-progress", () => {
    expect(childPatch(fresh, "ringing")).toEqual({ status: "ringing" });
    expect(childPatch(fresh, "in-progress")).toEqual({ status: "in-progress", markAnswered: true });
  });
  it("busy, no-answer, failed and canceled become the row's verdict", () => {
    for (const s of ["busy", "no-answer", "failed", "canceled"]) expect(childPatch(fresh, s)).toEqual({ status: s });
  });
  it("completed counts only when the contact had answered; initiated does nothing", () => {
    expect(childPatch(fresh, "completed")).toBeNull();
    expect(childPatch({ ...fresh, answered_at: "2026-11-07T10:00:00Z" }, "completed")).toEqual({ status: "completed" });
    expect(childPatch(fresh, "initiated")).toBeNull();
  });
  it("does nothing once the row has ended", () => {
    expect(childPatch({ ...fresh, ended_at: "2026-11-07T10:03:00Z" }, "busy")).toBeNull();
  });
});

describe("parentPatch (the browser leg)", () => {
  const fresh = { status: "initiated", answered_at: null, ended_at: null };
  it("completed ends the row with the duration", () => {
    expect(parentPatch(fresh, "completed", 73)).toEqual({ status: "completed", terminal: true, durationSec: 73 });
  });
  it("keeps the child's verdict when the parent completes after a busy or no-answer", () => {
    expect(parentPatch({ ...fresh, status: "no-answer" }, "completed", 31)).toEqual({ status: "no-answer", terminal: true, durationSec: 31 });
    expect(parentPatch({ ...fresh, status: "busy" }, "completed", 5)?.status).toBe("busy");
  });
  it("parent failed or no-answer ends the row with that status", () => {
    expect(parentPatch(fresh, "failed", null)).toEqual({ status: "failed", terminal: true, durationSec: null });
    expect(parentPatch(fresh, "no-answer", 20)?.status).toBe("no-answer");
  });
  it("ringing and in-progress move an initiated row forward only", () => {
    expect(parentPatch(fresh, "ringing", null)).toEqual({ status: "ringing", terminal: false, durationSec: null });
    expect(parentPatch(fresh, "in-progress", null)?.status).toBe("connecting");
    expect(parentPatch({ ...fresh, status: "in-progress", answered_at: "x" }, "in-progress", null)).toBeNull();
    expect(parentPatch(fresh, "queued", null)).toBeNull();
  });
  it("does nothing once the row has ended", () => {
    expect(parentPatch({ ...fresh, ended_at: "2026-11-07T10:03:00Z" }, "completed", 10)).toBeNull();
  });
  it("knows the terminal statuses", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(["busy", "canceled", "completed", "failed", "no-answer"]);
  });
});
