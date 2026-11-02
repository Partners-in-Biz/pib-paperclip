/** Attention counts line in the push digest (PAR-7133): owner company only, seeded push_log and asks rows. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { attentionLine, countAttention } from "../src/push/attention.js";
import { runPushDigestForCompany } from "../src/push/digest.js";
import { appendPushLog, upsertSubscription, type PushSubscription } from "../src/push/store.js";
import * as sendModule from "../src/push/send.js";
import type { SendResult } from "../src/push/send.js";
import { NAMESPACE } from "../src/namespace.js";
import { COMPANY, OTHER_COMPANY, embeddedAvailable, startPg } from "./helpers/pg.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;
const NOW = new Date("2026-10-20T02:00:00Z");

describe("attentionLine", () => {
  it("formats and pluralises", () => {
    expect(attentionLine({ needsYou: 3, other: 2, openAsks: 1 })).toBe("Last 24h: 3 need you, 2 other · 1 open ask");
    expect(attentionLine({ needsYou: 0, other: 0, openAsks: 0 })).toBe("Last 24h: 0 need you, 0 other · 0 open asks");
  });
});

d("push digest attention line (Postgres)", () => {
  let pg: Awaited<ReturnType<typeof startPg>>;
  beforeAll(async () => {
    pg = await startPg();
    const log = (companyId: string, cls: string, status: "sent" | "deferred", at: string) =>
      appendPushLog(pg.ctx, { companyId, class: cls, status, createdAt: new Date(at) });
    const recent = "2026-10-19T20:00:00Z";
    await log(COMPANY, "needs_you", "sent", recent);
    await log(COMPANY, "needs_you", "sent", recent);
    await log(COMPANY, "critical", "sent", recent);
    await log(COMPANY, "digest", "sent", recent); // not an item
    await log(COMPANY, "needs_you", "sent", "2026-10-18T20:00:00Z"); // older than 24 h
    await log(COMPANY, "needs_you", "deferred", recent); // not sent
    await log(OTHER_COMPANY, "needs_you", "sent", recent);
    await log(OTHER_COMPANY, "critical", "sent", recent);
    await log(COMPANY, "needs_you", "deferred", "2026-10-19T23:00:00Z"); // makes the digest fire
    const ask = (id: string, companyId: string, status: string) =>
      pg.ctx.db.execute(`INSERT INTO ${NAMESPACE}.asks (id, company_id, issue_id, question, status) VALUES ($1, $2, $3, 'q', $4)`, [id, companyId, id, status]);
    await ask("a1", COMPANY, "open");
    await ask("a2", COMPANY, "open");
    await ask("a3", COMPANY, "resolved");
    await ask("a4", OTHER_COMPANY, "open");
    await upsertSubscription(pg.ctx, { companyId: COMPANY, userId: "u", endpoint: "https://fcm.googleapis.com/fcm/send/att-1", p256dh: "p", auth: "a", deviceLabel: "Phone" });
    await upsertSubscription(pg.ctx, { companyId: OTHER_COMPANY, userId: "u", endpoint: "https://fcm.googleapis.com/fcm/send/att-2", p256dh: "p", auth: "a", deviceLabel: "Phone" });
    await log(OTHER_COMPANY, "needs_you", "deferred", "2026-10-19T23:00:00Z");
  }, 120_000);
  afterAll(async () => {
    await pg?.stop();
  });

  it("counts one company's sent pushes (24 h) and open asks; others ignored", async () => {
    expect(await countAttention(pg.ctx, COMPANY, NOW)).toEqual({ needsYou: 2, other: 1, openAsks: 2 });
    expect(await countAttention(pg.ctx, OTHER_COMPANY, NOW)).toEqual({ needsYou: 1, other: 1, openAsks: 1 });
  });

  async function digestBody(companyId: string, owner: boolean): Promise<string | undefined> {
    const ctx = Object.create(pg.ctx, { companies: { value: { get: async () => ({ issuePrefix: owner ? "PAR" : "XYZ" }) } } });
    let body: string | undefined;
    const spy = vi.spyOn(sendModule, "sendPush").mockImplementation(async (_c, _id, subs: PushSubscription[], payload) => {
      body = payload.body;
      return { disabled: false, capped: false, devices: subs.map((s) => ({ endpoint: s.endpoint, label: s.deviceLabel, outcome: "sent" as const })) } as SendResult;
    });
    try {
      await runPushDigestForCompany(ctx, companyId, { deps: { now: () => NOW } });
    } finally {
      spy.mockRestore();
    }
    return body;
  }

  it("owner company digest carries the line", async () => {
    expect(await digestBody(COMPANY, true)).toBe("Items waiting for you to review\nLast 24h: 2 need you, 1 other · 2 open asks");
  });

  it("non-owner company digest body is unchanged", async () => {
    expect(await digestBody(OTHER_COMPANY, false)).toBe("Items waiting for you to review");
  });
});
