import { describe, expect, it, vi } from "vitest";
import { describeCallOutcome, emitBareCallNoted, formatSeconds, talkSeconds, type CallRowForNote } from "../src/voice-note.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

const base: CallRowForNote = {
  company_id: "c1", contact_id: "contact-1", direction: "outbound", status: "completed",
  from_e164: "+27105550100", to_e164: "+27821234567", duration_s: 160,
  answered_at: "2026-11-07T10:00:00Z", ended_at: "2026-11-07T10:02:13Z", recorded: false, consent_notice_played: false,
};

describe("call outcome text", () => {
  it("formats seconds for people", () => {
    expect(formatSeconds(45)).toBe("45 s");
    expect(formatSeconds(133)).toBe("2 min 13 s");
    expect(formatSeconds(120)).toBe("2 min");
    expect(formatSeconds(3725)).toBe("1 h 2 min");
  });

  it("talk time is ended minus answered, else Twilio's duration for a completed call", () => {
    expect(talkSeconds(base)).toBe(133);
    expect(talkSeconds({ ...base, answered_at: null })).toBe(160);
    expect(talkSeconds({ ...base, answered_at: null, status: "no-answer", duration_s: 20 })).toBeNull();
  });

  it("describes answered, no answer, busy, failed and cancelled calls", () => {
    expect(describeCallOutcome(base)).toBe("Outbound call to +27821234567, answered, 2 min 13 s. No recording.");
    expect(describeCallOutcome({ ...base, status: "no-answer", answered_at: null, duration_s: 25 })).toBe("Outbound call to +27821234567, no answer. No recording.");
    expect(describeCallOutcome({ ...base, status: "busy", answered_at: null })).toContain(", busy.");
    expect(describeCallOutcome({ ...base, status: "failed", answered_at: null })).toContain("failed to connect");
    expect(describeCallOutcome({ ...base, status: "canceled", answered_at: null })).toContain("cancelled");
    expect(describeCallOutcome({ ...base, recorded: true })).toContain("Recorded.");
    expect(describeCallOutcome({ ...base, direction: "inbound" })).toContain("Inbound call from +27105550100");
    expect(describeCallOutcome({ ...base, answered_at: null, duration_s: 0 })).toContain("ended before anyone answered");
  });
});

describe("emitBareCallNoted", () => {
  function ctxWith(rows: { calls: Partial<CallRowForNote>[]; prefs?: Array<{ erased_at: string | null; language: string | null }> }) {
    const emit = vi.fn(async () => {});
    const ctx = {
      db: {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("tel_calls")) return rows.calls.map((c) => ({ ...base, ...c }));
          if (sql.includes("tel_contact_prefs")) return rows.prefs ?? [];
          return [];
        }),
      },
      events: { emit },
    } as unknown as PluginContext;
    return { ctx, emit };
  }

  it("emits call.noted with the summary, duration and an empty transcript", async () => {
    const { ctx, emit } = ctxWith({ calls: [{}], prefs: [{ erased_at: null, language: "af" }] });
    expect(await emitBareCallNoted(ctx, "ns", "CA" + "1".repeat(32))).toBe("emitted");
    expect(emit).toHaveBeenCalledTimes(1);
    const [name, companyId, payload] = (emit.mock.calls[0] as unknown[]) as [string, string, Record<string, unknown>];
    expect(name).toBe("call.noted");
    expect(companyId).toBe("c1");
    expect(payload).toMatchObject({
      companyId: "c1", contactId: "contact-1", callSid: "CA" + "1".repeat(32),
      summary: "Outbound call to +27821234567, answered, 2 min 13 s. No recording.",
      nextActions: [], transcript: "", durationSec: 133, recordingUrl: null, language: "af", consent: { noticePlayed: false },
    });
  });

  it("does nothing without a contact, for an erased contact, or an unknown call", async () => {
    expect(await emitBareCallNoted(ctxWith({ calls: [{ contact_id: null }] }).ctx, "ns", "CA1")).toBe("no_contact");
    expect(await emitBareCallNoted(ctxWith({ calls: [{}], prefs: [{ erased_at: "2026-01-01", language: null }] }).ctx, "ns", "CA1")).toBe("erased");
    expect(await emitBareCallNoted(ctxWith({ calls: [] }).ctx, "ns", "CA1")).toBe("missing");
  });
});
