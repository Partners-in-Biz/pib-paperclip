#!/usr/bin/env node
// Drives one scripted Direct voice call on the test task through a logged-in Chrome (see README.md).
// Env: HARNESS_CDP_URL, HARNESS_BASE_URL, HARNESS_TASK (e.g. PAR-123), HARNESS_ENGINE (gemini|grok),
// optional HARNESS_QUESTIONS (count), HARNESS_CHAT_ISSUE (chat issue id for bar 6), HARNESS_CLIPS_DIR, HARNESS_OUT.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate as bars, markdown } from "./bars.mjs";
import { connectPage, sleep, waitFor } from "./cdp.mjs";
import { decodePcm16, encodePcm16, normalise } from "./clips.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const env = (k, d) => process.env[k] ?? d ?? (() => { throw new Error(`set ${k}`); })();
const BASE = env("HARNESS_BASE_URL").replace(/\/$/, "");
const TASK = env("HARNESS_TASK");
const ENGINE = env("HARNESS_ENGINE");
if (ENGINE !== "gemini" && ENGINE !== "grok") throw new Error("HARNESS_ENGINE is gemini or grok");
const QUESTIONS = JSON.parse(readFileSync(join(here, "questions.json"), "utf8")).slice(0, Number(env("HARNESS_QUESTIONS", "16")));
const WORK = process.env.PAPERCLIP_TMPDIR ?? process.cwd();
const CLIPS = env("HARNESS_CLIPS_DIR", join(WORK, "voice-harness-clips"));
const OUT = env("HARNESS_OUT", join(WORK, `voice-harness-${ENGINE}-${Date.now()}.json`));
const CHAT = process.env.HARNESS_CHAT_ISSUE ?? null;
const TURN_CAP_MS = 180_000;
const PLUGIN = "partnersinbiz.voice";
const PREFIX = "pib-voice:transcript:";
const PANEL = '[role="dialog"][aria-label="Live voice"]';

const page = await connectPage(env("HARNESS_CDP_URL"));
await page.send("Page.enable");
await page.send("Runtime.enable");
await page.send("Page.addScriptToEvaluateOnNewDocument", { source: readFileSync(join(here, "fake-mic.js"), "utf8") });
await page.send("Page.navigate", { url: `${BASE}/${TASK.split("-")[0]}/issues/${TASK}` });
if (!(await waitFor(() => page.evaluate(`!!document.querySelector('[data-pib-voice="live"]')`), 60_000))) throw new Error("no live voice button on the task page");

const api = (method, path, body) =>
  page.evaluate(`fetch(${JSON.stringify(`/api${path}`)}, { method: ${JSON.stringify(method)}, credentials: "include",
    headers: { "Content-Type": "application/json" }, body: ${body === undefined ? "undefined" : JSON.stringify(JSON.stringify(body))} })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))`);
