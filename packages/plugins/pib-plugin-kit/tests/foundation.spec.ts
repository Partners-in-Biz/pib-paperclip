import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { isBalanced, pluginEvent } from "../src/contracts.js";
import { backoffMinutes, enqueue, receiveOnce, redeliver, settleOutbox } from "../src/outbox.js";
import { amountBucket, confidenceOf, decide, isYes, jevEvaluate, shouldAct, type JevQuestions } from "../src/decisions.js";
import { engagementRate, experimentVerdict, featureLifts, rankHypothesisTypes, recordVerdict } from "../src/experiments.js";
import { formatMoneyMinor, pdfSafe, renderDocumentPdf } from "../src/pdf.js";

/** Tiny in-memory stand-in for the host DB, enough for the outbox/inbox/decisions SQL. */
function memoryCtx() {
  const outbox = new Map<string, Record<string, unknown>>();
  const inbox = new Map<string, Record<string, unknown>>();
  const decisions: Array<Record<string, unknown>> = [];
  const emitted: Array<{ event: string; companyId: string; payload: Record<string, unknown> }> = [];
  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    events: { emit: async (event: string, companyId: string, payload: Record<string, unknown>) => void emitted.push({ event, companyId, payload }) },
    db: {
      namespace: "plugin_test_abc",
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes(".outbox") && sql.includes("status = 'pending' AND next_attempt_at")) {
          return [...outbox.values()].filter((r) => r.status === "pending" && (r.due as number) <= Date.now());
        }
        if (sql.includes(".outbox WHERE key = $1")) return outbox.has(String(params[0])) ? [outbox.get(String(params[0]))] : [];
        if (sql.includes(".inbox WHERE key = $1")) return inbox.has(String(params[0])) ? [inbox.get(String(params[0]))] : [];
        return [];
      },
      execute: async (sql: string, params: unknown[] = []) => {
        if (sql.startsWith("INSERT INTO plugin_test_abc.outbox")) {
          const key = String(params[0]);
          if (outbox.has(key)) return { rowCount: 0 };
          outbox.set(key, { key, company_id: params[1], event: params[2], payload: JSON.parse(String(params[3])), status: "pending", attempts: 1, due: Date.now() + 60_000, result: null, last_error: null });
          return { rowCount: 1 };
        }
        if (sql.includes("SET attempts = $2")) {
          const r = outbox.get(String(params[0]))!;
          r.attempts = params[1];
          r.due = Date.now() + 60_000;
          return { rowCount: 1 };
        }
        if (sql.includes("SET status = $2, result")) {
          const r = outbox.get(String(params[0]));
          if (!r || r.status !== "pending") return { rowCount: 0 };
          r.status = params[1];
          r.result = JSON.parse(String(params[2]));
          return { rowCount: 1 };
        }
        if (sql.startsWith("INSERT INTO plugin_test_abc.inbox")) {
          inbox.set(String(params[0]), { result: JSON.parse(String(params[3])) });
          return { rowCount: 1 };
        }
        if (sql.startsWith("INSERT INTO plugin_test_abc.decisions")) {
          decisions.push({ id: params[0], question: params[5], value_text: params[7], value_num: params[8], confidence: params[9], acted: params[12] });
          return { rowCount: 1 };
        }
        return { rowCount: 0 };
      },
    },
  } as unknown as PluginContext;
  return { ctx, outbox, emitted, decisions };
}

describe("contracts", () => {
  it("names plugin events and checks journal balance", () => {
    expect(pluginEvent("partnersinbiz.billing", "ledger.post.requested")).toBe("plugin.partnersinbiz.billing.ledger.post.requested");
    expect(isBalanced([{ role: "ar", debitMinor: 115_00, creditMinor: 0 }, { role: "revenue", debitMinor: 0, creditMinor: 100_00 }, { role: "vat_output", debitMinor: 0, creditMinor: 15_00 }])).toBe(true);
    expect(isBalanced([{ role: "ar", debitMinor: 100, creditMinor: 0 }, { role: "revenue", debitMinor: 0, creditMinor: 99 }])).toBe(false);
    expect(isBalanced([{ role: "ar", debitMinor: 1.5, creditMinor: 0 }, { role: "revenue", debitMinor: 0, creditMinor: 1.5 }])).toBe(false);
  });
});

