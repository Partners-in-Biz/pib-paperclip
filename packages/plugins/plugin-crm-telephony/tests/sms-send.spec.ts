import { describe, it, expect, beforeEach, vi } from "vitest";
import { sendSms, type SendSmsDeps } from "../src/sms/send.js";
import type {
  SmsSendRequest,
  SmsTransport,
  SuppressionChecker,
} from "../src/sms/types.js";
import type { TelephonySettings } from "../src/settings.js";

interface FakeDbRow {
  [key: string]: unknown;
}

class FakeDb {
  rows: Map<string, FakeDbRow[]> = new Map();
  executedSqls: Array<{ sql: string; params: unknown[] }> = [];

  async execute(sql: string, params?: unknown[]) {
    this.executedSqls.push({ sql, params: params ?? [] });
    return { rowCount: 1, rows: [] };
  }

  async query(sql: string, params?: unknown[]) {
    this.executedSqls.push({ sql, params: params ?? [] });
    return { rows: [] };
  }
}

class FakeSuppression implements SuppressionChecker {
  constructor(
    readonly suppressed: boolean = false,
    readonly consented: boolean = true,
  ) {}

  async check() {
    return { suppressed: this.suppressed, consented: this.consented };
  }
}

class FakeTransport implements SmsTransport {
  lastCall: { to: string; body: string } | null = null;
  throwError: boolean = false;

  async send(args: { to: string; body: string }): Promise<{ ok: true; providerMsgId: string; status: string } | { ok: false; kind: "retry" | "rejected" | "config"; error: string }> {
    this.lastCall = args;
    if (this.throwError) {
      return { ok: false, kind: "retry", error: "test error" };
    }
    return { ok: true, providerMsgId: "msg_123", status: "sent" };
  }
}

const baseSettings = (): TelephonySettings => ({
  recordingEnabled: false,
  whatsappEnabled: false,
  smsEnabled: true,
  maxCallsPerDay: 50,
  maxSmsPerDay: 200,
  maxWhatsappPerDay: 200,
  recordingRetentionDays: 30,
  allowedHours: { start: "08:00", end: "18:00", timezone: "Africa/Johannesburg" },
  callerIds: [],
  usSmsCampaignStatus: "approved",
  usMessagingServiceSid: "MGd3200a283d8d4dd9827e5b6d5f5e5e5a",
  smsHolidays: [],
});

const baseDeps = (overrides: Partial<SendSmsDeps> = {}): SendSmsDeps => ({
  db: new FakeDb(),
  namespace: "plugin_test",
  settings: baseSettings(),
  suppression: new FakeSuppression(),
  transport: new FakeTransport(),
  newId: () => "msg-id-123",
  ...overrides,
});

const baseRequest = (overrides: Partial<SmsSendRequest> = {}): SmsSendRequest => ({
  companyId: "c1",
  contactId: "contact1",
  to: "+27821234567",
  body: "Test message",
  kind: "service",
  ...overrides,
});