const ok = async (method, path, body) => {
  const res = await api(method, path, body);
  if (res.status >= 400) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(res.body)?.slice(0, 200)}`);
  return res.body;
};
const action = async (companyId, key, params) => (await ok("POST", `/plugins/${PLUGIN}/actions/${key}`, { companyId, params })).data;

const session = await api("GET", "/auth/get-session");
const boardAccount = session.body?.user?.email ?? session.body?.user?.id ?? null;
if (!boardAccount) throw new Error("the CDP browser is not logged in to the board");
const issue = await ok("GET", `/issues/${TASK}`);
if (!issue.assigneeAgentId) throw new Error(`${TASK} has no assignee agent`);

// Clips: made once with the plugin's speak action, normalised, cached and reused by every run.
mkdirSync(CLIPS, { recursive: true });
for (const [i, text] of QUESTIONS.entries()) {
  const file = join(CLIPS, `q${i + 1}-${createHash("sha256").update(text).digest("hex").slice(0, 8)}.json`);
  if (!existsSync(file)) {
    const out = await action(issue.companyId, "speak", { agentId: issue.assigneeAgentId, text, provider: "grok" });
    if (!out?.audio) throw new Error(`clip ${i + 1}: speak answered ${JSON.stringify(out)}`);
    const n = normalise(decodePcm16(out.audio));
    writeFileSync(file, JSON.stringify({ text, sampleRate: out.sampleRate, median: n.median, p10: n.p10, pcm16: encodePcm16(n.samples) }));
  }
  const clip = JSON.parse(readFileSync(file, "utf8"));
  await page.evaluate(`window.__voiceHarness.load(${i}, ${JSON.stringify({ sampleRate: clip.sampleRate, pcm16: clip.pcm16 })})`);
}

const chatCount = async () => (CHAT ? (await ok("GET", `/issues/${CHAT}/comments?limit=500`)).length : undefined);
const chatCommentsBefore = await chatCount();
await action(issue.companyId, "set-my-voice-mode", { mode: "direct", provider: ENGINE });
await page.evaluate(`localStorage.setItem("pib-voice:interrupt-by-talking", "off")`);
const keysBefore = await page.evaluate(`Object.keys(localStorage).filter((k) => k.startsWith(${JSON.stringify(PREFIX)}))`);
const label = () => page.evaluate(`document.querySelector('${PANEL} [aria-live="polite"]')?.textContent?.trim() ?? null`);
const played = () => page.evaluate("window.__voiceHarness.played");
const now = () => page.evaluate("Date.now()");
const buffer = () =>
  page.evaluate(`(() => {
    const before = new Set(${JSON.stringify(keysBefore)});
    const key = Object.keys(localStorage).filter((k) => k.startsWith(${JSON.stringify(PREFIX)}) && !before.has(k)).sort().pop();
    return key ? { key: key.slice(${PREFIX.length}), ...JSON.parse(localStorage.getItem(key)) } : null;
  })()`);

await page.click('[data-pib-voice="live"]'); // a trusted click: the plugin's AudioContext and soundReady() need it
if ((await waitFor(async () => (await label()) === "Listening", 60_000)) === null) throw new Error(`panel never listened (label ${await label()})`);

const questions = [];
let lastN = 0;
for (const [i, text] of QUESTIONS.entries()) {
  await waitFor(async () => (await label()) === "Listening", TURN_CAP_MS);
  const playedBefore = await played();
  const sayAt = await now();
  await page.evaluate(`window.__voiceHarness.say(${i})`);
  let row = null;
  let endedBy = "cap";
  // Ends on the row's outcome (0.2.5+); on 0.2.3 (no outcome) on playAt, a reply plus 30 s, or the 180 s cap.
  await waitFor(async () => {
    const t = await now();
    row = (await buffer())?.turns?.find((r) => r.n > lastN) ?? null;
    if (row?.outcome) endedBy = "outcome";
    else if (row?.playAt) endedBy = "playAt";
    else if (row?.seenAt && t - row.seenAt > 30_000) endedBy = "reply+30s";
    else return t - sayAt > TURN_CAP_MS;
    return true;
  }, TURN_CAP_MS + 5_000, 500);
  await sleep(1_000);
  const entries = (await buffer())?.entries ?? [];
  if (row) lastN = row.n;
  questions.push({
    q: i + 1, text, turnN: row?.n ?? null, sayAt, endedBy, played: (await played()) - playedBefore,
    replyText: entries.filter((e) => e.who === "voice" && e.at >= sayAt).map((e) => e.text).join(" "),
  });
  console.error(`Q${i + 1}: turn ${row?.n ?? "-"}, ended by ${endedBy}, played ${questions.at(-1).played}`);
}

const last = await buffer();
await page.evaluate(`document.querySelector('${PANEL} button[aria-label="End call"]')?.click()`);
const doc = last ? await waitFor(async () => {
  const res = await api("GET", `/issues/${issue.id}/documents/${last.key}`);
  return res.status === 200 && res.body?.body?.includes("## Turn timing") ? res.body.body : null;
}, 60_000, 2_000) : null;
const saved = doc?.match(/## Turn timing[\s\S]*?```json\n([\s\S]*?)\n```/)?.[1];

const comments = (await ok("GET", `/issues/${issue.id}/comments?order=asc&limit=500`)).map((c) => ({
  id: c.id, body: c.body, authorAgentId: c.authorAgentId ?? null, authorUserId: c.authorUserId ?? null, createdByRunId: c.createdByRunId ?? null,
}));
const runIds = [...new Set(comments.filter((c) => c.authorAgentId && c.createdByRunId).map((c) => c.createdByRunId))].slice(0, 100);
const runs = runIds.length ? await ok("GET", `/issues/${issue.id}/runs?runIds=${runIds.join(",")}`) : [];
const run = {
  meta: { engine: ENGINE, task: TASK, boardAccount, documentKey: last?.key ?? null, timingStamp: last?.timingStamp ?? null, rowsFrom: saved ? "document" : "buffer" },
  rows: saved ? JSON.parse(saved) : last?.turns ?? [],
  notes: (last?.entries ?? []).filter((e) => e.who === "note").map((e) => e.text),
  questions,
  api: {
    taskIssueId: issue.id, taskStatus: (await ok("GET", `/issues/${issue.id}`)).status, comments,
    runs: Object.fromEntries(runs.map((r) => [r.runId, r.wakeCommentIds ?? (r.wakeCommentId ? [r.wakeCommentId] : [])])),
    chatCommentsBefore, chatCommentsAfter: await chatCount(),
  },
};
writeFileSync(OUT, JSON.stringify(run, null, 2));
const result = bars(run);
console.log(JSON.stringify({ out: OUT, pass: result.pass, bars: result.bars }, null, 2));
console.log(markdown(result));
page.close();
