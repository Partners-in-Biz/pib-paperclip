import { describe, expect, it, vi } from "vitest";
import { voiceDialAction, voiceCallLookupAction, withinAllowedHours } from "../src/voice-dial.js";
import type { TwilioClient } from "../src/twilio-client.js";
import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";

const COMPANY = "c1";
const SECRETS: Record<string, string | null> = {
  TWILIO_ACCOUNT_SID: "AC" + "a".repeat(32),
  TWILIO_AUTH_TOKEN: "tok",
};
const NUMBERS = [{ e164: "+27105550100", label: "PiB Cape Town", regions: ["27"], purposes: ["voice", "sms"], enabled: true, isDefault: true }, { e164: "+12025550100", label: "US sales", regions: ["1"], purposes: ["voice"], enabled: true, isDefault: false }];
const PARENT = "CA" + "9".repeat(32);

// 10:00 in Johannesburg on a Friday: inside the default 08:00-18:00 window; 03:00 in New York (outside US hours).
const SAST_MORNING = () => new Date("2026-11-06T08:00:00Z");
// 19:00 Johannesburg / 12:00 New York / 09:00 Los Angeles: inside the US window (all four zones) and inside a
// company window that ends at 22:00. With the default 08:00-18:00 SAST window no US call is possible in winter.
const BOTH_OPEN = () => new Date("2026-11-06T17:00:00Z");
const LATE_HOURS = { allowedHours: { start: "08:00", end: "22:00" } };

interface Fake {
  ctx: PluginContext;
  calls: Array<Record<string, unknown>>;
  audits: Array<Record<string, unknown>>;
  client: TwilioClient;
  createCall: ReturnType<typeof vi.fn>;
}

