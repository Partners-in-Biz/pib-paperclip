/**
 * Session id, tokens and cost for a finished Hermes run.
 *
 * Hermes never prints `tokens: N input ... M output` or `cost: $X`, and a
 * regex over the whole output also reads the echoed prompt and the agent's own
 * words ("I've already spent 21 runs" became a 21 USD cost). So:
 *  - the session id is read only from the lines Hermes really prints (stderr
 *    `session_id:`, the "Resume this session with" footer, the `Session:`
 *    footer), after the prompt echo, anchored and validated, last one wins;
 *  - tokens and cost come from Hermes' own session row (state.db, read-only)
 *    after the run, minus what a resumed session had already used before it.
 *
 * Ported from the pib-ops host patch hermes-e2big ([metering]).
 * Upstream: paperclipai/paperclip#6716.
 */

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { UsageSummary } from "@paperclipai/adapter-utils";

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$/;
const SESSION_LINE = /^session_id:\s*(\S+)\s*$/;
const RESUME_LINE = /^\s*hermes\s+(?:-p\s+\S+\s+)?(?:--resume|-r)\s+(\S+)\s*$/;
const RESUME_HEAD = /^Resume this session with:\s*$/;
const SESSION_FOOTER = /^Session:\s{2,}(\S+)\s*$/;
const AGENT_START = /^Initializing agent\.\.\.\s*$/;
const USAGE_COLUMNS = [
  "parent_session_id",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "estimated_cost_usd",
  "actual_cost_usd",
] as const;

export type SessionRow = { id: string } & Partial<Record<(typeof USAGE_COLUMNS)[number], unknown>>;

function lines(text: string | null | undefined): string[] {
  return String(text ?? "").split(/\r?\n/);
}

function lastMatch(all: string[], pattern: RegExp, previous?: RegExp): string | null {
  let found: string | null = null;
  for (let i = 0; i < all.length; i++) {
    const match = pattern.exec(all[i]);
    if (!match || !SESSION_ID.test(match[1])) continue;
    if (previous && !(i > 0 && previous.test(all[i - 1]))) continue;
    found = match[1];
  }
  return found;
}

/** Hermes (default mode) echoes the whole prompt first, then "Initializing agent...". Whatever the prompt quoted is not Hermes talking. */
function afterEcho(text: string): string[] {
  const all = lines(text);
  let at = -1;
  all.forEach((line, i) => {
    if (AGENT_START.test(line)) at = i;
  });
  return at >= 0 ? all.slice(at + 1) : all;
}

/** The session id from what Hermes prints. Never prose. */
export function parseSessionId(stdout: string, stderr: string): string | null {
  const out = afterEcho(stdout);
  return (
    lastMatch(lines(stderr), SESSION_LINE) ??
    lastMatch(out, RESUME_LINE, RESUME_HEAD) ??
    lastMatch(out, SESSION_FOOTER) ??
    lastMatch(out, SESSION_LINE) ??
    null
  );
}

/**
 * Session rows from Hermes' own store, read-only, newest first: the session
 * and its parents (a context compression starts a child session). null when
 * the store cannot be read; [] when it is readable and has no such session.
 */
export async function readSessionLineage(
  env: Record<string, string | undefined>,
  sessionId: string,
  stopAtId?: string,
): Promise<SessionRow[] | null> {
  let db: import("node:sqlite").DatabaseSync | undefined;
  try {
    const home =
      (typeof env.HERMES_HOME === "string" && env.HERMES_HOME) || path.join(env.HOME || os.homedir(), ".hermes");
    const file = path.join(home, "state.db");
    await fsp.access(file);
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(file, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 1000");
    const have = new Set(
      (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (!have.has("id") || !have.has("input_tokens") || !have.has("output_tokens")) return null;
    const columns = ["id", ...USAGE_COLUMNS.filter((column) => have.has(column))];
    const select = db.prepare(`SELECT ${columns.join(", ")} FROM sessions WHERE id = ?`);
    const rows: SessionRow[] = [];
    const seen = new Set<string>();
    for (let id: string | null = sessionId; id && !seen.has(id) && rows.length < 8; ) {
      seen.add(id);
      const row = select.get(id) as SessionRow | undefined;
      if (!row) break;
      rows.push({ ...row });
      if (id === stopAtId) break;
      id = typeof row.parent_session_id === "string" && row.parent_session_id ? row.parent_session_id : null;
    }
    return rows;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // nothing to close
    }
  }
}

const count = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const costKey = (row: SessionRow | null | undefined): "actual_cost_usd" | "estimated_cost_usd" | undefined =>
  (["actual_cost_usd", "estimated_cost_usd"] as const).find((key) => {
    const value = row?.[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  });

/** This run's own usage: the session rows now, minus the baseline row of the resumed session. null when there is nothing to book. */
export function usageFromLineage(
  rows: SessionRow[] | null,
  baseline: SessionRow | null,
): { usage: UsageSummary; costUsd: number | undefined } | null {
  if (!rows || rows.length === 0) return null;
  let used = rows;
  if (baseline) {
    const at = rows.findIndex((row) => row.id === baseline.id);
    used = at >= 0 ? rows.slice(0, at + 1) : rows.slice(0, 1);
  }
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let priced = false;
  for (const row of used) {
    const before = baseline && row.id === baseline.id ? baseline : null;
    const delta = (key: (typeof USAGE_COLUMNS)[number]) => Math.max(0, count(row[key]) - (before ? count(before[key]) : 0));
    input += delta("input_tokens");
    output += delta("output_tokens");
    cacheRead += delta("cache_read_tokens");
    cacheWrite += delta("cache_write_tokens");
    const key = costKey(row);
    if (key) {
      priced = true;
      const previous = before?.[key];
      cost += Math.max(0, (row[key] as number) - (typeof previous === "number" ? previous : 0));
    }
  }
  // Cache writes are input tokens Hermes billed; Paperclip has no field for them, so they count as input.
  const inputTokens = input + cacheWrite;
  if (inputTokens + output + cacheRead <= 0) return null;
  return {
    usage: { inputTokens, outputTokens: output, cachedInputTokens: cacheRead },
    costUsd: priced ? Math.round(cost * 1e6) / 1e6 : undefined,
  };
}

/** Session id (from the printed lines), usage and cost (from Hermes' own session row) for one finished run. */
export async function resolveRun(
  stdout: string,
  stderr: string,
  env: Record<string, string | undefined>,
  baseline: SessionRow | null,
): Promise<{ sessionId: string | null; usage?: UsageSummary; costUsd?: number }> {
  const sessionId = parseSessionId(stdout, stderr);
  let usage: UsageSummary | undefined;
  let costUsd: number | undefined;
  if (sessionId) {
    const rows = await readSessionLineage(env, sessionId, baseline?.id);
    const used = usageFromLineage(rows, baseline);
    if (used) {
      usage = used.usage;
      costUsd = used.costUsd;
    }
  }
  return { sessionId, usage, costUsd };
}
