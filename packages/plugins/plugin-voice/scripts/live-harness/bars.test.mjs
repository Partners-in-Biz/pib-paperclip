// node --test packages/plugins/plugin-voice/scripts/live-harness/
import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, markdown } from "./bars.mjs";
import { MIN_LEVEL, normalise, speechLevels } from "./clips.mjs";

const T0 = 1_800_000_000_000;

/** One 16-turn run. `slow` stretches the plugin-side steps (the before-run); `v023` drops every 0.2.5+ field. */
function fixture({ v023 = false, slow = 1 } = {}) {
  const rows = [];
  const questions = [];
  const comments = [];
  const runs = {};
  for (let n = 1; n <= 16; n += 1) {
    const endAt = T0 + n * 60_000;
    const late = n % 4 === 0; // every fourth reply is slow and needs the filler
    const textAt = endAt + 1200 * slow;
    const postedAt = textAt + 300 * slow;
    const seenAt = postedAt + (late ? 5000 : 1500);
    const audioAt = seenAt + 50 + 900 * slow;
    const playAt = audioAt + 40;
    const commentId = `turn-${n}`;
    const row = {
      n, startAt: endAt - 2500, endAt, endKind: "end", textAt, postStartAt: textAt, postedAt, serverPostedAt: postedAt - 150,
      commentId, replyServerAt: seenAt - 400, finalServerAt: seenAt - 400, replyComments: 1, seenAt, via: "poll",
      speakStartAt: seenAt + 50, audioAt, playAt, provider: "gemini",
    };
    if (!v023) Object.assign(row, { outcome: "voiced", sttProviderMs: 700, ttsProviderMs: 600, ...(late ? { fillerAt: endAt + 4000 } : {}) });
    rows.push(row);
    questions.push({
      q: n, turnN: n, played: v023 ? 1 : late ? 3 : 2,
      replyText: n === 1 ? "The code word is heron." : n === 2 ? "This task is in to do." : "Short answer.",
    });
    if (!v023) {
      comments.push({ id: commentId, body: `Question ${n}\n\n_Sent by voice: reply in short spoken sentences._`, authorUserId: "board", authorAgentId: null, createdByRunId: null });
      comments.push({ id: `reply-${n}`, body: "Answer.", authorUserId: null, authorAgentId: "pib", createdByRunId: `run-${n}` });
      runs[`run-${n}`] = [commentId];
    }
  }
  return {
    meta: { engine: "gemini" },
    rows,
    notes: [],
    questions,
    api: { taskStatus: "todo", comments, runs, chatCommentsBefore: 3, chatCommentsAfter: v023 ? 35 : 3 },
  };
}

const byBar = (result) => Object.fromEntries(result.bars.map((b) => [b.bar, b.pass]));

test("a 0.2.3-shaped run fails bars 1, 3, 5 and 6", () => {
  const result = evaluate(fixture({ v023: true }));
  const bars = byBar(result);
  for (const n of [1, 3, 5, 6]) assert.equal(bars[n], false, `bar ${n} should fail`);
  assert.equal(bars[4], null); // the before-run has no before
  assert.equal(bars[2], true); // no outcomes yet: rows with playAt are checked as voiced
  assert.equal(bars[7], true);
  assert.equal(result.pass, false);
  assert.match(result.bars[0].reasons.join(" "), /turn 1: no outcome \(has a reply\)/);
});

test("a good run passes all 7 bars against a slower before-run", () => {
  const result = evaluate(fixture(), fixture({ v023: true, slow: 2 }));
  assert.deepEqual(byBar(result), { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true, 7: true }, JSON.stringify(result.bars));
  assert.equal(result.pass, true);
  assert.equal(result.table.stt.p50, 1200);
  assert.equal(result.table["stt.rest"].p50, 500);
  assert.equal(result.table.filler.n, 4);
  assert.match(markdown(result), /\| 7\. Right topic \| PASS \|/);
});

test("each bar can fail on an otherwise good run", () => {
  const cases = {
    1: (r) => { r.rows[3].outcome = "no_reply"; }, // a miss with no "Turn 4:" note
    2: (r) => { r.questions[3].played = 1; }, // filler set, so 2 starts are needed
    3: (r) => { r.rows[3].fillerAt = r.rows[3].endAt + 5200; },
    5: (r) => { delete r.rows[0].ttsProviderMs; },
    6: (r) => { r.api.runs["run-5"] = []; },
    7: (r) => { r.questions[0].replyText = "I could not find one."; },
  };
  for (const [bar, breakIt] of Object.entries(cases)) {
    const run = fixture();
    breakIt(run);
    assert.equal(byBar(evaluate(run, fixture({ v023: true, slow: 2 })))[bar], false, `bar ${bar}`);
  }
  assert.equal(byBar(evaluate(fixture(), fixture()))[4], false); // not faster than before
});

test("a miss with its Turn n: note keeps bar 1 as long as 15 of 16 are voiced", () => {
  const run = fixture();
  run.rows[3].outcome = "no_reply";
  run.notes = ["Turn 4: no reply before the call ended."];
  assert.equal(byBar(evaluate(run))[1], true);
});

test("normalise lifts a quiet clip above level 0.2 in every speech frame", () => {
  const quiet = new Float32Array(24_000 * 2);
  for (let i = 0; i < quiet.length; i += 1) {
    const envelope = i < 4800 ? 0 : 0.01 * (1 + 0.5 * Math.sin(i / 3000));
    quiet[i] = envelope * Math.sin((2 * Math.PI * 220 * i) / 24_000);
  }
  assert.ok(speechLevels(quiet)[0] < 0.05);
  const out = normalise(quiet);
  assert.ok(out.p10 > MIN_LEVEL, `p10 ${out.p10}`);
  assert.ok(Math.max(...out.samples) <= 0.98);
});