function fake(opts: {
  config?: Record<string, unknown>;
  secrets?: Record<string, string | null>;
  contacts?: Array<{ id: string; phones: string[] }>;
  todayCount?: number;
  doNotRecord?: boolean;
  twilio?: { ok: boolean; error?: string };
} = {}): Fake {
  const secrets = { ...SECRETS, ...(opts.secrets ?? {}) };
  const calls: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const createCall = vi.fn(async () =>
    opts.twilio?.ok === false
      ? { ok: false as const, failure: { kind: "rejected" as const, status: 400, code: 21212, error: opts.twilio.error ?? "Invalid From number" } }
      : { ok: true as const, value: { sid: PARENT, status: "queued" } },
  );
  const client = { createCall } as unknown as TwilioClient;
  const ctx = {
    config: { get: vi.fn().mockResolvedValue({ voiceAllowedUserIds: ["user-1"], publicBaseUrl: "https://paperclip.example.com", numbers: NUMBERS, ...(opts.config ?? {}) }) },
    secrets: {
      resolve: vi.fn(async (name: string) => {
        const v = secrets[name];
        if (v === null || v === undefined) throw new Error("not set");
        return v;
      }),
    },
    db: {
      namespace: "ns",
      query: vi.fn(async (sql: string) => {
        if (sql.includes("crm_contacts")) return (opts.contacts ?? []).map((c) => ({ id: c.id, phones: c.phones }));
        if (sql.includes("COUNT(*)")) return [{ count: opts.todayCount ?? 0 }];
        if (sql.includes("tel_contact_prefs")) return opts.doNotRecord === undefined ? [] : [{ do_not_record: opts.doNotRecord }];
        if (sql.includes("FROM ns") || sql.includes("tel_calls")) return calls.filter((c) => c.status !== undefined).map((c) => ({
          call_sid: c.call_sid, status: c.status, direction: c.direction, to_e164: c.to_e164, from_e164: c.from_e164, contact_id: c.contact_id,
          recorded: c.recorded, started_at: c.started_at, answered_at: null, ended_at: null, duration_s: null,
        }));
        return [];
      }),
      execute: vi.fn(async (sql: string, params: unknown[]) => {
        if (sql.includes("tel_audit")) { audits.push({ action: params[2], detail: JSON.parse(params[4] as string) }); return { rowCount: 1 }; }
        if (sql.includes("tel_calls")) {
          const cols = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(",");
          calls.push(Object.fromEntries(cols.map((c, i) => [c, params[i]])));
          return { rowCount: 1 };
        }
        return { rowCount: 0 };
      }),
    },
    http: { fetch: vi.fn() },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as PluginContext;
  return { ctx, calls, audits, client, createCall };
}

const userContext: PluginPerformActionContext = {
  actor: { type: "user", userId: "user-1", agentId: null, runId: null, companyId: COMPANY },
  companyId: COMPANY,
};

describe("withinAllowedHours", () => {
  const hours = { start: "08:00", end: "18:00", timezone: "Africa/Johannesburg" };
  it("is true inside the window and false at the end and before the start", () => {
    expect(withinAllowedHours(new Date("2026-11-06T06:00:00Z"), hours)).toBe(true); // 08:00 SAST
    expect(withinAllowedHours(new Date("2026-11-06T15:59:00Z"), hours)).toBe(true); // 17:59 SAST
    expect(withinAllowedHours(new Date("2026-11-06T16:00:00Z"), hours)).toBe(false); // 18:00 SAST
    expect(withinAllowedHours(new Date("2026-11-06T05:59:00Z"), hours)).toBe(false); // 07:59 SAST
  });
});

describe("voiceDialAction", () => {
  it("places the call: Twilio rings the browser, the TwiML dials the contact from the ZA number, and the row is written", async () => {
    const f = fake({ contacts: [{ id: "contact-7", phones: ["082 123 4567"] }] });
    const result = await voiceDialAction(f.ctx, { to: "+27 82 123 4567" }, userContext, { now: SAST_MORNING, client: f.client });

    expect(result).toMatchObject({ callSid: PARENT, to: "+27821234567", callerId: "+27105550100", region: "27", numberLabel: "PiB Cape Town", matchedBy: "region", contactId: "contact-7", recording: false, identity: "user-1" });

    expect(f.createCall).toHaveBeenCalledTimes(1);
    const req = f.createCall.mock.calls[0][0] as Record<string, unknown>;
    expect(req.to).toBe("client:user-1");
    expect(req.from).toBe("+27105550100");
    expect(req.statusCallback).toBe("https://paperclip.example.com/api/plugins/partnersinbiz.crm-telephony/webhooks/call-status");
    expect(String(req.twiml)).toContain("+27821234567</Number>");
    expect(String(req.twiml)).toContain('callerId="+27105550100"');
    expect(String(req.twiml)).not.toContain("record=");

    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ company_id: COMPANY, contact_id: "contact-7", user_id: "user-1", direction: "outbound", from_e164: "+27105550100", to_e164: "+27821234567", call_sid: PARENT, status: "initiated", recorded: false });
    expect(f.audits.map((a) => a.action)).toEqual(["voice.dial"]);
  });

  it("uses the contact id the page carried instead of matching", async () => {
    const f = fake({ contacts: [{ id: "contact-7", phones: ["+27821234567"] }] });
    const result = await voiceDialAction(f.ctx, { to: "+27821234567", contactId: "contact-given" }, userContext, { now: SAST_MORNING, client: f.client });
    expect(result.contactId).toBe("contact-given");
  });

  it("falls back to the browser origin when no public base URL is saved", async () => {
    const f = fake({ config: { publicBaseUrl: null } });
    await voiceDialAction(f.ctx, { to: "+27821234567", origin: "https://pc.example.org" }, userContext, { now: SAST_MORNING, client: f.client });
    expect((f.createCall.mock.calls[0][0] as Record<string, unknown>).statusCallback).toContain("https://pc.example.org/api/plugins/");
  });

  it("refuses without any base URL", async () => {
    const f = fake({ config: { publicBaseUrl: null } });
    await expect(voiceDialAction(f.ctx, { to: "+27821234567" }, userContext, { now: SAST_MORNING, client: f.client })).rejects.toThrow(/public base URL/);
    expect(f.createCall).not.toHaveBeenCalled();
  });

  it("records when recording is on, R2 is filled in and the contact did not opt out", async () => {
    const r2 = { r2: { accountId: "a", bucket: "b", accessKeyId: "k", secretAccessKey: "s" } };
    const on = fake({ config: { recordingEnabled: true, ...r2 }, contacts: [{ id: "c-1", phones: ["+27821234567"] }] });
    const r1 = await voiceDialAction(on.ctx, { to: "+27821234567" }, userContext, { now: SAST_MORNING, client: on.client });
    expect(r1.recording).toBe(true);
    expect(String((on.createCall.mock.calls[0][0] as Record<string, unknown>).twiml)).toContain('record="record-from-answer-dual"');
    expect(on.calls[0].recorded).toBe(true);

    const noR2 = fake({ config: { recordingEnabled: true } });
    expect((await voiceDialAction(noR2.ctx, { to: "+27821234567" }, userContext, { now: SAST_MORNING, client: noR2.client })).recording).toBe(false);

    const optOut = fake({ config: { recordingEnabled: true, ...r2 }, contacts: [{ id: "c-1", phones: ["+27821234567"] }], doNotRecord: true });
    expect((await voiceDialAction(optOut.ctx, { to: "+27821234567" }, userContext, { now: SAST_MORNING, client: optOut.client })).recording).toBe(false);
  });

  it("refuses a person who is not on the voice allowlist, and any agent", async () => {
    const f = fake({ config: { voiceAllowedUserIds: ["someone-else"] } });
    await expect(voiceDialAction(f.ctx, { to: "+27821234567" }, userContext, { client: f.client })).rejects.toThrow("Calling is not enabled for this user");
    const agent: PluginPerformActionContext = { actor: { type: "agent", userId: null, agentId: "agent-1", runId: null, companyId: COMPANY }, companyId: COMPANY };
    await expect(voiceDialAction(fake().ctx, { to: "+27821234567" }, agent)).rejects.toThrow("Only a signed-in person can use the dialer");
    expect(f.createCall).not.toHaveBeenCalled();
  });

  it("refuses a number it cannot read", async () => {
    const f = fake();
    await expect(voiceDialAction(f.ctx, { to: "call me" }, userContext, { client: f.client })).rejects.toThrow(/international format/);
    await expect(voiceDialAction(f.ctx, {}, userContext, { client: f.client })).rejects.toThrow(/international format/);
  });

  it("blocks outside the company's hours and audits the refusal", async () => {
    const f = fake();
    await expect(voiceDialAction(f.ctx, { to: "+27821234567" }, userContext, { now: () => new Date("2026-11-06T20:00:00Z"), client: f.client })).rejects.toThrow(/08:00-18:00/);
    expect(f.audits[0]).toMatchObject({ action: "voice.dial.blocked", detail: { reason: "outside_allowed_hours" } });
    expect(f.createCall).not.toHaveBeenCalled();
  });

  it("blocks a US number outside US calling hours, allows it inside", async () => {
    const early = fake();
    await expect(voiceDialAction(early.ctx, { to: "+12125552000" }, userContext, { now: SAST_MORNING, client: early.client })).rejects.toThrow(/08:00 and 21:00/);
    expect(early.audits[0]).toMatchObject({ detail: { reason: "outside_us_calling_hours" } });

    const ok = fake({ config: LATE_HOURS });
    const r = await voiceDialAction(ok.ctx, { to: "+12125552000" }, userContext, { now: BOTH_OPEN, client: ok.client });
    expect(r.callerId).toBe("+12025550100");
    expect(r.region).toBe("1");
    expect(r.matchedBy).toBe("region");
  });

  it("blocks when the daily cap is reached", async () => {
    const f = fake({ todayCount: 50 });
    await expect(voiceDialAction(f.ctx, { to: "+27821234567" }, userContext, { now: SAST_MORNING, client: f.client })).rejects.toThrow(/daily cap of 50/);
    expect(f.audits[0]).toMatchObject({ detail: { reason: "cap_reached" } });
  });

  it("picks by region, falls back to the default, and names the Numbers settings when nothing fits", async () => {
    // A UK lead: no +44 number, so the default (ZA) number is the caller ID.
    const uk = fake();
    const r = await voiceDialAction(uk.ctx, { to: "+447700900123" }, userContext, { now: SAST_MORNING, client: uk.client });
    expect(r).toMatchObject({ callerId: "+27105550100", region: "44", matchedBy: "default" });

    // A single saved number is the default whatever the flag says, so a +27 lead gets the US number.
    const usOnly = fake({ config: { numbers: [{ ...NUMBERS[1], isDefault: false }] } });
    const lone = await voiceDialAction(usOnly.ctx, { to: "+27821234567" }, userContext, { now: SAST_MORNING, client: usOnly.client });
    expect(lone).toMatchObject({ callerId: "+12025550100", matchedBy: "default" });

    // A disabled number does not count.
    const disabled = fake({ config: { numbers: NUMBERS.map((n) => ({ ...n, enabled: false })) } });
    await expect(voiceDialAction(disabled.ctx, { to: "+27821234567" }, userContext, { now: SAST_MORNING, client: disabled.client })).rejects.toThrow(/No Voice number is set up/);

    // The old secrets still work while the list is empty (seeded once).
    const seeded = fake({ config: { numbers: [] }, secrets: { TWILIO_ZA_NUMBER: "+27115550199" } });
    const s = await voiceDialAction(seeded.ctx, { to: "+27821234567" }, userContext, { now: SAST_MORNING, client: seeded.client });
    expect(s.callerId).toBe("+27115550199");
    expect(s.numberLabel).toContain("TWILIO_ZA_NUMBER");
  });

  it("says the credentials are missing without naming values", async () => {
    const f = fake({ secrets: { TWILIO_AUTH_TOKEN: null } });
    await expect(voiceDialAction(f.ctx, { to: "+27821234567" }, userContext, { now: SAST_MORNING, client: f.client })).rejects.toThrow("Twilio voice credentials are not configured");
  });

  it("reports a Twilio refusal, audits it and writes no row", async () => {
    const f = fake({ twilio: { ok: false, error: "The From phone number is not a valid, SMS-capable inbound phone number" } });
    await expect(voiceDialAction(f.ctx, { to: "+27821234567" }, userContext, { now: SAST_MORNING, client: f.client })).rejects.toThrow(/Twilio refused the call: The From phone number/);
    expect(f.calls).toHaveLength(0);
    expect(f.audits.map((a) => a.action)).toEqual(["voice.dial.failed"]);
  });
});

describe("voiceCallLookupAction", () => {
  it("returns the company's row for a voice user and nothing for another SID", async () => {
    const f = fake({ contacts: [{ id: "contact-7", phones: ["+27821234567"] }] });
    await voiceDialAction(f.ctx, { to: "+27821234567" }, userContext, { now: SAST_MORNING, client: f.client });
    const view = await voiceCallLookupAction(f.ctx, { callSid: PARENT }, userContext);
    expect(view).toMatchObject({ callSid: PARENT, status: "initiated", to: "+27821234567", contactId: "contact-7", answeredAt: null, endedAt: null });
    await expect(voiceCallLookupAction(f.ctx, { callSid: "nope" }, userContext)).rejects.toThrow("callSid is required");
  });

  it("refuses a person who may not call", async () => {
    const f = fake({ config: { voiceAllowedUserIds: [] } });
    await expect(voiceCallLookupAction(f.ctx, { callSid: PARENT }, userContext)).rejects.toThrow("Calling is not enabled for any user");
  });
});
