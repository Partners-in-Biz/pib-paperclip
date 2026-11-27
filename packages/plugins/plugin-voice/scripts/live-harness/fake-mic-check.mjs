#!/usr/bin/env node
// Checks fake-mic.js in a local headless Chrome page, no board: after say() the mic level (the plugin's
// RMS x 4) is above 0.2, and `played` counts the page's own AudioBufferSourceNode starts, never the harness clip.
// Usage: CHROME_BIN=/path/to/chrome node fake-mic-check.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openSession, waitFor } from "./cdp.mjs";
import { encodePcm16, normalise } from "./clips.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// The page does what the plugin does: AudioContext in the tap, getUserMedia, a ScriptProcessor reading levels.
const PAGE = `<!doctype html><button id="start" style="width:200px;height:80px">Start</button><script>
window.result = { maxLevel: 0, ready: false };
document.getElementById("start").addEventListener("click", async () => {
  const ctx = new AudioContext(); void ctx.resume();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const sink = ctx.createGain(); sink.gain.value = 0;
  proc.onaudioprocess = (e) => {
    const f = e.inputBuffer.getChannelData(0); let s = 0;
    for (let i = 0; i < f.length; i += 1) s += f[i] * f[i];
    window.result.maxLevel = Math.max(window.result.maxLevel, Math.min(1, Math.sqrt(s / f.length) * 4));
  };
  src.connect(proc); proc.connect(sink); sink.connect(ctx.destination);
  window.pagePlay = () => { const b = ctx.createBufferSource(); b.buffer = ctx.createBuffer(1, 2400, 24000); b.connect(ctx.destination); b.start(); };
  window.result.ready = true;
});
</script>`;

const server = createServer((_req, res) => res.end(PAGE)).listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const profile = mkdtempSync(join(tmpdir(), "fake-mic-check-"));
const chrome = spawn(process.env.CHROME_BIN ?? "google-chrome", [
  "--headless=new", "--no-sandbox", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
let failed = false;
try {
  const wsBrowser = await new Promise((resolve, reject) => {
    let err = "";
    chrome.stderr.on("data", (d) => {
      err += d;
      const m = err.match(/DevTools listening on (ws:\S+)/);
      if (m) resolve(m[1]);
    });
    chrome.once("exit", (code) => reject(new Error(`chrome exited ${code}: ${err.slice(-500)}`)));
  });
  const port = new URL(wsBrowser).port;
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const page = await openSession(target.webSocketDebuggerUrl);
  await page.send("Page.enable");
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: readFileSync(join(here, "fake-mic.js"), "utf8") });
  await page.send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` });
  await waitFor(() => page.evaluate("!!window.__voiceHarness && !!document.getElementById('start')"), 10_000, 100);

  // A quiet 1.5 s syllable-like clip at 24 kHz, normalised the way drive.mjs normalises the real clips.
  const raw = new Float32Array(36_000);
  for (let i = 0; i < raw.length; i += 1) raw[i] = 0.01 * Math.abs(Math.sin(i / 1500)) * Math.sin((2 * Math.PI * 180 * i) / 24_000);
  const clip = normalise(raw);
  await page.evaluate(`window.__voiceHarness.load(0, ${JSON.stringify({ sampleRate: 24_000, pcm16: encodePcm16(clip.samples) })})`);

  await page.click("#start");
  if (!(await waitFor(() => page.evaluate("window.result.ready"), 10_000, 100))) throw new Error("getUserMedia never answered");
  const before = await page.evaluate("window.result.maxLevel");
  const ms = await page.evaluate("window.__voiceHarness.say(0)");
  const afterSay = await page.evaluate("({ level: window.result.maxLevel, played: window.__voiceHarness.played })");
  await page.evaluate("window.pagePlay()");
  const afterPage = await page.evaluate("window.__voiceHarness.played");
  const checks = {
    silentBeforeSay: before < 0.02,
    levelAbove02AfterSay: afterSay.level > 0.2,
    harnessStartsNotCounted: afterSay.played === 0,
    pageStartCounted: afterPage === 1,
  };
  failed = Object.values(checks).includes(false);
  console.log(JSON.stringify({ clipMs: ms, clipMedian: clip.median, levelBefore: before, levelAfterSay: afterSay.level, playedAfterSay: afterSay.played, playedAfterPageStart: afterPage, checks, pass: !failed }, null, 2));
  page.close();
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  if (chrome.exitCode === null) {
    const exited = new Promise((resolve) => chrome.once("exit", resolve));
    chrome.kill();
    await exited;
  }
  server.close();
  rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
process.exit(failed ? 1 : 0);
