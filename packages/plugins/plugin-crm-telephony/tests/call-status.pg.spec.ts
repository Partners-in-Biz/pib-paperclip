import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NAMESPACE, PLUGIN_ID } from "../src/namespace.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { startPg, embeddedAvailable, type PgDb } from "./helpers/pg.js";
import { createMockDbClient, createMockCtx, buildSignedCallStatusInput } from "./helpers/webhook-mocks.js";
import { handleCallStatus } from "../src/call-status.js";

const available = await embeddedAvailable();

let pgDb: PgDb;
const COMPANY = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_COMPANY = "660e8400-e29b-41d4-a716-446655440001";
const TOKEN = "test-auth-token";
const PARENT = "CA" + "1".repeat(32);
const CHILD = "CA" + "2".repeat(32);

describe.skipIf(!available)("call-status webhook handler", () => {
  beforeAll(async () => {
    pgDb = await startPg();
  }, 180_000);

  afterAll(async () => {
    await pgDb?.stop();
  });

  beforeEach(async () => {
    await pgDb.client.query(`TRUNCATE TABLE ${NAMESPACE}.tel_calls, ${NAMESPACE}.crm_contacts, ${NAMESPACE}.tel_contact_prefs CASCADE`);
  });

  async function seedCall(overrides: Record<string, unknown> = {}) {
    const row = {
      company_id: COMPANY, contact_id: "contact-1", user_id: "user-1", direction: "outbound",
      from_e164: "+27105550100", to_e164: "+27821234567", call_sid: PARENT, status: "initiated", started_at: new Date(), ...overrides,
    };
    const cols = Object.keys(row);
    await pgDb.client.query(
      `INSERT INTO ${NAMESPACE}.tel_calls (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`,
      cols.map((c) => (row as Record<string, unknown>)[c]),
    );
  }

  async function readCall(sid = PARENT) {
    const r = await pgDb.client.query(`SELECT * FROM ${NAMESPACE}.tel_calls WHERE call_sid = $1`, [sid]);
    return r.rows[0] as Record<string, unknown> | undefined;
  }

  type EmitNote = (ctx: PluginContext, namespace: string, callSid: string) => Promise<unknown>;
  function run(params: Parameters<typeof buildSignedCallStatusInput>[1], opts: { token?: string; emitNote?: EmitNote } = {}) {
    const dbClient = createMockDbClient(pgDb);
    const ctx = createMockCtx({ [COMPANY]: TOKEN, [OTHER_COMPANY]: "other-token" }) as PluginContext;
    const { input } = buildSignedCallStatusInput(opts.token ?? TOKEN, params);
    return handleCallStatus(ctx, dbClient, NAMESPACE, input, PLUGIN_ID, { emitNote: opts.emitNote ?? vi.fn(async () => "emitted") });
  }

  it("walks a call through ringing, answered and completed, then emits one note", async () => {
    await seedCall();
    const emitNote = vi.fn(async () => "emitted");

    expect(await run({ callSid: PARENT, callStatus: "ringing" }, { emitNote })).toBe("ok");
    expect((await readCall())?.status).toBe("ringing");

    expect(await run({ callSid: PARENT, callStatus: "in-progress" }, { emitNote })).toBe("ok");
    expect((await readCall())?.status).toBe("connecting");

    expect(await run({ callSid: CHILD, parentCallSid: PARENT, callStatus: "ringing" }, { emitNote })).toBe("ok");
    expect((await readCall())?.status).toBe("ringing");

    expect(await run({ callSid: CHILD, parentCallSid: PARENT, callStatus: "in-progress" }, { emitNote })).toBe("ok");
    let row = await readCall();
    expect(row?.status).toBe("in-progress");
    expect(row?.answered_at).toBeTruthy();

    expect(await run({ callSid: CHILD, parentCallSid: PARENT, callStatus: "completed", callDuration: 130 }, { emitNote })).toBe("ok");
    expect(await run({ callSid: PARENT, callStatus: "completed", callDuration: 150 }, { emitNote })).toBe("ok");
    row = await readCall();
    expect(row?.status).toBe("completed");
    expect(row?.ended_at).toBeTruthy();
    expect(row?.duration_s).toBe(150);
    expect(emitNote).toHaveBeenCalledTimes(1);
    expect(emitNote).toHaveBeenCalledWith(expect.anything(), NAMESPACE, PARENT);

    // Twilio re-sends the final callback: the row has ended, nothing changes, no second note.
    expect(await run({ callSid: PARENT, callStatus: "completed", callDuration: 150 }, { emitNote })).toBe("ignored");
    expect(emitNote).toHaveBeenCalledTimes(1);
  });

  it("keeps the contact's no-answer when the browser leg completes", async () => {
    await seedCall();
    const emitNote = vi.fn(async () => "emitted");
    expect(await run({ callSid: CHILD, parentCallSid: PARENT, callStatus: "no-answer" }, { emitNote })).toBe("ok");
    expect(await run({ callSid: PARENT, callStatus: "completed", callDuration: 31 }, { emitNote })).toBe("ok");
    const row = await readCall();
    expect(row?.status).toBe("no-answer");
    expect(row?.answered_at).toBeNull();
    expect(row?.duration_s).toBe(31);
    expect(emitNote).toHaveBeenCalledTimes(1);
  });

  it("ends the row without a note when no CRM contact owns the number", async () => {
    await seedCall({ contact_id: null });
    const emitNote = vi.fn(async () => "emitted");
    expect(await run({ callSid: PARENT, callStatus: "failed" }, { emitNote })).toBe("ok");
    expect((await readCall())?.status).toBe("failed");
    expect(emitNote).not.toHaveBeenCalled();
  });

  it("rejects a callback signed with another company's token for this company's call", async () => {
    await seedCall();
    // Signed by OTHER_COMPANY's token: the row belongs to COMPANY, so the lookup finds nothing.
    expect(await run({ callSid: PARENT, callStatus: "completed", callDuration: 10 }, { token: "other-token" })).toBe("unknown_call");
    expect((await readCall())?.status).toBe("initiated");
  });

  it("rejects a bad signature and a malformed payload", async () => {
    await seedCall();
    expect(await run({ callSid: PARENT, callStatus: "completed" }, { token: "wrong" })).toBe("bad_signature");
    expect(await run({ callSid: "CAnotasid", callStatus: "completed" })).toBe("bad_payload");
  });

  it("ignores a child leg whose parent is unknown and a status for a call nobody placed", async () => {
    expect(await run({ callSid: CHILD, parentCallSid: PARENT, callStatus: "ringing" })).toBe("unknown_call");
    expect(await run({ callSid: PARENT, callStatus: "ringing", direction: "outbound-api", to: "client:user-1" })).toBe("unknown_call");
  });

  it("records an inbound call to the company number and matches the contact", async () => {
    await pgDb.client.query(
      `INSERT INTO ${NAMESPACE}.crm_contacts (id, company_id, name, phones, updated_at) VALUES ('contact-9', $1, 'Thandi', ARRAY['082 999 8888'], now())`,
      [COMPANY],
    );
    const INBOUND = "CA" + "3".repeat(32);
    expect(await run({ callSid: INBOUND, callStatus: "ringing", direction: "inbound", from: "+27829998888", to: "+27105550100" })).toBe("ok");
    const row = await readCall(INBOUND);
    expect(row?.direction).toBe("inbound");
    expect(row?.contact_id).toBe("contact-9");
    expect(row?.status).toBe("ringing");
    const emitNote = vi.fn(async () => "emitted");
    expect(await run({ callSid: INBOUND, callStatus: "completed", callDuration: 40, direction: "inbound", from: "+27829998888", to: "+27105550100" }, { emitNote })).toBe("ok");
    expect(emitNote).toHaveBeenCalledWith(expect.anything(), NAMESPACE, INBOUND);
  });
});
