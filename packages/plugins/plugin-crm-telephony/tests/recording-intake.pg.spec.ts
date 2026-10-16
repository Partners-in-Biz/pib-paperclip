import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NAMESPACE, PLUGIN_ID } from "../src/namespace.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { startPg } from "./helpers/pg.js";
import type { PgDb } from "./helpers/pg.js";
import {
  createMockDbClient,
  createMockCtx,
  buildSignedRecordingStatusInput,
} from "./helpers/webhook-mocks.js";

let pgDb: PgDb;
const COMPANY_UUID_1 = "550e8400-e29b-41d4-a716-446655440000";

describe("Recording status webhook handler", () => {
  beforeAll(async () => {
    pgDb = await startPg();
  }, 180_000);

  afterAll(async () => {
    await pgDb?.stop();
  });

  beforeEach(async () => {
    await pgDb.client.query(`TRUNCATE TABLE ${NAMESPACE}.tel_recordings CASCADE`);
    await pgDb.client.query(`TRUNCATE TABLE ${NAMESPACE}.tel_calls CASCADE`);
  });

  it("handles completed status: creates row with state 'received'", async () => {
    const { handleRecordingStatus } = await import("../src/recording-intake.js");
    const dbClient = createMockDbClient(pgDb);
    const mockCtx = createMockCtx({ [COMPANY_UUID_1]: "test-auth-token" });
    const authToken = "test-auth-token";

    const recordingSid = "RE" + "0".repeat(32);
    const callSid = "CA" + "1".repeat(32);
    const { input } = buildSignedRecordingStatusInput(authToken, {
      recordingSid,
      callSid,
      recordingStatus: "completed",
      recordingUrl: "https://api.twilio.com/rec",
      recordingDuration: 120,
    });

    const result = await handleRecordingStatus(mockCtx as PluginContext, dbClient, NAMESPACE, input, PLUGIN_ID);
    expect(result).toBe("ok");

    const rows = await pgDb.client.query(
      `SELECT * FROM ${NAMESPACE}.tel_recordings WHERE recording_sid = $1`,
      [recordingSid],
    );
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0] as any;
    expect(row.state).toBe("received");
    expect(row.company_id).toBe(COMPANY_UUID_1);
    expect(row.twilio_url).toBe("https://api.twilio.com/rec");
    expect(row.last_error).toBeNull();
    expect(row.expires_at).toBeTruthy();
  });

  it("handles failed status: creates row with state 'failed'", async () => {
    const { handleRecordingStatus } = await import("../src/recording-intake.js");
    const dbClient = createMockDbClient(pgDb);
    const mockCtx = createMockCtx({ [COMPANY_UUID_1]: "test-auth-token" });
    const authToken = "test-auth-token";

    const recordingSid = "RE" + "a".repeat(32);
    const callSid = "CA" + "b".repeat(32);
    const { input } = buildSignedRecordingStatusInput(authToken, {
      recordingSid,
      callSid,
      recordingStatus: "failed",
      recordingUrl: "https://api.twilio.com/rec-failed",
    });

    const result = await handleRecordingStatus(mockCtx as PluginContext, dbClient, NAMESPACE, input, PLUGIN_ID);
    expect(result).toBe("ok");

    const rows = await pgDb.client.query(
      `SELECT * FROM ${NAMESPACE}.tel_recordings WHERE recording_sid = $1`,
      [recordingSid],
    );
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0] as any;
    expect(row.state).toBe("failed");
    expect(row.last_error).toBe("twilio recording failed");
  });

  it("handles absent status: creates row with state 'skipped'", async () => {
    const { handleRecordingStatus } = await import("../src/recording-intake.js");
    const dbClient = createMockDbClient(pgDb);
    const mockCtx = createMockCtx({ [COMPANY_UUID_1]: "test-auth-token" });
    const authToken = "test-auth-token";

    const recordingSid = "RE" + "c".repeat(32);
    const callSid = "CA" + "d".repeat(32);
    const { input } = buildSignedRecordingStatusInput(authToken, {
      recordingSid,
      callSid,
      recordingStatus: "absent",
      recordingUrl: "https://api.twilio.com/rec-absent",
    });

    const result = await handleRecordingStatus(mockCtx as PluginContext, dbClient, NAMESPACE, input, PLUGIN_ID);
    expect(result).toBe("ok");

    const rows = await pgDb.client.query(
      `SELECT * FROM ${NAMESPACE}.tel_recordings WHERE recording_sid = $1`,
      [recordingSid],
    );
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0] as any;
    expect(row.state).toBe("skipped");
    expect(row.last_error).toBe("twilio reported no audio (absent)");
  });

  it("ignores in-progress status: no row written", async () => {
    const { handleRecordingStatus } = await import("../src/recording-intake.js");
    const dbClient = createMockDbClient(pgDb);
    const mockCtx = createMockCtx({ [COMPANY_UUID_1]: "test-auth-token" });
    const authToken = "test-auth-token";

    const recordingSid = "RE" + "e".repeat(32);
    const callSid = "CA" + "f".repeat(32);
    const { input } = buildSignedRecordingStatusInput(authToken, {
      recordingSid,
      callSid,
      recordingStatus: "in-progress",
    });

    const result = await handleRecordingStatus(mockCtx as PluginContext, dbClient, NAMESPACE, input, PLUGIN_ID);
    expect(result).toBe("ignored");

    const rows = await pgDb.client.query(
      `SELECT * FROM ${NAMESPACE}.tel_recordings WHERE recording_sid = $1`,
      [recordingSid],
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("handles duplicate webhook: returns 'duplicate', leaves row untouched", async () => {
    const { handleRecordingStatus } = await import("../src/recording-intake.js");
    const dbClient = createMockDbClient(pgDb);
    const mockCtx = createMockCtx({ [COMPANY_UUID_1]: "test-auth-token" });
    const authToken = "test-auth-token";

    const recordingSid = "RE" + "1".repeat(32);
    const callSid = "CA" + "2".repeat(32);
    const { input } = buildSignedRecordingStatusInput(authToken, {
      recordingSid,
      callSid,
      recordingStatus: "completed",
      recordingUrl: "https://api.twilio.com/rec",
    });

    // First webhook
    const result1 = await handleRecordingStatus(mockCtx as PluginContext, dbClient, NAMESPACE, input, PLUGIN_ID);
    expect(result1).toBe("ok");

    // Advance state manually to simulate later processing
    await pgDb.client.query(
      `UPDATE ${NAMESPACE}.tel_recordings SET state = 'downloaded' WHERE recording_sid = $1`,
      [recordingSid],
    );

    // Duplicate webhook (same recording_sid)
    const result2 = await handleRecordingStatus(mockCtx as PluginContext, dbClient, NAMESPACE, input, PLUGIN_ID);
    expect(result2).toBe("duplicate");

    // Verify row is still in 'downloaded' state (not reset)
    const rows = await pgDb.client.query(
      `SELECT state FROM ${NAMESPACE}.tel_recordings WHERE recording_sid = $1`,
      [recordingSid],
    );
    expect(rows.rows).toHaveLength(1);
    expect((rows.rows[0] as any).state).toBe("downloaded");
  });

  it("accepts recording without tel_calls row: stores 'received'", async () => {
    const { handleRecordingStatus } = await import("../src/recording-intake.js");
    const dbClient = createMockDbClient(pgDb);
    const mockCtx = createMockCtx({ [COMPANY_UUID_1]: "test-auth-token" });
    const authToken = "test-auth-token";

    const recordingSid = "RE" + "3".repeat(32);
    const callSid = "CA" + "4".repeat(32);
    const { input } = buildSignedRecordingStatusInput(authToken, {
      recordingSid,
      callSid,
      recordingStatus: "completed",
      recordingUrl: "https://api.twilio.com/rec",
    });

    // No tel_calls row exists
    const callRows = await pgDb.client.query(`SELECT * FROM ${NAMESPACE}.tel_calls WHERE call_sid = $1`, [callSid]);
    expect(callRows.rows).toHaveLength(0);

    // Handle webhook
    const result = await handleRecordingStatus(mockCtx as PluginContext, dbClient, NAMESPACE, input, PLUGIN_ID);
    expect(result).toBe("ok");

    // Verify recording row was created
    const rows = await pgDb.client.query(
      `SELECT * FROM ${NAMESPACE}.tel_recordings WHERE recording_sid = $1`,
      [recordingSid],
    );
    expect(rows.rows).toHaveLength(1);
    expect((rows.rows[0] as any).state).toBe("received");
  });

  it("rejects bad signature: no row written", async () => {
    const { handleRecordingStatus } = await import("../src/recording-intake.js");
    const dbClient = createMockDbClient(pgDb);
    const mockCtx = createMockCtx({ [COMPANY_UUID_1]: "test-auth-token" });

    const recordingSid = "RE" + "5".repeat(32);
    const callSid = "CA" + "6".repeat(32);
    const formBody = `RecordingSid=${recordingSid}&CallSid=${callSid}&RecordingStatus=completed`;
    const badSignature = "bad-signature-value";

    const input = {
      requestId: "test-req-7",
      endpointKey: "recording-status",
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "example.com",
        "x-twilio-signature": badSignature,
      },
      rawBody: formBody,
      parsedBody: {},
    };

    const result = await handleRecordingStatus(
      mockCtx as PluginContext,
      dbClient,
      NAMESPACE,
      input,
      PLUGIN_ID,
    );
    expect(result).toBe("bad_signature");

    const rows = await pgDb.client.query(
      `SELECT * FROM ${NAMESPACE}.tel_recordings WHERE recording_sid = $1`,
      [recordingSid],
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("rejects malformed RecordingSid: returns 'bad_payload', no row", async () => {
    const { handleRecordingStatus } = await import("../src/recording-intake.js");
    const dbClient = createMockDbClient(pgDb);
    const mockCtx = createMockCtx({ [COMPANY_UUID_1]: "test-auth-token" });
    const authToken = "test-auth-token";

    const recordingSid = "INVALID";
    const callSid = "CA" + "7".repeat(32);
    const { input } = buildSignedRecordingStatusInput(authToken, {
      recordingSid,
      callSid,
      recordingStatus: "completed",
    });

    const result = await handleRecordingStatus(mockCtx as PluginContext, dbClient, NAMESPACE, input, PLUGIN_ID);
    expect(result).toBe("bad_payload");

    const rows = await pgDb.client.query(
      `SELECT * FROM ${NAMESPACE}.tel_recordings WHERE recording_sid = $1`,
      [recordingSid],
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("rejects malformed CallSid: returns 'bad_payload', no row", async () => {
    const { handleRecordingStatus } = await import("../src/recording-intake.js");
    const dbClient = createMockDbClient(pgDb);
    const mockCtx = createMockCtx({ [COMPANY_UUID_1]: "test-auth-token" });
    const authToken = "test-auth-token";

    const recordingSid = "RE" + "8".repeat(32);
    const callSid = "INVALID";
    const { input } = buildSignedRecordingStatusInput(authToken, {
      recordingSid,
      callSid,
      recordingStatus: "completed",
    });

    const result = await handleRecordingStatus(mockCtx as PluginContext, dbClient, NAMESPACE, input, PLUGIN_ID);
    expect(result).toBe("bad_payload");

    const rows = await pgDb.client.query(
      `SELECT * FROM ${NAMESPACE}.tel_recordings WHERE recording_sid = $1`,
      [recordingSid],
    );
    expect(rows.rows).toHaveLength(0);
  });
});
