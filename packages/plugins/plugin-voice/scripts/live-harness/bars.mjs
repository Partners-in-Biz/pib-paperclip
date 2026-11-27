#!/usr/bin/env node
// Pass bars 1-7 and the p50/p95 table of one harness run (PAR-15051 plan, "Pass bars"). Pure: `evaluate(run, before)`
// reads only the run record drive.mjs writes (saved "Turn timing" rows, notes, per-question `played` deltas and
// reply text, API checks). CLI: node bars.mjs <run.json> [--before <run.json>] [--md]
import { readFileSync } from "node:fs";

const QUIET_MS = 900; // ENDPOINT_END_QUIET_MS, src/limits.ts
const OUTCOMES = new Set(["voiced", "answered_together", "no_reply", "voice_failed", "sound_blocked", "hung_up_voicing", "talked_over", "not_sent", "not_heard"]);
const GOOD = new Set(["voiced", "answered_together"]);
export const STEPS = ["stt", "stt.provider", "stt.rest", "post", "agent", "detect", "queue", "tts", "tts.provider", "start", "silence", "filler"];

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const diff = (a, b) => (num(a) !== undefined && num(b) !== undefined ? a - b : undefined);

export function nearestRank(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** Same median skew as src/ui/turn-timing.ts `clockSkew`. */
function clockSkew(rows) {
  const s = rows.filter((r) => num(r.serverPostedAt) !== undefined && num(r.postStartAt) !== undefined && num(r.postedAt) !== undefined)
    .map((r) => r.serverPostedAt - (r.postStartAt + r.postedAt) / 2).sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The steps of one row, as src/ui/turn-timing.ts `rowSteps` plus the T1a provider split and the filler. */
export function rowSteps(r, skew) {
  const stt = diff(r.textAt, r.endAt);
  const out = {
    stt,
    "stt.provider": num(r.sttProviderMs),
    "stt.rest": diff(stt, r.sttProviderMs),
    post: diff(r.postedAt, r.textAt),
    agent: diff(r.replyServerAt, r.serverPostedAt),
    detect: num(r.seenAt) !== undefined && num(r.replyServerAt) !== undefined ? Math.max(0, r.seenAt - (r.replyServerAt - skew)) : undefined,
    queue: diff(r.speakStartAt, r.seenAt),
    tts: diff(r.audioAt, r.speakStartAt),
    "tts.provider": num(r.ttsProviderMs),
    start: diff(r.playAt, r.audioAt),
    silence: num(r.playAt) !== undefined ? r.playAt - (r.endKind === "end" ? r.endAt - QUIET_MS : r.endAt) : undefined,
    filler: diff(r.fillerAt, r.endAt),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

export function table(rows) {
  const skew = clockSkew(rows);
  const values = Object.fromEntries(STEPS.map((s) => [s, []]));
  for (const r of rows) for (const [k, v] of Object.entries(rowSteps(r, skew))) values[k].push(v);
  return Object.fromEntries(STEPS.map((s) => {
    const sorted = values[s].sort((a, b) => a - b);
    return [s, { n: sorted.length, p50: nearestRank(sorted, 50), p95: nearestRank(sorted, 95) }];
  }));
}

/** Plugin-side p50: stt + post + detect + tts (bar 4). Null when a step has no value. */
export function pluginP50(t) {
  const parts = ["stt", "post", "detect", "tts"].map((s) => t[s].p50);
  return parts.some((p) => p === null) ? null : parts.reduce((a, b) => a + b, 0);
}

const STATUS_WORDS = { todo: /\bto ?do\b/i, in_progress: /\bin progress\b/i, in_review: /\bin review\b/i, blocked: /\bblocked\b/i, done: /\bdone\b/i, backlog: /\bbacklog\b/i, cancelled: /\bcancell?ed\b/i };

export function evaluate(run, before = null) {
  const rows = run.rows ?? [];
  const questions = run.questions ?? [];
  const notes = (run.notes ?? []).map((n) => (typeof n === "string" ? n : n.text ?? ""));
  const api = run.api ?? {};
  const comments = api.comments ?? [];
  const posted = rows.filter((r) => typeof r.commentId === "string");
  const t = table(rows);
  const bars = [];
  const bar = (n, name, reasons, pass = reasons.length === 0) => bars.push({ bar: n, name, pass, reasons });

  // 1. No silent miss.
  const r1 = [];
  if (posted.length === 0) r1.push("no posted turns");
  for (const r of posted) if (!OUTCOMES.has(r.outcome)) r1.push(`turn ${r.n}: no outcome${num(r.replyServerAt) !== undefined ? " (has a reply)" : ""}`);
  for (const r of rows) {
    if (r.outcome === "voiced" && num(r.playAt) === undefined) r1.push(`turn ${r.n}: voiced without playAt`);
    if (OUTCOMES.has(r.outcome) && !GOOD.has(r.outcome) && !notes.some((x) => x.startsWith(`Turn ${r.n}:`))) r1.push(`turn ${r.n}: ${r.outcome} with no "Turn ${r.n}:" note`);
  }
  const good = rows.filter((r) => GOOD.has(r.outcome)).length;
  const need = Math.max(1, questions.length - 1);
  if (good < need) r1.push(`${good} of ${questions.length} turns voiced or answered_together (need ${need})`);
  bar(1, "No silent miss", r1);

  // 2. Audio really played.
  // Before 0.2.5 no row has an outcome: a row with playAt stands for `voiced`, so the before-run is measured too.
  const r2 = [];
  const hasOutcomes = rows.some((r) => r.outcome !== undefined);
  const voiced = rows.filter((x) => (hasOutcomes ? x.outcome === "voiced" : num(x.playAt) !== undefined));
  for (const r of voiced) {
    const q = questions.find((x) => x.turnN === r.n);
    const want = 1 + (num(r.fillerAt) !== undefined ? 1 : 0);
    if (!q || typeof q.played !== "number") r2.push(`turn ${r.n}: no played delta`);
    else if (q.played < want) r2.push(`turn ${r.n}: played ${q.played}, need ${want}`);
  }
  if (voiced.length === 0) r2.push("no voiced turn to check");
  bar(2, "Audio really played", r2);

  // 3. Filler.
  const r3 = [];
  for (const r of rows) {
    const late = num(r.playAt) === undefined || r.playAt - r.endAt > 4500;
    if (!late) continue;
    if (num(r.fillerAt) === undefined) r3.push(`turn ${r.n}: ${num(r.playAt) === undefined ? "no playAt" : `playAt +${r.playAt - r.endAt} ms`} and no fillerAt`);
    else if (r.fillerAt - r.endAt > 5000) r3.push(`turn ${r.n}: filler at +${r.fillerAt - r.endAt} ms`);
  }
  if (comments.some((c) => /one moment/i.test(c.body ?? ""))) r3.push('a task comment contains "One moment"');
  bar(3, "Filler", r3);

  // 4. Speed: after plugin-side p50 at most 80% of before (same engine, same clips).
  const after = pluginP50(t);
  if (!before) bar(4, "Speed", ["no before run given"], null);
  else {
    const was = pluginP50(table(before.rows ?? []));
    const r4 = [];
    if ((before.meta?.engine ?? null) !== (run.meta?.engine ?? null)) r4.push("before and after engines differ");
    if (after === null || was === null) r4.push("plugin-side p50 missing a step");
    else if (after > 0.8 * was) r4.push(`plugin-side p50 ${after} ms > 80% of ${was} ms`);
    bar(4, "Speed", r4);
  }

  // 5. Provider split present.
  const r5 = [];
  for (const [step, split] of [["stt", "stt.provider"], ["tts", "tts.provider"]]) {
    if (t[step].n === 0) r5.push(`no ${step} rows`);
    else if (t[split].n !== t[step].n) r5.push(`${split} rows ${t[split].n} != ${step} rows ${t[step].n}`);
  }
  bar(5, "Provider split present", r5);

  // 6. Right place.
  const r6 = [];
  const ids = new Set(comments.map((c) => c.id));
  for (const r of posted) if (!ids.has(r.commentId)) r6.push(`turn ${r.n}: comment ${r.commentId} is not on the test task`);
  const footers = comments.filter((c) => c.authorUserId && (c.body ?? "").includes("_Sent by voice:")).length;
  if (footers !== posted.length) r6.push(`${footers} footer comments on the task for ${posted.length} posted turns`);
  if (typeof api.chatCommentsBefore !== "number" || typeof api.chatCommentsAfter !== "number") r6.push("chat with the agent not checked");
  else if (api.chatCommentsAfter !== api.chatCommentsBefore) r6.push(`chat gained ${api.chatCommentsAfter - api.chatCommentsBefore} comments`);
  const runs = api.runs ?? {};
  for (const r of posted.filter((x) => num(x.replyServerAt) !== undefined)) {
    const ok = comments.some((c) => c.authorAgentId && c.createdByRunId && (runs[c.createdByRunId] ?? []).includes(r.commentId));
    if (!ok) r6.push(`turn ${r.n}: no reply from a run its comment woke`);
  }
  bar(6, "Right place", r6);

  // 7. Right topic.
  const r7 = [];
  const reply = (q) => questions.find((x) => x.q === q)?.replyText ?? "";
  if (!/heron/i.test(reply(1))) r7.push('reply to Q1 has no "heron"');
  const status = STATUS_WORDS[api.taskStatus] ?? null;
  if (!status) r7.push(`task status ${api.taskStatus ?? "unknown"} not checkable`);
  else if (!status.test(reply(2).replace(/_/g, " "))) r7.push(`reply to Q2 does not name ${api.taskStatus}`);
  bar(7, "Right topic", r7);

  return { pass: bars.every((b) => b.pass !== false), engine: run.meta?.engine ?? null, turns: rows.length, pluginP50: after, bars, table: t };
}

export function markdown(result) {
  const s = (v) => (v === null ? "-" : `${(v / 1000).toFixed(2)} s`);
  const lines = ["| Step | n | p50 | p95 |", "|---|---|---|---|"];
  for (const [k, v] of Object.entries(result.table)) lines.push(`| ${k} | ${v.n} | ${s(v.p50)} | ${s(v.p95)} |`);
  lines.push("", "| Bar | Result | Why |", "|---|---|---|");
  for (const b of result.bars) lines.push(`| ${b.bar}. ${b.name} | ${b.pass === null ? "n/a" : b.pass ? "PASS" : "FAIL"} | ${b.reasons.join("; ").replace(/\|/g, "/")} |`);
  return lines.join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--before");
  if (!file) {
    console.error("usage: node bars.mjs <run.json> [--before <run.json>] [--md]");
    process.exit(2);
  }
  const read = (f) => JSON.parse(readFileSync(f, "utf8"));
  const bi = args.indexOf("--before");
  const result = evaluate(read(file), bi >= 0 ? read(args[bi + 1]) : null);
  console.log(args.includes("--md") ? markdown(result) : JSON.stringify(result, null, 2));
}