describe("outbox", () => {
  it("emits once, redelivers until settled, and dedupes on the receiver", async () => {
    const { ctx, outbox, emitted } = memoryCtx();
    expect((await enqueue(ctx, "co", "ledger.post.requested", { key: "k1", memo: "x" })).created).toBe(true);
    expect((await enqueue(ctx, "co", "ledger.post.requested", { key: "k1", memo: "changed" })).created).toBe(false);
    expect(emitted).toHaveLength(1);
    outbox.get("k1")!.due = 0;
    expect((await redeliver(ctx)).emitted).toBe(1);
    expect(emitted).toHaveLength(2);
    expect(await settleOutbox(ctx, "k1", { journalId: "j1" })).not.toBeNull();
    expect(await settleOutbox(ctx, "k1", { journalId: "j1" })).toBeNull();
    outbox.get("k1")!.due = 0;
    expect((await redeliver(ctx)).emitted).toBe(0);

    const handler = vi.fn(async () => ({ journalId: "j1" }));
    expect((await receiveOnce(ctx, "co", "ledger.post.requested", "k1", handler)).repeat).toBe(false);
    expect((await receiveOnce(ctx, "co", "ledger.post.requested", "k1", handler)).repeat).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(backoffMinutes(1)).toBe(1);
    expect(backoffMinutes(99)).toBe(360);
  });
});

describe("decisions", () => {
  const questions: JevQuestions = {
    urgent: { type: "noul", instructions: "Is it urgent?" },
    team: { type: "choice", instructions: "Which team?", criteria: { billing: "Money", tech: "Bugs" } },
  };
  const okResponse = {
    model: "jev-1.13.0",
    answers: {
      urgent: { type: "noul", noul: 0.95 },
      team: { type: "choice", choice: "billing", probabilities: { billing: 0.9, tech: 0.1 }, confidence: 0.85 },
    },
    usage: { input_tokens: 120 },
  };

  it("calls the API with the pinned model and retries 429", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; auth: string }> = [];
    let n = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), auth: String((init.headers as Record<string, string>).authorization) });
      n += 1;
      if (n === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
      return new Response(JSON.stringify(okResponse), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await jevEvaluate({ apiKey: "k" }, { text: "Help" }, questions, { fetchImpl });
    expect(res.answers.team).toMatchObject({ choice: "billing" });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(calls[0]!.body.model).toBe("jev-1.13.0");
    expect(calls[0]!.auth).toBe("Bearer k");
  });

  it("does not retry client errors", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad", { status: 400 })) as unknown as typeof fetch;
    await expect(jevEvaluate({ apiKey: "k" }, "x", questions, { fetchImpl })).rejects.toThrow("400");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reads confidence and thresholds", () => {
    expect(confidenceOf({ type: "noul", noul: 0.95 })).toBeCloseTo(0.9);
    expect(confidenceOf({ type: "noul", noul: 0.5 })).toBe(0);
    expect(isYes({ type: "noul", noul: 0.95 }, "money")).toBe(true);
    expect(isYes({ type: "noul", noul: 0.7 }, "update")).toBe(false);
    expect(shouldAct({ type: "choice", choice: "a", probabilities: {}, confidence: 0.75 }, "update")).toBe(true);
    expect(shouldAct({ type: "choice", choice: "a", probabilities: {}, confidence: 0.75 }, "money")).toBe(false);
    expect(amountBucket(1_234_56)).toBe("R1k–R10k");
  });

  it("logs answers, and returns null without a key or on failure", async () => {
    const { ctx, decisions } = memoryCtx();
    const fetchImpl = (async () => new Response(JSON.stringify(okResponse), { status: 200 })) as unknown as typeof fetch;
    const result = await decide(ctx, "co", { config: { apiKey: "k" }, purpose: "mail.triage", subject: { kind: "message", id: "m1" }, state: "x", questions, acting: ["team"], fetchImpl });
    expect(result?.answers.urgent).toMatchObject({ noul: 0.95 });
    expect(decisions.map((d) => d.question)).toEqual(["urgent", "team"]);
    expect(decisions.find((d) => d.question === "team")!.acted).toBe(true);
    expect(await decide(ctx, "co", { config: null, purpose: "p", subject: { kind: "k", id: "1" }, state: "x", questions })).toBeNull();
    const failing = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    expect(await decide(ctx, "co", { config: { apiKey: "k" }, purpose: "p", subject: { kind: "k", id: "1" }, state: "x", questions, fetchImpl: failing })).toBeNull();
  });
});