describe("sendSms", () => {
  it("returns disabled when smsEnabled is false", async () => {
    const deps = baseDeps({
      settings: { ...baseSettings(), smsEnabled: false },
    });
    const req = baseRequest();
    const result = await sendSms(deps, req);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("disabled");
  });

  it("returns invalid_number for non-E.164 phone", async () => {
    const deps = baseDeps();
    const result = await sendSms(deps, baseRequest({ to: "not-a-phone" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_number");
  });

  it("returns za_provider_not_configured for South African numbers", async () => {
    const deps = baseDeps();
    const result = await sendSms(deps, baseRequest({ to: "+27821234567" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("za_provider_not_configured");
  });

  it("returns unsupported_region for other regions", async () => {
    const deps = baseDeps();
    const result = await sendSms(deps, baseRequest({ to: "+44201234567" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsupported_region");
  });

  it("returns us_campaign_not_approved when status is not approved", async () => {
    const deps = baseDeps({
      settings: { ...baseSettings(), usSmsCampaignStatus: "pending" },
    });
    const result = await sendSms(deps, baseRequest({ to: "+12025551234" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("us_campaign_not_approved");
  });

  it("returns us_campaign_not_approved when no messaging service SID", async () => {
    const deps = baseDeps({
      settings: { ...baseSettings(), usMessagingServiceSid: null },
    });
    const result = await sendSms(deps, baseRequest({ to: "+12025551234" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("us_campaign_not_approved");
  });

  it("returns opted_out when contact has sms_opt_out_at", async () => {
    const db = new FakeDb();
    db.query = vi.fn().mockResolvedValue({
      rows: [{ sms_opt_out_at: "2026-01-01T00:00:00Z", erased_at: null }],
    });
    const deps = baseDeps({ db });
    const result = await sendSms(deps, baseRequest({ to: "+12025551234" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("opted_out");
  });

  it("returns suppressed when suppression check returns true", async () => {
    const deps = baseDeps({
      suppression: new FakeSuppression(true, true),
    });
    const result = await sendSms(deps, baseRequest({ to: "+12025551234" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("suppressed");
  });

  it("returns no_consent when suppression check returns not consented", async () => {
    const deps = baseDeps({
      suppression: new FakeSuppression(false, false),
    });
    const result = await sendSms(deps, baseRequest({ to: "+12025551234" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_consent");
  });

  it("returns suppression_check_failed on suppression error", async () => {
    const deps = baseDeps({
      suppression: {
        check: vi.fn().mockRejectedValue(new Error("DB error")),
      } as any,
    });
    const result = await sendSms(deps, baseRequest({ to: "+12025551234" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("suppression_check_failed");
  });

  it("returns outside_hours when marketing send is outside window", async () => {
    // Sunday should always fail
    const sundayAt12 = new Date("2026-10-18T12:00:00Z"); // Sunday
    const deps = baseDeps();
    const result = await sendSms(
      deps,
      baseRequest({ to: "+12025551234", kind: "marketing", now: sundayAt12 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("outside_hours");
  });

  it("allows service messages outside marketing window", async () => {
    const sundayAt12 = new Date("2026-10-18T12:00:00Z");
    const deps = baseDeps();
    const result = await sendSms(
      deps,
      baseRequest({ to: "+12025551234", kind: "service", now: sundayAt12 }),
    );
    expect(result.ok).toBe(true);
  });

  it("returns transport_error when transport is null", async () => {
    const deps = baseDeps({ transport: null });
    const result = await sendSms(deps, baseRequest({ to: "+12025551234" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("transport_error");
  });

  it("appends opt-out line to marketing messages", async () => {
    const transport = new FakeTransport();
    const deps = baseDeps({ transport });
    // Use a marketing hour for the test (Monday 10:00 SAST = 08:00 UTC)
    const mondayMorning = new Date("2026-10-19T08:00:00Z");
    await sendSms(
      deps,
      baseRequest({
        to: "+12025551234",
        body: "Marketing offer",
        kind: "marketing",
        now: mondayMorning,
      }),
    );
    expect(transport.lastCall?.body).toContain("Reply STOP");
  });

  it("does not append opt-out line to service messages", async () => {
    const transport = new FakeTransport();
    const deps = baseDeps({ transport });
    await sendSms(
      deps,
      baseRequest({
        to: "+12025551234",
        body: "Verification code: 123456",
        kind: "service",
      }),
    );
    expect(transport.lastCall?.body).toBe("Verification code: 123456");
  });

  it("returns success with provider message ID on happy path", async () => {
    const deps = baseDeps();
    const result = await sendSms(deps, baseRequest({ to: "+12025551234" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messageId).toBe("msg-id-123");
      expect(result.providerMsgId).toBe("msg_123");
    }
  });

  it("audit rows contain no body and mask phone number", async () => {
    const db = new FakeDb();
    const deps = baseDeps({ db, suppression: new FakeSuppression(true) });
    const result = await sendSms(deps, baseRequest({ to: "+12025551234" }));
    expect(result.ok).toBe(false); // suppressed

    const auditCalls = db.executedSqls.filter((call) =>
      call.sql.includes("tel_audit"),
    );
    expect(auditCalls.length).toBeGreaterThan(0);

    // Verify no SQL contains the full phone number or body
    db.executedSqls.forEach((call) => {
      expect(call.sql).not.toContain("+12025551234");
      expect(call.sql).not.toContain("Test message");
    });
  });

  it("order of precedence: unapproved campaign beats suppression", async () => {
    const deps = baseDeps({
      settings: { ...baseSettings(), usSmsCampaignStatus: "pending" },
      suppression: new FakeSuppression(true, true),
    });
    const result = await sendSms(deps, baseRequest({ to: "+12025551234" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("us_campaign_not_approved");
  });

  it("suppression throw causes refused", async () => {
    const deps = baseDeps({
      suppression: { check: vi.fn().mockRejectedValue(new Error()) } as any,
    });
    const transport = new FakeTransport();
    deps.transport = transport;
    await sendSms(deps, baseRequest({ to: "+12025551234" }));
    expect(transport.lastCall).toBeNull();
  });

  it("ZA numbers are refused early", async () => {
    const deps = baseDeps({
      suppression: new FakeSuppression(true, false),
      transport: null,
    });
    const result = await sendSms(deps, baseRequest({ to: "+27821234567" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("za_provider_not_configured");
  });

  it("marketing outside hours refused but service allowed", async () => {
    const mondayMidnight = new Date("2026-10-19T00:00:00Z"); // Monday 00:00 UTC
    const deps = baseDeps();

    // Marketing should fail
    const marketingResult = await sendSms(
      deps,
      baseRequest({
        to: "+12025551234",
        kind: "marketing",
        now: mondayMidnight,
      }),
    );
    expect(marketingResult.ok).toBe(false);
    if (!marketingResult.ok) expect(marketingResult.reason).toBe("outside_hours");

    // Service should succeed
    const serviceResult = await sendSms(
      deps,
      baseRequest({
        to: "+12025551234",
        kind: "service",
        now: mondayMidnight,
      }),
    );
    expect(serviceResult.ok).toBe(true);
  });

  it("daily cap boundary: cap-1 allowed, cap refused", async () => {
    const db = new FakeDb();
    const capMinusOne = 199; // maxSmsPerDay is 200, so 199 should pass
    db.execute = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("COUNT(*)")) {
        return { rowCount: 1, rows: [{ cnt: capMinusOne }] };
      }
      return { rowCount: 1, rows: [] };
    });

    const deps = baseDeps({ db });
    const result1 = await sendSms(deps, baseRequest({ to: "+12025551234" }));
    expect(result1.ok).toBe(true);

    // Now at cap
    db.execute = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("COUNT(*)")) {
        return { rowCount: 1, rows: [{ cnt: 200 }] };
      }
      return { rowCount: 1, rows: [] };
    });

    const deps2 = baseDeps({ db });
    const result2 = await sendSms(deps2, baseRequest({ to: "+12025551234" }));
    expect(result2.ok).toBe(false);
    if (!result2.ok) expect(result2.reason).toBe("daily_cap");
  });
});
