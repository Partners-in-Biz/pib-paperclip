// SPIKE PAR-15293 (throwaway, never merged). A small voice session host inside
// the Hermes adapter: at most one `hermes acp` process per (agent, chat key),
// reached through its own loopback turn bridge. The process env is the cold
// run's env (built by buildAgentChildEnv) minus every per-run credential.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { startVoiceTurnBridge, type VoiceTurnBridge } from "./turn-bridge.js";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

class AcpClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  onUpdate: (params: any) => void = () => {};
  constructor(private readonly child: ChildProcess, private readonly log: (l: string) => void) {
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line) this.onLine(line);
      }
    });
    child.on("exit", (code, signal) => {
      for (const p of this.pending.values()) p.reject(new Error(`hermes acp exited (${code ?? signal})`));
      this.pending.clear();
    });
  }
  private onLine(line: string) {
    let msg: any;
    try { msg = JSON.parse(line); } catch { this.log(`[voice-host] non-json: ${line.slice(0, 200)}`); return; }
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`ACP ${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "session/update") { this.onUpdate(msg.params); return; }
    if (msg.method === "session/request_permission" && msg.id !== undefined) {
      // Same as the cold path's --yolo: allow.
      const options: any[] = msg.params?.options ?? [];
      const pick = options.find((o) => o.kind === "allow_once") ?? options.find((o) => String(o.kind).startsWith("allow")) ?? options[0];
      this.write({ jsonrpc: "2.0", id: msg.id, result: { outcome: pick ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" } } });
      return;
    }
    if (msg.id !== undefined) {
      this.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `client does not support ${msg.method}` } });
    }
  }
  private write(obj: unknown) { this.child.stdin!.write(`${JSON.stringify(obj)}\n`); }
  request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }
  notify(method: string, params: unknown) { this.write({ jsonrpc: "2.0", method, params }); }
}

interface WarmHost {
  key: string;
  child: ChildProcess;
  client: AcpClient;
  bridge: VoiceTurnBridge;
  envDir: string;
  envFile: string;
  promptsSent: number;
  sessionId: string | null;
  busy: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  fingerprint: string;
  startedAt: number;
  dead: boolean;
}

const IDLE_MS = 120_000;
const CANCEL_GRACE_MS = 2_000;
const hosts = new Map<string, WarmHost>();
// For the spike report only: where the test harness finds each host.
const SPIKE_STATE_DIR = process.env.PAPERCLIP_SPIKE_VOICE_STATE_DIR || path.join(os.tmpdir(), "voice-spike-hosts");

async function writeSpikeState(host: WarmHost) {
  await fs.mkdir(SPIKE_STATE_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(SPIKE_STATE_DIR, `${host.key.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`),
    JSON.stringify({ key: host.key, pid: host.child.pid, bridgeUrl: host.bridge.url, sessionId: host.sessionId,
      binding: host.bridge.current()?.runId ?? null, stats: host.bridge.stats, startedAt: host.startedAt }, null, 2),
    { mode: 0o600 });
}

async function stopHost(host: WarmHost, reason: string, log: (l: string) => void) {
  if (host.dead) return;
  host.dead = true;
  hosts.delete(host.key);
  if (host.idleTimer) clearTimeout(host.idleTimer);
  log(`[voice-host] stop ${host.key} (${reason})`);
  try { if (host.child.pid) process.kill(-host.child.pid, "SIGKILL"); } catch { /* gone */ }
  await host.bridge.close().catch(() => {});
  await fs.rm(host.envDir, { recursive: true, force: true }).catch(() => {});
}

/** The per-run keys that must never reach the warm process. */
function isPerRunKey(key: string) {
  return key === "PAPERCLIP_RUN_ID" || key === "PAPERCLIP_API_KEY" || key === "PAPERCLIP_TASK_ID"
    || key.startsWith("PAPERCLIP_WAKE_") || key.startsWith("PAPERCLIP_RUNTIME_TOOLS_")
    || key === "PAPERCLIP_RUNTIME_API_URL" || key === "PAPERCLIP_RUNTIME_API_CANDIDATES_JSON"
    || key === "PAPERCLIP_LISTEN_HOST" || key === "PAPERCLIP_LISTEN_PORT" || key === "PAPERCLIP_APPROVAL_ID"
    || key === "PAPERCLIP_LINKED_ISSUE_IDS";
}

async function startHost(input: {
  key: string; command: string; coldEnv: Record<string, string>; cwd: string; upstreamUrl: string;
  fingerprint: string; log: (l: string) => void;
}): Promise<WarmHost> {
  const bridge = await startVoiceTurnBridge({ upstreamUrl: input.upstreamUrl, log: input.log });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.coldEnv)) if (!isPerRunKey(k)) env[k] = v;
  env.PAPERCLIP_API_URL = bridge.url;
  env.PAPERCLIP_API_KEY = bridge.token;
  // Hermes scrubs *_KEY names from tool subprocesses; production solves that
  // with hermes-pc's BASH_ENV file. Here the file is fixed for the process
  // lifetime: bridge URL and bridge token never change between turns.
  const envDir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-host-"));
  const envFile = path.join(envDir, "env.sh");
  const exported = ["PAPERCLIP_API_URL", "PAPERCLIP_API_KEY", "PAPERCLIP_AGENT_ID", "PAPERCLIP_COMPANY_ID"]
    .filter((k) => env[k]).map((k) => `export ${k}='${env[k].replace(/'/g, "'\\''")}'`).join("\n");
  await fs.writeFile(envFile, `${exported}\n`, { mode: 0o600 });
  env.BASH_ENV = envFile;
  const child = spawn(input.command, ["acp", "--accept-hooks"], { cwd: input.cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr!.setEncoding("utf8");
  let stderrTail = "";
  child.stderr!.on("data", (c: string) => { stderrTail = (stderrTail + c).slice(-4000); });
  const client = new AcpClient(child, input.log);
  const host: WarmHost = { key: input.key, child, client, bridge, envDir, envFile, promptsSent: 0, sessionId: null, busy: false, idleTimer: null,
    fingerprint: input.fingerprint, startedAt: Date.now(), dead: false };
  child.on("exit", (code, signal) => {
    input.log(`[voice-host] hermes acp exited code=${code} signal=${signal} stderr-tail=${JSON.stringify(stderrTail.slice(-400))}`);
    void stopHost(host, "process exited", input.log);
  });
  hosts.set(input.key, host);
  const t0 = Date.now();
  await client.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  input.log(`[voice-host] started ${input.key} pid=${child.pid} bridge=${bridge.url} initialize=${Date.now() - t0}ms`);
  return host;
}

function armIdle(host: WarmHost, log: (l: string) => void) {
  if (host.idleTimer) clearTimeout(host.idleTimer);
  host.idleTimer = setTimeout(() => void stopHost(host, "idle", log), IDLE_MS);
  host.idleTimer.unref?.();
}

export async function runWarmVoiceTurnSpike(ctx: AdapterExecutionContext, input: {
  command: string; coldEnv: Record<string, string>; cwd: string; prompt: string; sessionId: string | undefined;
  model: string; provider: string; upstreamUrl: string; chatKey: string; fingerprint: string;
  systemPrompt: string;
}): Promise<AdapterExecutionResult> {
  const log = (l: string) => {
    void ctx.onLog("stdout", `${l}\n`).catch(() => {});
    void fs.mkdir(SPIKE_STATE_DIR, { recursive: true }).then(() =>
      fs.appendFile(path.join(SPIKE_STATE_DIR, "host.log"), `${new Date().toISOString()} ${l}\n`)).catch(() => {});
  };
  const runToken = (ctx as { authToken?: string }).authToken;
  if (!runToken) throw new Error("voice spike: no run token");
  const key = `${ctx.agent.companyId}:${ctx.agent.id}:${input.chatKey}`;
  const turnStart = Date.now();
  await ctx.onCancellationReady?.();

  let host = hosts.get(key);
  if (host && (host.fingerprint !== input.fingerprint || host.dead)) {
    await stopHost(host, "config changed", log);
    host = undefined;
  }
  if (host?.busy) throw new Error("voice spike: host busy (one turn at a time)");
  const warm = Boolean(host?.sessionId);
  if (!host) host = await startHost({ key, command: input.command, coldEnv: input.coldEnv, cwd: input.cwd,
    upstreamUrl: input.upstreamUrl, fingerprint: input.fingerprint, log });
  host.busy = true;
  if (host.idleTimer) clearTimeout(host.idleTimer);
  try {
    if (!host.sessionId) {
      const t0 = Date.now();
      if (input.sessionId) {
        await host.client.request("session/load", { sessionId: input.sessionId, cwd: input.cwd, mcpServers: [] });
        host.sessionId = input.sessionId;
        log(`[voice-host] session/load ${input.sessionId} ${Date.now() - t0}ms`);
      } else {
        const res = await host.client.request("session/new", { cwd: input.cwd, mcpServers: [] });
        host.sessionId = String(res.sessionId);
        log(`[voice-host] session/new ${host.sessionId} ${Date.now() - t0}ms`);
      }
    }
    const sessionId = host.sessionId!;
    // Bind this turn. From here the process acts as this run, and only this run.
    host.bridge.bind(ctx.runId, runToken);
    await writeSpikeState(host);
    log(`[voice-host] bound run ${ctx.runId} (warm=${warm})`);
    let text = "";
    host.client.onUpdate = (p) => {
      const u = p?.update;
      if (p?.sessionId === sessionId && u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") text += u.content.text;
    };
    // `hermes acp` (0.22.5) runs tools inside the shared Hermes gateway: the
    // acp process env and HERMES_EPHEMERAL_SYSTEM_PROMPT never reach the
    // agent. The host therefore names a private env file per turn and sends
    // the agent instructions once per process.
    const preamble = [
      host.promptsSent === 0 && input.systemPrompt ? `<agent-instructions>\n${input.systemPrompt}\n</agent-instructions>\n` : "",
      `[voice host] For Paperclip API calls, start the same shell command with \`. ${host.envFile} &&\` (it sets PAPERCLIP_API_URL and PAPERCLIP_API_KEY). Never print PAPERCLIP_API_KEY.\n\n`,
    ].join("");
    host.promptsSent += 1;
    const promptStart = Date.now();
    const promptDone = host.client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: preamble + input.prompt }] });
    let cancelled = false;
    let cancelOutcome: string | null = null;
    const onAbort = async () => {
      cancelled = true;
      // 1) Revoke first: the process can do nothing more as this run.
      host!.bridge.unbind(ctx.runId);
      await writeSpikeState(host!).catch(() => {});
      log(`[voice-host] cancel: unbound run ${ctx.runId}; sending session/cancel`);
      host!.client.notify("session/cancel", { sessionId });
      const ended = await Promise.race([
        promptDone.then(() => true, () => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), CANCEL_GRACE_MS)),
      ]);
      cancelOutcome = ended ? "acp_cancel_stopped_prompt" : "killed_after_grace";
      log(`[voice-host] cancel outcome: ${cancelOutcome}`);
      if (!ended) await stopHost(host!, "cancel grace expired", log);
    };
    let abortHandled: Promise<void> | null = null;
    const abortListener = () => { abortHandled = onAbort(); };
    if (ctx.signal?.aborted) abortListener();
    else ctx.signal?.addEventListener("abort", abortListener, { once: true });
    let stopReason = "unknown";
    try {
      const res = await Promise.race([
        promptDone,
        new Promise((_, rej) => ctx.signal?.addEventListener("abort", () => setTimeout(() => rej(new Error("cancelled")), CANCEL_GRACE_MS + 200), { once: true })),
      ]) as { stopReason?: string };
      stopReason = String(res?.stopReason ?? "end_turn");
    } catch (error) {
      stopReason = cancelled ? "cancelled" : `error: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      ctx.signal?.removeEventListener("abort", abortListener);
      if (abortHandled) await abortHandled;
      host.bridge.unbind(ctx.runId);
      host.busy = false;
      if (!host.dead) { await writeSpikeState(host).catch(() => {}); armIdle(host, log); }
    }
    log(`[voice-host] turn done run=${ctx.runId} stop=${stopReason} prompt=${Date.now() - promptStart}ms total=${Date.now() - turnStart}ms warm=${warm} cancel=${cancelOutcome ?? "-"}`);
    return {
      exitCode: cancelled ? null : 0,
      signal: cancelled ? "SIGTERM" : null,
      timedOut: false,
      provider: input.provider,
      model: input.model,
      summary: text.slice(0, 2000) || undefined,
      errorMessage: stopReason.startsWith("error") ? stopReason : undefined,
      resultJson: { result: text, session_id: sessionId, voiceSpike: { warm, stopReason, cancelOutcome, promptMs: Date.now() - promptStart } },
      sessionParams: { sessionId },
      sessionDisplayId: sessionId.slice(0, 16),
    };
  } catch (error) {
    host.busy = false;
    host.bridge.unbind(ctx.runId);
    await stopHost(host, "turn error", log);
    throw error;
  }
}
