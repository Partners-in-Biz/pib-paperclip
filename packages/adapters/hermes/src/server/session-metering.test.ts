import { DatabaseSync } from "node:sqlite";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseSessionId,
  readSessionLineage,
  resolveRun,
  usageFromLineage,
  type SessionRow,
} from "./session-metering.js";

let home: string;

beforeEach(async () => {
  home = await fsp.mkdtemp(path.join(os.tmpdir(), "par6886-meter-"));
});

afterEach(async () => {
  await fsp.rm(home, { recursive: true, force: true });
});

function makeStore(rows: Array<Record<string, unknown>>, columns?: string[]) {
  const cols = columns ?? [
    "id",
    "parent_session_id",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "estimated_cost_usd",
    "actual_cost_usd",
  ];
  const db = new DatabaseSync(path.join(home, "state.db"));
  db.exec(`CREATE TABLE sessions (${cols.map((c) => (c === "id" || c === "parent_session_id" ? `${c} TEXT` : `${c} REAL`)).join(", ")})`);
  for (const row of rows) {
    const keys = Object.keys(row).filter((key) => cols.includes(key));
    db.prepare(`INSERT INTO sessions (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(
      ...(keys.map((key) => row[key]) as Array<string | number | null>),
    );
  }
  db.close();
}

describe("parseSessionId", () => {
  it("reads the stderr session_id line (-Q)", () => {
    expect(parseSessionId("answer", "noise\nsession_id: 20261101_abc123\n")).toBe("20261101_abc123");
  });

  it("reads the Resume footer and the Session: footer after the prompt echo", () => {
    const resume = "Initializing agent...\nanswer\nResume this session with:\n  hermes --resume 20261101_def456\n";
    expect(parseSessionId(resume, "")).toBe("20261101_def456");
    const footer = "Initializing agent...\nanswer\nSession:        20261101_ghi789\n";
    expect(parseSessionId(footer, "")).toBe("20261101_ghi789");
  });

  it("ignores ids quoted in the echoed prompt or in prose, and invalid ids", () => {
    const echoed = "Prompt says:\nsession_id: quotedFromPrompt1\nInitializing agent...\nI will not print one.\n";
    expect(parseSessionId(echoed, "")).toBeNull();
    expect(parseSessionId("the session_id: abc123456 was fine", "")).toBeNull();
    expect(parseSessionId("", "session_id: x\n")).toBeNull();
  });

  it("the last stderr line wins", () => {
    expect(parseSessionId("", "session_id: first_id_1\nsession_id: second_id_2\n")).toBe("second_id_2");
  });
});

describe("usageFromLineage", () => {
  const row = (id: string, extra: Record<string, unknown> = {}): SessionRow => ({ id, ...extra });

  it("returns null when nothing was used", () => {
    expect(usageFromLineage(null, null)).toBeNull();
    expect(usageFromLineage([], null)).toBeNull();
    expect(usageFromLineage([row("a", { input_tokens: 0, output_tokens: 0 })], null)).toBeNull();
  });

  it("books cache writes as input and prefers the actual cost", () => {
    const used = usageFromLineage(
      [row("a", { input_tokens: 100, output_tokens: 20, cache_read_tokens: 5, cache_write_tokens: 7, estimated_cost_usd: 0.5, actual_cost_usd: 0.4 })],
      null,
    );
    expect(used).toEqual({ usage: { inputTokens: 107, outputTokens: 20, cachedInputTokens: 5 }, costUsd: 0.4 });
  });

  it("subtracts what a resumed session had already used", () => {
    const baseline = row("a", { input_tokens: 100, output_tokens: 10, estimated_cost_usd: 0.1 });
    const now = row("a", { input_tokens: 130, output_tokens: 25, estimated_cost_usd: 0.15 });
    const used = usageFromLineage([now], baseline)!;
    expect(used.usage).toEqual({ inputTokens: 30, outputTokens: 15, cachedInputTokens: 0 });
    expect(used.costUsd).toBeCloseTo(0.05, 6);
  });

  it("adds child sessions started by a context compression and stops at the resumed one", () => {
    const baseline = row("a", { input_tokens: 100, output_tokens: 10 });
    const rows = [
      row("c", { parent_session_id: "b", input_tokens: 5, output_tokens: 1 }),
      row("b", { parent_session_id: "a", input_tokens: 7, output_tokens: 2 }),
      row("a", { input_tokens: 110, output_tokens: 13 }),
    ];
    expect(usageFromLineage(rows, baseline)!.usage).toEqual({ inputTokens: 22, outputTokens: 6, cachedInputTokens: 0 });
  });

  it("leaves costUsd undefined when the store has no price", () => {
    expect(usageFromLineage([row("a", { input_tokens: 1, output_tokens: 1 })], null)!.costUsd).toBeUndefined();
  });
});

describe("readSessionLineage", () => {
  it("returns null when the store is missing or has an unknown shape", async () => {
    expect(await readSessionLineage({ HERMES_HOME: home }, "abc123456")).toBeNull();
    makeStore([{ id: "abc123456" }], ["id"]);
    expect(await readSessionLineage({ HERMES_HOME: home }, "abc123456")).toBeNull();
  });

  it("returns [] when the store is readable but the session is gone, and the row chain otherwise", async () => {
    makeStore([
      { id: "parent_01", input_tokens: 10, output_tokens: 1 },
      { id: "child_001", parent_session_id: "parent_01", input_tokens: 3, output_tokens: 1 },
    ]);
    expect(await readSessionLineage({ HERMES_HOME: home }, "missing_id")).toEqual([]);
    const rows = await readSessionLineage({ HERMES_HOME: home }, "child_001");
    expect(rows?.map((r) => r.id)).toEqual(["child_001", "parent_01"]);
    const stopped = await readSessionLineage({ HERMES_HOME: home }, "child_001", "child_001");
    expect(stopped?.map((r) => r.id)).toEqual(["child_001"]);
  });

  it("does not loop on a parent cycle", async () => {
    makeStore([
      { id: "loop_aaa", parent_session_id: "loop_bbb", input_tokens: 1, output_tokens: 1 },
      { id: "loop_bbb", parent_session_id: "loop_aaa", input_tokens: 1, output_tokens: 1 },
    ]);
    const rows = await readSessionLineage({ HERMES_HOME: home }, "loop_aaa");
    expect(rows?.map((r) => r.id)).toEqual(["loop_aaa", "loop_bbb"]);
  });
});

describe("resolveRun", () => {
  it("never reads prose as cost and books only this run when resuming", async () => {
    makeStore([{ id: "sess_0001", input_tokens: 150, output_tokens: 30, estimated_cost_usd: 0.3 }]);
    const baseline: SessionRow = { id: "sess_0001", input_tokens: 100, output_tokens: 10, estimated_cost_usd: 0.1 };
    const run = await resolveRun(
      "Initializing agent...\nI've already spent 21 runs, cost: $21.00\n",
      "session_id: sess_0001\n",
      { HERMES_HOME: home },
      baseline,
    );
    expect(run.sessionId).toBe("sess_0001");
    expect(run.usage).toEqual({ inputTokens: 50, outputTokens: 20, cachedInputTokens: 0 });
    expect(run.costUsd).toBeCloseTo(0.2, 6);
  });

  it("returns the session but no usage when the store cannot be read", async () => {
    const run = await resolveRun("", "session_id: sess_0002\n", { HERMES_HOME: home }, null);
    expect(run).toEqual({ sessionId: "sess_0002", usage: undefined, costUsd: undefined });
  });
});