describe("experiments", () => {
  it("gives win, loss, no change and inconclusive verdicts", () => {
    expect(experimentVerdict({ control: [1, 1.1, 0.9], variant: [1.4, 1.5, 1.2] }).verdict).toBe("win");
    expect(experimentVerdict({ control: [1, 1.1, 0.9], variant: [0.5, 0.6, 0.7] }).verdict).toBe("loss");
    expect(experimentVerdict({ control: [1, 1.1, 0.9], variant: [1.02, 0.98, 1.05] }).verdict).toBe("no_change");
    expect(experimentVerdict({ control: [1, 1.1], variant: [2, 2, 2] }).verdict).toBe("inconclusive");
  });

  it("explores untried hypothesis types first, then balances reward and tries", () => {
    let board = recordVerdict({}, "hook:question", "win");
    board = recordVerdict(board, "hook:question", "win");
    board = recordVerdict(board, "format:carousel", "loss");
    const ranked = rankHypothesisTypes(board, ["hook:question", "format:carousel", "time:evening"]);
    expect(ranked[0]!.type).toBe("time:evening");
    expect(ranked[1]!.type).toBe("hook:question");
  });

  it("computes engagement rate and feature lifts", () => {
    expect(engagementRate({ likes: 10, comments: 2, reach: 100 })).toBeCloseTo(0.16);
    expect(engagementRate({ likes: 10 })).toBeNull();
    const lifts = featureLifts([
      { lift: 0.5, features: { hook: "question" } },
      { lift: 0.4, features: { hook: "question" } },
      { lift: 0.6, features: { hook: "question" } },
      { lift: -0.2, features: { hook: "claim" } },
    ]);
    expect(lifts).toEqual([{ key: "hook=question", count: 3, medianLift: 0.5 }]);
  });
});

describe("pdf", () => {
  it("renders a multi-page document and cleans text", async () => {
    const bytes = await renderDocumentPdf({
      title: "Tax invoice",
      number: "LUM-001",
      details: [["Date", "2026-09-26"], ["Due", "2026-10-10"]],
      parties: [{ heading: "From", lines: ["Partners in Biz", "VAT 4123456789"] }, { heading: "Bill to", lines: ["Lumen – Ltd"] }],
      columns: [{ key: "d", label: "Description", width: 5 }, { key: "a", label: "Amount", width: 2, align: "right" }],
      rows: Array.from({ length: 80 }, (_, i) => ({ d: `Line ${i} with a “quoted” note`, a: formatMoneyMinor(12_345_00, "ZAR") })),
      totals: [{ label: "Total", value: formatMoneyMinor(12_345_00, "ZAR"), bold: true }],
      sections: [{ heading: "Payment", lines: ["FNB 12345"] }],
      footer: "Partners in Biz",
      stamp: "draft",
    });
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(2000);
    expect(pdfSafe("a – b “c” … €5")).toBe('a - b "c" ... €5');
    expect(formatMoneyMinor(-1_50, "ZAR")).toBe("-R 1.50");
  });
});
