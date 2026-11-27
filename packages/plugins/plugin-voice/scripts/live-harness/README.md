# plugin-voice live harness (PAR-15051 T2)

Runs one scripted Direct voice call on a test task with a fake microphone, then scores it against pass bars 1-7
of the PAR-15051 plan and prints the p50/p95 table per stage. No Chrome flags and no changes to the plugin.

## Rules

- **Board account.** The harness uses whichever board account is logged in on the Chrome it connects to. It
  reads that account from `/api/auth/get-session` and writes it to `meta.boardAccount` in the run record. Every
  turn is posted as that account's own comment. Name the account in the tables you post.
- **Test task only.** Point `HARNESS_TASK` only at the test task made for the proof (assigned to PiB, status
  `todo`, the description holds `Code word: heron.`). Never use a real task: each question posts a comment and
  wakes the assignee. On 0.2.3 and 0.2.4 the turns go to the account's chat with PiB instead (plan Q8).
- **Cost per 16-question run:** 16 STT calls, about 2-3k reply characters of TTS and 16 PiB runs. The first
  run also makes the clips: 16 Grok speak calls, about 1k characters, cached after that. All speak calls count
  toward the 50k-character daily cap.

## Files

| File | What it does |
|---|---|
| `fake-mic.js` | Injected with `Page.addScriptToEvaluateOnNewDocument`. `getUserMedia({audio})` answers a `MediaStreamAudioDestinationNode` stream on a harness `AudioContext`, resumed in the call. `__voiceHarness.say(i)` plays clip `i`. `__voiceHarness.played` counts `AudioBufferSourceNode.start` calls only when `this.context !== harnessCtx`. |
| `drive.mjs` | Opens the task, clicks Start with a real `Input.dispatchMouseEvent`, then asks each question and scores the run. |
| `clips.mjs` | Normalises the clips so the plugin level (RMS x 4) is above 0.2 during speech, which is 10x `ENDPOINT_SPEECH_LEVEL` (0.02, `src/limits.ts:38`). |
| `bars.mjs` | Pure scorer: run record (+ optional before-run) to bars 1-7 and the step table, as JSON or markdown. |
| `questions.json` | 16 read-only questions. Q1 asks for the code word, Q2 asks for the task status. |
| `fake-mic-check.mjs` | Local check, no board: in a headless Chrome page the level is above 0.2 after `say()`, and `played` ignores harness starts. |

## Run

Start Chrome with `--remote-debugging-port=9222`, log in to the board in it, then:

```sh
cd packages/plugins/plugin-voice/scripts/live-harness
HARNESS_CDP_URL=http://127.0.0.1:9222 \
HARNESS_BASE_URL=https://paperclip.partnersinbiz.online \
HARNESS_TASK=PAR-<test task> \
HARNESS_ENGINE=gemini \
HARNESS_CHAT_ISSUE=<id of the account's chat with PiB> \
node drive.mjs > gemini.md
```

- `HARNESS_QUESTIONS=2` runs the 2-question smoke.
- Clips are cached in `HARNESS_CLIPS_DIR`. The default is `$PAPERCLIP_TMPDIR/voice-harness-clips`, or the
  current folder when that is unset. Keep one folder for all runs, so every run hears the same input.
- The run record goes to `HARNESS_OUT` (default `voice-harness-<engine>-<ms>.json`).
- `HARNESS_CHAT_ISSUE` lets bar 6 check that the chat gains no comment. Without it, bar 6 fails with
  "chat with the agent not checked".

Before the panel opens, the harness saves the engine with `set-my-voice-mode`. A mode change inside the panel
would need a second gesture. It also turns "Interrupt by talking" off.

Per question it waits for `Listening`, notes `played`, calls `say(i)`, then polls the localStorage transcript
buffer (`pib-voice:transcript:<key>`) until the new turn row has an `outcome` or 180 s pass. Rows from before
0.2.5 have no `outcome`, so the wait also ends on `playAt`, or 30 s after the reply was seen. It then waits 1 s
and notes `played` again. When the last question is done it hangs up, reads the saved transcript document
(`## Turn timing` JSON), the task comments and the runs those comments came from, and prints the bars.

Score again or compare with a before-run:

```sh
node bars.mjs after.json --before before.json --md
```

Bar 4 needs a before-run on the same engine. Without one it reports `n/a`. On a 0.2.3 run, bars 1, 3, 5 and 6
fail by design.

## Tests

```sh
node --test bars.test.mjs
CHROME_BIN=/path/to/chrome node fake-mic-check.mjs
```
