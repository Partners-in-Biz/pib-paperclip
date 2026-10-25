# Voice

Two buttons in every Paperclip chat box (board chat, task threads, task chat), on Grok voice (xAI):

- **Mic: voice note.** Tap, talk, tap again. The recording goes to the plugin worker, which transcribes it with `grok-voice-transcribe-2.0`. The text lands in the chat box, where you check it and tap Send. Turn on "Send voice notes straight away" to skip the check.
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
