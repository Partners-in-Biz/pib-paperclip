# Agent child environment

An agent run starts a child process: the provider CLI (Hermes, Claude Code,
Codex, ...), or the command of a `process` agent. This page tells which
environment variables that child gets. Code: `packages/adapter-utils/src/agent-child-env.ts`.

## Rule

The server process holds secrets: the key that signs run tokens, the key that
signs tool actions, the database URL, the secret-store key. A child that can
read them can mint a run token for any agent and any person. So the child env
has three layers, in this order:

1. **Inherited server env, allowlist only.** OS basics (`PATH`, `HOME`, `USER`,
   `SHELL`, `LANG`, `LC_*`, `TZ`, `TERM`, temp dirs, `XDG_*`, CA and proxy
   settings, `SSH_AUTH_SOCK`), the API-url keys the server sets at boot
   (`PAPERCLIP_API_URL`, `PAPERCLIP_RUNTIME_API_URL`,
   `PAPERCLIP_RUNTIME_API_CANDIDATES_JSON`, `PAPERCLIP_LISTEN_HOST`,
   `PAPERCLIP_LISTEN_PORT`, `PAPERCLIP_INSTANCE_ID`, `PAPERCLIP_HOME`), and the
   keys each provider CLI reads (`AGENT_ADAPTER_INHERITED_ENV`). A remote run
   inherits nothing.
2. **The run's resolved config env** (agent, environment, project, routine
   bindings), without any name in `SERVER_SECRET_ENV_KEYS`.
3. **The run keys** the adapter sets (`PAPERCLIP_RUN_ID`, `PAPERCLIP_API_KEY`,
   `PAPERCLIP_TASK_ID`, wake and tool keys, ...).

A name in `SERVER_SECRET_ENV_KEYS` (or starting with `PAPERCLIP_SECRETS_` or
`PAPERCLIP_QA_USER`) never reaches a child, from any layer. Saving such a name
in a stored env (agent config, project, routine, environment) is refused with
422.

Every other server variable stays on the server. Server settings such as
`PAPERCLIP_ADAPTER_MODELS`, `PAPERCLIP_ATTACHMENT_MAX_BYTES`, wake caps and
spend alarms are read by the server, not by a run.

## Other children

The same rule covers children that are not an adapter turn:

- **Native runner** (`paperclip_runner`, `executeNativeCodexRunner`): layer 1,
  plus `RUST_BACKTRACE`; then the run's resolved environment; then
  `PAPERCLIP_RUNNER_BOOTSTRAP_TICKET`. runnerd reads no other host name.
- **Quota probes** (`claude auth status`, the codex app-server account read):
  layer 1 only.

## A provider needs another key

Add the name or a prefix to the adapter's entry in `AGENT_ADAPTER_INHERITED_ENV`.
Never add a name from `SERVER_SECRET_ENV_KEYS`. A key that one agent needs can
also go in that agent's config env.

## Kill switch

Server env `PAPERCLIP_AGENT_ENV_ALLOWLIST=off` (restart needed) restores the
old behaviour: the child inherits the whole server env, and stored names are
not refused. It reopens the leak. Use it only to recover from a broken run,
and tell the owner.
