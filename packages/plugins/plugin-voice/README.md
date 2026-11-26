# Voice

Two buttons in every Paperclip chat box (board chat, task threads, task chat), on Grok voice (xAI):

- **Mic: voice note.** Tap, talk, tap again. The recording goes to the plugin worker, which transcribes it with `grok-voice-transcribe-2.0`. The text lands in the chat box, where you check it and tap Send. Turn on "Send voice notes straight away" to skip the check.
- **New task dialog: mic only.** A Voice chip sits in the dialog's toolbar, before the … menu. The note goes into the field you last used there (title or description), the description by default. It never creates the task by itself.
- **Waveform: live talk.** A full-screen two-way call you can interrupt. The voice can read the task on screen, say what is waiting on you, find tasks, list agents, post a message to a task's agent and create a task. Changes need a spoken yes: it reads the message back first. When an agent replies on a task you posted to, the reply is read out.

## How it works

- The xAI key is a Paperclip secret in the plugin settings, so it never leaves the server. For live talk, the worker mints a five-minute client secret (`POST /v1/realtime/client_secrets`). The browser opens `wss://api.x.ai/v1/realtime` with it, as the `xai-client-secret.<token>` subprotocol, and streams 24 kHz PCM16 both ways as binary frames.
- The live tools run in the browser against Paperclip's own `/api` using the person's session. The voice can do only what that person can do, and every change is logged as theirs.
- The host has no composer slot. One `appShellOverlay` mount watches the page and places the buttons in front of each composer's Send button, found by the host's stable `data-testid`s (`chat-composer`, `issue-chat-composer`, `task-chat-composer-actions`). If a host release renames them, the buttons do not appear. Nothing else breaks.
- Only signed-in people can use it. Agent runs are refused.

## Settings (per company)

| Field | Default | Notes |
|---|---|---|
| xAI API key | (none) | Secret ref. Nothing shows until it is saved. |
| Live voice | `eve` | Any Grok voice id or custom voice id. |
| Language | `en` | Transcription language and number formatting. Empty means auto-detect. |
| Words to listen for | `PiB, Paperclip, SEO, Partners in Biz` | Agent names are added automatically. |
| Send voice notes straight away | off | |
| Live voice | on | Hides the waveform when off. |

## Limits

- Voice notes: up to 10 minutes, recorded at 48 kbps (the upload cap is 7 MB).
- Live talk hangs up after 4 quiet minutes.
- It needs HTTPS and microphone permission for the Paperclip site.

## Per-agent voice

In a live call, the header has a voice picker for the agent you are talking to (the chat page's agent, else the CEO). It lists the built-in Grok voices (eve, ara, rex, sal, leo; see https://docs.x.ai/docs/guides/voice/agent) and takes effect on the next call. "Company default" clears it and uses the `Live voice` setting. The choice is stored in plugin state on the agent; unknown ids are refused by the worker and fall back to the company voice.

## Who may use it (access stage A)

Version 0.1.11 (PAR-12678): every action goes through the kit's access guard with the table in `src/access-table.ts`. `transcribe` and `live-session` need `voice.use` create; `set-agent-voice` needs `voice.settings` edit. Owners and admins always pass. No preset but Full access holds a voice permission, so a limited person gets the mic only when an owner turns `voice.use` on for him in Setup, under People. The overlay asks `access.me` first: without `voice.use` there is no mic and no waveform in any chat box. The two data handlers (`status`, `agent-voice`) carry no caller and stay as they are until stage C. With the company's access switch off (every company today) the guard is a pass-through. No migration, no capability change.

## Direct voice (0.2.0)

Direct voice lets you talk straight to the agent: you speak, the words go to the agent as an ordinary chat message, and the agent's own reply is spoken back in its own voice. The older live call (a separate voice model that relays messages) stays as "Classic".

- **Engines.** Grok (xAI text-to-speech, 28 built-in voices) needs only the xAI key. Gemini (30 prebuilt voices, plus a short style line such as "calm and warm") needs the optional Gemini key in Voice settings. Until it is saved, Gemini controls stay hidden. "Default direct voice" in Voice settings sets the engine for a person who has not picked one.
- **Per-agent voice.** The agent page has a **Voice** tab: pick the Grok voice, and once Gemini is set up the Gemini voice and style. **Play sample** speaks "Hi, I'm <agent name>." with the saved voice, so save first. A voice left on "Company default" uses the Voice settings. The choice is plugin state on the agent (`voice-profile`); the Grok voice is also kept in the old `voice` key, so a rollback keeps it.
- **Per-person mode.** Each person's mode (direct with Grok or Gemini, or classic) is saved for that person alone, by the actor, never by a param.
- **`local_trusted` is one shared choice.** In a `local_trusted` instance there is one board user and no sign-in, so every browser shares that one person's mode and the agent voices. Set it once.
- **Access.** `speak`, `get-my-voice-mode` and `set-my-voice-mode` need `voice.use` create; `set-agent-voice-profile` needs `voice.settings` edit. The Voice tab opens for a person with either.
- **Limits.** Spoken text is capped per piece and per person per day; provider trouble answers an error the panel shows or falls back from, with no retries.
- **Rollback to 0.1.x.** New settings keys (`geminiApiKey`, `geminiVoice`, `defaultProvider`) are ignored by older workers; the Grok settings read the same (`tests/rollback-config.spec.ts`). The `ui.detailTab.register` capability is new in 0.2.0, so deploy it stop-first.
