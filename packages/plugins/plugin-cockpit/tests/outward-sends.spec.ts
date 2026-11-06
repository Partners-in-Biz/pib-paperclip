/**
 * Tier A client sends (PAR-7868): brief section, info cards (14 days, dismissable), client_send:ungated.
 */
import { describe, expect, it } from "vitest";
import {
  clientSendChecks,
  dismissInfoCard,
  infoCardItems,
  outwardSendsBrief,
  parseOutwardSend,
  readOutwardSends,
  ungatedCheck,
  type GateComment,
  type OutwardSend,
} from "../src/outward-sends.js";
import type { Env } from "../src/env.js";

const NOW = new Date("2026-11-06T10:00:00Z");
const send = (over: Partial<OutwardSend> = {}): OutwardSend => ({
  commentId: "c1", issueId: "i1", identifier: "PAR-100", issueTitle: "Acme site", at: "2026-11-06T08:00:00Z",
  to: "Acme (Jo)", channel: "email", what: "sign-off request for the homepage text", ref: "PAR-100", ...over,
});

describe("parseOutwardSend", () => {
  it("reads the four fields", () => {
    expect(parseOutwardSend("OUTWARD SEND (Tier A): to Acme (Jo) | email | status update | PAR-100")).toEqual({ to: "Acme (Jo)", channel: "email", what: "status update", ref: "PAR-100" });
  });
  it("ignores other comments", () => {
    expect(parseOutwardSend("I will send an OUTWARD SEND (Tier A): later")).toBeNull();
  });
});

describe("brief section", () => {
  it("lists last 24h sends with a count", () => {
    const brief = outwardSendsBrief([send(), send({ commentId: "c2", at: "2026-11-04T08:00:00Z" })], NOW);
    expect(brief.count).toBe(1);
    expect(brief.lines[0]!.line).toBe("PAR-100 | Acme (Jo) | email | sign-off request for the homepage text");
  });
});

describe("ungated rule", () => {
  const gate = (body: string, at = "2026-11-06T07:00:00Z"): GateComment => ({ issueId: "i1", body, at });
  it("fires on a text send with no Reviewer approval", () => {
    const check = ungatedCheck([send()], []);
    expect(check?.key).toBe("client_send:ungated");
    expect(check?.status).toBe("bad");
  });
  it("passes a text send with REVIEW: PASS before it", () => {
    expect(ungatedCheck([send()], [gate("REVIEW: PASS sha=abcdef123456 ci=green")])).toBeNull();
  });
  it("a visual send needs VISUAL GATE: APPROVE, a Reviewer PASS is not enough", () => {
    const visual = send({ what: "banner image for sign-off" });
    expect(ungatedCheck([visual], [gate("REVIEW: PASS")])?.key).toBe("client_send:ungated");
    expect(ungatedCheck([visual], [gate("VISUAL GATE: APPROVE")])).toBeNull();
  });
  it("an approval that came after the send does not count", () => {
    expect(ungatedCheck([send()], [gate("REVIEW: PASS", "2026-11-06T09:00:00Z")])?.key).toBe("client_send:ungated");
  });
});

describe("info cards", () => {
  it("one card per send, none after the window, none once dismissed", () => {
    const base = { now: NOW, dismissed: [] as string[] };
    const cards = infoCardItems([send()], { ...base, until: NOW.getTime() + 1000 });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ key: "outward-send:c1", kind: "other", href: "/issues/PAR-100" });
    expect(infoCardItems([send()], { ...base, until: NOW.getTime() })).toHaveLength(0);
    expect(infoCardItems([send()], { ...base, until: NOW.getTime() + 1000, dismissed: ["c1"] })).toHaveLength(0);
  });
});

function fakeEnv(rows: { sends: Record<string, unknown>[]; gates: Record<string, unknown>[] }, config: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>();
  const k = (key: { stateKey: string }) => key.stateKey;
  const env = {
    now: () => NOW,
    ctx: {
      db: { query: async (sql: string) => (sql.includes("SELECT c.id") ? rows.sends : rows.gates) },
      state: { get: async (key: { stateKey: string }) => store.get(k(key)) ?? null, set: async (key: { stateKey: string }, v: unknown) => void store.set(k(key), v) },
      config: { get: async () => config },
      logger: { info: () => undefined },
    },
  } as unknown as Env;
  return { env, store };
}

describe("end to end over seeded comments", () => {
  const seeded = {
    sends: [{ id: "c1", issue_id: "i1", body: "OUTWARD SEND (Tier A): to Acme | email | status update | PAR-100", created_at: "2026-11-06T08:00:00Z", identifier: "PAR-100", title: "Acme" }],
    gates: [],
  };
  it("reads the seeded comment, flags it ungated, makes a card, and the card can be dismissed", async () => {
    const { env } = fakeEnv(seeded);
    const read = await readOutwardSends(env, "co", "2026-11-05T10:00:00Z");
    expect(read.sends).toHaveLength(1);
    const first = await clientSendChecks(env, "co");
    expect(first.health.map((h) => h.key)).toEqual(["client_send:ungated"]);
    expect(first.waiting.map((w) => w.key)).toEqual(["outward-send:c1"]);
    await dismissInfoCard(env, "co", "outward-send:c1");
    const second = await clientSendChecks(env, "co");
    expect(second.waiting).toHaveLength(0);
    expect(second.health).toHaveLength(1);
  });
  it("config clientSends.infoCardsUntil in the past stops the cards", async () => {
    const { env } = fakeEnv(seeded, { clientSends: { infoCardsUntil: "2026-11-01T00:00:00Z" } });
    expect((await clientSendChecks(env, "co")).waiting).toHaveLength(0);
  });
});
