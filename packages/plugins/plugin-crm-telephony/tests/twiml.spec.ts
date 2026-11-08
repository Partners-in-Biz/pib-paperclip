import { describe, expect, it } from "vitest";
import { buildDialTwiml, escapeXml, MAX_INLINE_TWIML_CHARS } from "../src/twiml.js";

const CB = "https://paperclip.example.com/api/plugins/partnersinbiz.crm-telephony/webhooks/call-status";
const REC = "https://paperclip.example.com/api/plugins/partnersinbiz.crm-telephony/webhooks/recording-status";

describe("buildDialTwiml", () => {
  it("dials the number from the caller ID with status callbacks on the contact leg", () => {
    const twiml = buildDialTwiml({ to: "+27821234567", callerId: "+27105550100", record: false, statusCallbackUrl: CB });
    expect(twiml.startsWith('<?xml version="1.0" encoding="UTF-8"?><Response><Dial ')).toBe(true);
    expect(twiml).toContain('callerId="+27105550100"');
    expect(twiml).toContain('answerOnBridge="true"');
    expect(twiml).toContain('timeout="30"');
    expect(twiml).toContain(`<Number statusCallback="${CB}" statusCallbackEvent="initiated ringing answered completed" statusCallbackMethod="POST">+27821234567</Number>`);
    expect(twiml).not.toContain("record=");
    expect(twiml.endsWith("</Dial></Response>")).toBe(true);
  });

  it("records both legs from answer with the recording callback when asked", () => {
    const twiml = buildDialTwiml({ to: "+12125552000", callerId: "+12025550100", record: true, recordingStatusCallbackUrl: REC });
    expect(twiml).toContain('record="record-from-answer-dual"');
    expect(twiml).toContain(`recordingStatusCallback="${REC}"`);
    expect(twiml).toContain('recordingStatusCallbackEvent="completed absent failed"');
  });

  it("leaves recording attributes out when record is false even if a callback is given", () => {
    const twiml = buildDialTwiml({ to: "+12125552000", callerId: "+12025550100", record: false, recordingStatusCallbackUrl: REC });
    expect(twiml).not.toContain("recordingStatusCallback");
  });

  it("clamps the ring timeout to 5-120 seconds", () => {
    expect(buildDialTwiml({ to: "+27821234567", callerId: "+27105550100", record: false, timeoutSeconds: 1 })).toContain('timeout="5"');
    expect(buildDialTwiml({ to: "+27821234567", callerId: "+27105550100", record: false, timeoutSeconds: 999 })).toContain('timeout="120"');
  });

  it("rejects numbers that are not E.164 and non-http callbacks", () => {
    expect(() => buildDialTwiml({ to: "0821234567", callerId: "+27105550100", record: false })).toThrow(/E\.164/);
    expect(() => buildDialTwiml({ to: "+27821234567", callerId: "client:peet", record: false })).toThrow(/E\.164/);
    expect(() => buildDialTwiml({ to: "+27821234567", callerId: "+27105550100", record: false, statusCallbackUrl: "javascript:alert(1)" })).toThrow(/http/);
  });

  it("escapes attribute characters so a callback URL cannot break the XML", () => {
    const twiml = buildDialTwiml({ to: "+27821234567", callerId: "+27105550100", record: false, statusCallbackUrl: `${CB}?a=1&b="x"` });
    expect(twiml).toContain("?a=1&amp;b=&quot;x&quot;");
    expect(escapeXml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&apos;");
  });

  it("stays under Twilio's inline TwiML limit", () => {
    const twiml = buildDialTwiml({ to: "+27821234567", callerId: "+27105550100", record: true, recordingStatusCallbackUrl: REC, statusCallbackUrl: CB });
    expect(twiml.length).toBeLessThan(MAX_INLINE_TWIML_CHARS);
  });
});
