/**
 * Server-side execution logic for the Hermes Agent adapter.
 *
 * Spawns `hermes chat --query-file <file> -Q` as a child process, streams output,
 * and returns structured results to Paperclip.
 *
 * Verified CLI flags (hermes chat):
 *   -q/--query         single query (non-interactive); small-prompt fallback only
 *   --query-file       read the query from a file (prompts over 128 KB do not fit argv)
 *   -Q/--quiet         quiet mode (no banner/spinner, only response + session_id)
 *   -m/--model         model name (e.g. anthropic/claude-sonnet-4)
 *   -t/--toolsets      comma-separated toolsets to enable
 *   --provider         inference provider (auto, openrouter, nous, etc.)
 *   -r/--resume        resume session by ID
 *   -w/--worktree      isolated git worktree
 *   -v/--verbose       verbose output
 *   --checkpoints      filesystem checkpoints
 *   --yolo             bypass dangerous-command approval prompts (agents have no TTY)
 *   --source           session source tag for filtering
 */

import fs from "node:fs/promises";
import path from "node:path";

import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";

import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  overrideAdapterExecutionTargetRemoteCwd,
  prepareAdapterExecutionTargetRuntime,
  readAdapterExecutionTarget,
  runAdapterExecutionTargetProcess,
  startAdapterExecutionTargetPaperclipBridge,
  adapterExecutionTargetEnablesSandboxDuplexBridge,
  adapterExecutionTargetDuplexObservabilityRecorder,
  type AdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";

import {
  runChildProcess,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  renderTemplate,
  ensureAbsoluteDirectory,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  joinPromptSections,
  selectPaperclipPromptSections,
  stringifyPaperclipWakePayload,
  isPaperclipRecoveryWakePayload,
} from "@paperclipai/adapter-utils/server-utils";

import {
  HERMES_CLI,
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_GRACE_SEC,
  DEFAULT_MODEL,
  VALID_PROVIDERS,
} from "../shared/constants.js";

import {
  detectModel,
  resolveHermesHome,
  resolveProvider,
} from "./detect-model.js";
import { reconcileHermesPaperclipSkills } from "./skills.js";
import { guardEnvStrings, prepareQuery } from "./query-file.js";
import { readSessionLineage, resolveRun, type SessionRow } from "./session-metering.js";
import {
  createRemoteSessionReader,
  killRemoteTree,
  removeRemoteDir,
  stageRemoteQuery,
  wrapWithPidFile,
  type RemoteRun,
} from "./remote.js";
import {
  formatHermesStreamEventForLog,
  isPlausibleHermesSessionId,
  parseHermesStreamJsonLine,
  parseHermesStreamJsonOutput,
  sessionCheckpointResumeEnabled,
} from "./session-checkpoint.js";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function cfgString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function cfgNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function cfgBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function cfgStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((i) => typeof i === "string")
    ? (v as string[])
    : undefined;
}
function cfgEnvString(v: unknown): string | undefined {
  if (typeof v === "string" && v.length > 0) return v;
  if (v && typeof v === "object" && "value" in v) {
    const value = (v as { value?: unknown }).value;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }
  return undefined;
}

export function resolveHermesCommand(config: Record<string, unknown>): string {
  return cfgString(config.hermesCommand) || cfgString(config.command) || HERMES_CLI;
}

// ---------------------------------------------------------------------------
// Wake-up prompt builder
// ---------------------------------------------------------------------------

const HERMES_RUNTIME_IDENTITY_TEMPLATE = [
  'You are "{{agent.name}}", an AI agent employee in a Paperclip-managed company.',
  "",
  "Paperclip runtime identity:",
  "- Agent ID: {{agent.id}}",
  "- Company ID: {{agent.companyId}}",
  "- Run ID: {{run.id}}",
  "- API base: {{paperclipApiUrl}}",
].join("\n");

// Hermes applies this overlay at each API call, including after compaction,
// without storing it in conversation history. Keep run/task deltas in -q.
const HERMES_SYSTEM_PROMPT_TEMPLATE = [
  "Paperclip API guidance:",
  "- Use `curl` from the terminal for Paperclip API calls; browser/web extraction tools may not reach localhost.",
  "- Use `$PAPERCLIP_API_URL`, `$PAPERCLIP_API_KEY`, and `$PAPERCLIP_RUN_ID`; do not hard-code local ports or copy secrets into comments.",
  "- Displayed command logs may redact secrets; rely on environment variables instead of printed token values.",
  "- Include `-H \"Authorization: Bearer $PAPERCLIP_API_KEY\"` on API requests.",
  "- Include `-H \"X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID\"` on mutating issue requests.",
  "- For multiline comments or status updates, preserve newlines with `jq --arg` or a heredoc-fed helper rather than hand-escaping JSON.",
  "",
  "Safe multiline update pattern:",
  "```bash",
  "api=\"${PAPERCLIP_API_URL%/}\"",
  "case \"$api\" in */api) ;; *) api=\"$api/api\" ;; esac",
  "",
  "body=$(cat <<'MD'",
  "Summary line",
  "",
  "- Detail one",
  "- Detail two",
  "MD",
  ")",
  "jq -n --arg status done --arg comment \"$body\" '{status:$status, comment:$comment}' | \\",
  "  curl -sS -X PATCH \"$api/issues/$PAPERCLIP_TASK_ID\" \\",
  "    -H \"Authorization: Bearer $PAPERCLIP_API_KEY\" \\",
  "    -H \"X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID\" \\",
  "    -H \"Content-Type: application/json\" \\",
  "    --data-binary @-",
  "```",
  "",
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
].join("\n");

function renderConditionalSections(template: string, vars: Record<string, unknown>): string {
  const isTruthy = (key: string) => {
    if (key === "noTask") return !vars.taskId;
    const value = vars[key];
    if (Array.isArray(value)) return value.length > 0;
    return Boolean(value);
  };
  return template.replace(
    /\{\{#([a-zA-Z0-9_.-]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_match, key: string, body: string) => (isTruthy(key) ? body : ""),
  );
}

export function buildPrompt(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
  options: { resumedSession?: boolean } = {},
): string {
  const context = (ctx as any).context || {};
  const template = cfgString(config.promptTemplate);
  const taskId = cfgString(context.taskId) || cfgString(context.issueId) || cfgString(ctx.config?.taskId);
  const taskTitle = cfgString(context.taskTitle) || cfgString(ctx.config?.taskTitle) || "";
  const taskBody = cfgString(context.taskBody) || cfgString(ctx.config?.taskBody) || "";
  const commentId = cfgString(context.commentId) || cfgString(context.wakeCommentId) || cfgString(ctx.config?.commentId) || "";
  const wakeReason = cfgString(context.wakeReason) || cfgString(ctx.config?.wakeReason) || "";
  const agentName = ctx.agent?.name || "Hermes Agent";
  const companyName = cfgString(context.companyName) || cfgString(ctx.config?.companyName) || "";
  const projectName = cfgString(context.projectName) || cfgString(ctx.config?.projectName) || "";

  // Build API URL — ensure it has the /api path
  let paperclipApiUrl =
    cfgString(config.paperclipApiUrl) ||
    process.env.PAPERCLIP_API_URL ||
    "http://127.0.0.1:3100/api";
  // Ensure /api suffix
  if (!paperclipApiUrl.endsWith("/api")) {
    paperclipApiUrl = paperclipApiUrl.replace(/\/+$/, "") + "/api";
  }

  const { taskContextNote: taskContextMarkdown, wakePrompt } = selectPaperclipPromptSections(context, {
    resumedSession: options.resumedSession === true,
    includeCommunicationGuidance: true,
  });
  // Keep the historical variable available to custom templates. Automatic
  // assembly uses the ownership-aware assignment variant below.
  const paperclipTaskMarkdown = cfgString(context.paperclipTaskMarkdown)?.trim() || "";
  const sessionHandoffMarkdown = cfgString(context.paperclipSessionHandoffMarkdown)?.trim() || "";
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake) || "";

  const vars: Record<string, unknown> = {
    agentId: ctx.agent?.id || "",
    agentName,
    companyId: ctx.agent?.companyId || "",
    companyName,
    runId: ctx.runId || "",
    agent: ctx.agent || {},
    company: { id: ctx.agent?.companyId || "", name: companyName },
    run: { id: ctx.runId || "", source: "on_demand" },
    context,
    taskId: taskId || "",
    taskTitle,
    taskBody,
    commentId,
    wakeReason,
    projectName,
    paperclipApiUrl,
    paperclipWakePrompt: wakePrompt,
    paperclipTaskMarkdown,
    taskContext: paperclipTaskMarkdown,
    taskContextMarkdown,
    paperclipWakeJson: wakePayloadJson,
    wakePayloadJson,
    paperclipApiKeyEnv: "PAPERCLIP_API_KEY",
    paperclipRunIdEnv: "PAPERCLIP_RUN_ID",
  };

  const rendered = template && !isPaperclipRecoveryWakePayload(context.paperclipWake)
    ? renderTemplate(renderConditionalSections(template, vars), vars)
    : "";
  return joinPromptSections([
    renderTemplate(HERMES_RUNTIME_IDENTITY_TEMPLATE, vars),
    wakePrompt,
    sessionHandoffMarkdown,
    taskContextMarkdown,
    rendered,
  ]);
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/** Regex to extract session ID from Hermes quiet-mode output: "session_id: <id>" */
const SESSION_ID_REGEX = /^session_id:\s*(\S+)/m;

/** Regex for legacy session output format */
const SESSION_ID_REGEX_LEGACY = /session[_ ](?:id|saved)[:\s]+([a-zA-Z0-9_-]+)/i;

/** Regex to extract token usage from Hermes output. */
const TOKEN_USAGE_REGEX =
  /tokens?[:\s]+(\d+)\s*(?:input|in)\b.*?(\d+)\s*(?:output|out)\b/i;

/** Regex to extract cost from Hermes output. */
const COST_REGEX = /(?:cost|spent)[:\s]*\$?([\d.]+)/i;

interface ParsedOutput {
  sessionId?: string;
  response?: string;
  usage?: UsageSummary;
  costUsd?: number;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Response cleaning
// ---------------------------------------------------------------------------

/**
 * Revert switch for the Hermes `Query:` echo strip. Flip to false and redeploy
 * to keep a leading query line. Not a runtime config.
 */
export const STRIP_HERMES_QUERY_ECHO = true;

/** Strip noise lines from a Hermes response (tool output, system messages, etc.) */
export function cleanResponse(raw: string): string {
  const cleaned = raw
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return true; // keep blank lines for paragraph separation
      if (t.startsWith("[tool]") || t.startsWith("[hermes]") || t.startsWith("[paperclip]")) return false;
      if (t.startsWith("session_id:")) return false;
      if (/^\[\d{4}-\d{2}-\d{2}T/.test(t)) return false;
      if (/^\[done\]\s*┊/.test(t)) return false;
      if (/^┊\s*[\p{Emoji_Presentation}]/u.test(t) && !/^┊\s*💬/.test(t)) return false;
      if (/^\p{Emoji_Presentation}\s*(Completed|Running|Error)?\s*$/u.test(t)) return false;
      return true;
    })
    .map((line) => {
      let t = line.replace(/^[\s]*┊\s*💬\s*/, "").trim();
      t = t.replace(/^\[done\]\s*/, "").trim();
      return t;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!STRIP_HERMES_QUERY_ECHO) return cleaned;
  const nl = cleaned.indexOf("\n");
  const first = nl === -1 ? cleaned : cleaned.slice(0, nl);
  if (!first.trimStart().startsWith("Query:")) return cleaned;
  return (nl === -1 ? "" : cleaned.slice(nl + 1)).replace(/^\n+/, "").trim();
}

/** True when the first substantive stdout line is a Hermes `Query:` echo. */
function stdoutStartsWithQueryEcho(stdout: string): boolean {
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("[tool]") || t.startsWith("[hermes]") || t.startsWith("[paperclip]")) continue;
    if (t.startsWith("session_id:")) continue;
    return t.startsWith("Query:");
  }
  return false;
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

function parseHermesOutput(stdout: string, stderr: string): ParsedOutput {
  const combined = stdout + "\n" + stderr;
  const result: ParsedOutput = {};

  // In quiet mode, Hermes outputs:
  //   <response text>
  //
  //   session_id: <id>
  const sessionMatch = stdout.match(SESSION_ID_REGEX);
  if (sessionMatch?.[1]) {
    result.sessionId = sessionMatch?.[1] ?? null;
    // The response is everything before the session_id line
    const sessionLineIdx = stdout.lastIndexOf("\nsession_id:");
    if (sessionLineIdx > 0) {
      result.response = cleanResponse(stdout.slice(0, sessionLineIdx));
    }
  } else {
    // Legacy format (non-quiet mode)
    const legacyMatch = combined.match(SESSION_ID_REGEX_LEGACY);
    if (legacyMatch?.[1]) {
      result.sessionId = legacyMatch?.[1] ?? null;
    }
    // In non-quiet mode, extract clean response from stdout by
    // filtering out tool lines, system messages, and noise
    const cleaned = cleanResponse(stdout);
    if (cleaned.length > 0) {
      result.response = cleaned;
    }
  }

  // Extract token usage
  const usageMatch = combined.match(TOKEN_USAGE_REGEX);
  if (usageMatch) {
    result.usage = {
      inputTokens: parseInt(usageMatch[1], 10) || 0,
      outputTokens: parseInt(usageMatch[2], 10) || 0,
    };
  }

  // Extract cost
  const costMatch = combined.match(COST_REGEX);
  if (costMatch?.[1]) {
    result.costUsd = parseFloat(costMatch[1]);
  }

  // Check for error patterns in stderr
  if (stderr.trim()) {
    const errorLines = stderr
      .split("\n")
      .filter((line) => /error|exception|traceback|failed/i.test(line))
      .filter((line) => !/INFO|DEBUG|warn/i.test(line)); // skip log-level noise
    if (errorLines.length > 0) {
      result.errorMessage = errorLines.slice(0, 5).join("\n");
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main execute
// ---------------------------------------------------------------------------

/** Set when this run executes on a remote (ssh) target instead of the server. */
interface RemoteHermes {
  /** Target with its cwd pointing at the synced remote workspace. */
  target: AdapterExecutionTarget;
  /**
   * The environment as configured. Session identity uses this one: the synced
   * workspace path above changes on every run, the configured target does not.
   */
  identity: AdapterExecutionTarget;
  cwd: string;
  run: RemoteRun;
  bridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>>;
}

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  // Local agents (every server-side Hermes agent) take the unchanged path.
  if (!executionTarget || !adapterExecutionTargetIsRemote(executionTarget)) {
    return executeHermes(ctx, null);
  }
  return executeRemote(ctx, executionTarget);
}

async function executeRemote(
  ctx: AdapterExecutionContext,
  executionTarget: AdapterExecutionTarget,
): Promise<AdapterExecutionResult> {
  const config = (ctx.config ?? ctx.agent?.adapterConfig ?? {}) as Record<string, unknown>;
  const timeoutSec = cfgNumber(config.timeoutSec) || DEFAULT_TIMEOUT_SEC;
  const workspace = ctx.context?.paperclipWorkspace;
  const workspaceCwd = workspace && typeof workspace === "object"
    ? cfgString((workspace as Record<string, unknown>).cwd)
    : undefined;
  const localCwd = cfgString(config.cwd) || workspaceCwd || cfgString(ctx.config?.workspaceDir) || ".";
  const where = describeAdapterExecutionTarget(executionTarget);

  await ctx.onLog("stdout", `[hermes] Syncing workspace to ${where}.\n`);
  const prepared = await prepareAdapterExecutionTargetRuntime({
    runId: ctx.runId,
    target: executionTarget,
    adapterKey: "hermes",
    timeoutSec,
    workspaceLocalDir: localCwd,
    onProgress: (line) => ctx.onLog("stdout", line),
    onRuntimeProgress: ctx.onRuntimeProgress,
  });
  let bridge: RemoteHermes["bridge"] = null;
  try {
    const remoteCwd = prepared.workspaceRemoteDir ?? (executionTarget as { remoteCwd?: string }).remoteCwd ?? localCwd;
    const runtimeTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, remoteCwd) ?? executionTarget;
    // Helper commands (stage prompt, read sessions, kill) use their own run id
    // so they never replace the main process in the cancel registry.
    const run: RemoteRun = (command, args, options = {}) =>
      runAdapterExecutionTargetProcess(`${ctx.runId}:hermes-aux`, runtimeTarget, command, args, {
        cwd: remoteCwd,
        env: {},
        stdin: options.stdin,
        timeoutSec: options.timeoutSec ?? 30,
        graceSec: 5,
        onLog: async () => undefined,
      });
    const hostToken = (ctx as { authToken?: string }).authToken;
    if (hostToken) {
      bridge = await startAdapterExecutionTargetPaperclipBridge({
        runId: ctx.runId,
        target: runtimeTarget,
        enableSandboxDuplexBridge: adapterExecutionTargetEnablesSandboxDuplexBridge(runtimeTarget),
        duplexObservabilityRecorder: adapterExecutionTargetDuplexObservabilityRecorder(runtimeTarget),
        runtimeRootDir: prepared.runtimeRootDir,
        adapterKey: "hermes",
        timeoutSec,
        hostApiToken: hostToken,
        onLog: ctx.onLog,
      });
    }
    return await executeHermes(ctx, { target: runtimeTarget, identity: executionTarget, cwd: remoteCwd, run, bridge });
  } finally {
    if (bridge) await bridge.stop().catch(() => undefined);
    await ctx.onLog("stdout", `[hermes] Restoring workspace changes from ${where}.\n`);
    await prepared.restoreWorkspace((line) => ctx.onLog("stdout", line)).catch(async (err) => {
      await ctx.onLog(
        "stderr",
        `[hermes] Could not restore workspace changes: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    });
  }
}

async function executeHermes(
  ctx: AdapterExecutionContext,
  remote: RemoteHermes | null,
): Promise<AdapterExecutionResult> {
  const config = (ctx.config ?? ctx.agent?.adapterConfig ?? {}) as Record<string, unknown>;

  // ── Resolve configuration ──────────────────────────────────────────────
  const hermesCmd = resolveHermesCommand(config);
  const model = cfgString(config.model) || DEFAULT_MODEL;
  const timeoutSec = cfgNumber(config.timeoutSec) || DEFAULT_TIMEOUT_SEC;
  const graceSec = cfgNumber(config.graceSec) || DEFAULT_GRACE_SEC;
  const maxTurns = cfgNumber(config.maxTurnsPerRun);
  const toolsets = cfgString(config.toolsets) || cfgStringArray(config.enabledToolsets)?.join(",");
  const extraArgs = cfgStringArray(config.extraArgs);
  const persistSession = cfgBoolean(config.persistSession) !== false;
  const worktreeMode = cfgBoolean(config.worktreeMode) === true;
  const checkpoints = cfgBoolean(config.checkpoints) === true;
  const savedSessionParams = (ctx.runtime?.sessionParams as Record<string, unknown> | null) ?? null;
  let prevSessionId = cfgString(savedSessionParams?.sessionId);
  // A session lives in one host's state.db. Only resume it where it was made:
  // a local run never resumes a remote session (and the reverse), and a remote
  // run only on the same ssh host / user / port. Sessions without an identity
  // (every existing local one) resume as before.
  if (prevSessionId && (remote || savedSessionParams?.remoteExecution !== undefined)) {
    const savedIdentity = savedSessionParams?.remoteExecution;
    const sameHost = remote
      ? adapterExecutionTargetSessionMatches(savedIdentity, remote.identity)
      : adapterExecutionTargetSessionMatches(savedIdentity, null);
    if (!sameHost) {
      await ctx.onLog(
        "stdout",
        `[hermes] Warning: session ${prevSessionId} was created on a different host and is not resumed here; starting a new session.\n`,
      );
      prevSessionId = undefined;
    }
  }

  // The server adds this runtime inventory at the run boundary. Requiring the
  // marker avoids touching a developer's real Hermes home in direct unit or
  // library calls that did not opt into Paperclip runtime skills.
  // Remote runs use the skills already installed in the remote Hermes home.
  if (!remote && Object.prototype.hasOwnProperty.call(config, "paperclipRuntimeSkills")) {
    try {
      const selectedSkills = await reconcileHermesPaperclipSkills(config);
      if (selectedSkills.length > 0) {
        await ctx.onLog(
          "stdout",
          `[hermes] Reconciled ${selectedSkills.length} Paperclip-managed skill(s) into the Hermes skills home.\n`,
        );
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await ctx.onLog("stderr", `[hermes] Cannot start without the required Paperclip-managed skills: ${reason}\n`);
      throw err;
    }
  }

  // ── Resolve provider (defense in depth) ────────────────────────────────
  // Priority chain:
  //   1. Explicit provider in adapterConfig (user override)
  //   2. Provider from the seat's HERMES_HOME config.yaml (detected at runtime)
  //   3. Provider inferred from model name prefix
  //   4. "auto" (let Hermes decide)
  //
  // This ensures that even if the agent was created before provider tracking
  // was added, or if the model was changed without updating provider, the
  // correct provider is still used.
  let detectedConfig: Awaited<ReturnType<typeof detectModel>> | null = null;
  const explicitProvider = cfgString(config.provider);

  // The server's own config.yaml says nothing about a remote host's Hermes, so
  // remote runs skip detection and pass only what adapterConfig names.
  if (!explicitProvider && !remote) {
    try {
      detectedConfig = await detectModel(
        path.join(resolveHermesHome((config.env ?? {}) as Record<string, unknown>), "config.yaml"),
      );
    } catch {
      // Non-fatal — detection failure shouldn't block execution
    }
  }

  const { provider: resolvedProvider, resolvedFrom } = resolveProvider({
    explicitProvider,
    detectedProvider: detectedConfig?.provider,
    detectedModel: detectedConfig?.model,
    detectedBaseUrl: detectedConfig?.baseUrl,
    detectedHasApiKey: detectedConfig?.hasApiKey,
    detectedApiMode: detectedConfig?.apiMode,
    model,
  });

  // ── Load agent instructions file (Paperclip instruction bundles) ──────
  // Paperclip can materialize managed instructions into instructionsFilePath;
  // when present, reapply that bundle through Hermes's native system overlay.
  const instructionsFilePath = cfgString(config.instructionsFilePath);
  let agentInstructions = "";
  if (instructionsFilePath) {
    try {
      agentInstructions = await fs.readFile(instructionsFilePath, "utf-8");
      const loadedInstructionsLength = agentInstructions.length;
      const instructionsFileDir = path.dirname(instructionsFilePath);
      agentInstructions += `\nThe above agent instructions were loaded from ${instructionsFilePath}. Resolve any relative file references from ${instructionsFileDir}/.`;
      await ctx.onLog(
        "stdout",
        `[hermes] Loaded agent instructions from ${instructionsFilePath} (${loadedInstructionsLength} chars)\n`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Non-fatal: log to stdout with an explicit "Warning:" prefix so the
      // Paperclip UI doesn't render this as a red error (stderr output is
      // surfaced as an error signal even when execution continues).
      await ctx.onLog(
        "stdout",
        `[hermes] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }

  // ── Resume baseline ────────────────────────────────────────────────────
  // What the resumed session had used before this run, so the run is booked for
  // its own tokens only. If Hermes' store is readable and no longer has the
  // session (it prunes ended sessions after 90 days), Hermes would stop with
  // "Session not found" on every wake: start a new session instead.
  // Same env for the baseline and the post-run read, so they cannot drift.
  const userConfigEnv = config.env as Record<string, string> | undefined;
  const hermesStoreEnv: Record<string, string | undefined> = {
    // A remote store is found through the configured HERMES_HOME only, never
    // through the server's own environment.
    ...(remote ? {} : process.env),
    ...(userConfigEnv && typeof userConfigEnv === "object" ? userConfigEnv : {}),
  };
  const remoteSessions = remote ? createRemoteSessionReader(remote.run) : undefined;
  let resumeSessionId = prevSessionId;
  let resumeBaseline: SessionRow | null = null;
  if (persistSession && prevSessionId) {
    const rows = await readSessionLineage(hermesStoreEnv, prevSessionId, prevSessionId, remoteSessions);
    if (rows && rows.length === 0) {
      resumeSessionId = undefined;
      await ctx.onLog(
        "stdout",
        `[hermes] Warning: session ${prevSessionId} is not in Hermes' session store any more, so this run starts a new session.\n`,
      );
    } else {
      resumeBaseline = rows && rows.length > 0 ? rows[0] : null;
    }
  }

  // ── Build prompt ───────────────────────────────────────────────────────
  const userEnvForPrompt = config.env as Record<string, unknown> | undefined;
  const promptConfig: Record<string, unknown> = { ...config };
  if (!cfgString(promptConfig.paperclipApiUrl) && userEnvForPrompt && typeof userEnvForPrompt === "object") {
    const configuredPaperclipApiUrl = cfgEnvString(userEnvForPrompt.PAPERCLIP_API_URL);
    if (configuredPaperclipApiUrl) {
      promptConfig.paperclipApiUrl = configuredPaperclipApiUrl;
    }
  }

  // resumeSessionId is prevSessionId unless Hermes' state.db no longer has the
  // session (PAR-6886 3/3), so a pruned session starts fresh instead of failing.
  const sessionId = persistSession ? resumeSessionId : undefined;
  // PAR-6227: a flagged checkpoint resume (rotation with a handoff) takes the
  // resume-delta prompt even without a saved Hermes session.
  const checkpointEnabled = sessionCheckpointResumeEnabled();
  const checkpointResume =
    Boolean(sessionId) ||
    (checkpointEnabled &&
      (ctx as { context?: Record<string, unknown> }).context?.paperclipCheckpointResume === true);
  // Agent instructions travel in HERMES_EPHEMERAL_SYSTEM_PROMPT (upstream), so
  // they are no longer prepended to the query on fresh sessions.
  const prompt = buildPrompt(ctx, promptConfig, { resumedSession: checkpointResume });

  // ── Build command args ─────────────────────────────────────────────────
  // -Q is always used (see file header): quiet mode, response + session_id only.
  // config.quiet used to gate this and defaulted false, which leaked `Query:`.
  // The prompt can be over 128 KB; one argv string that long fails with spawn
  // E2BIG, so Hermes reads it from a private file (--query-file).
  // Remote: the prompt goes to a private file on the remote host instead.
  const remoteQuery = remote ? await stageRemoteQuery(remote.run, prompt) : null;
  const query = remoteQuery
    ? {
        args: ["--query-file", remoteQuery.queryFile],
        bytes: remoteQuery.bytes,
        via: "--query-file" as const,
        cleanup: async () => removeRemoteDir(remote!.run, remoteQuery.dir),
      }
    : await prepareQuery(prompt);
  const args: string[] = ["chat", ...query.args, "-Q"];

  if (model) {
    args.push("-m", model);
  }

  // Always pass --provider when we have a resolved one (not "auto").
  // "auto" means Hermes will decide on its own — no need to pass it.
  if (resolvedProvider !== "auto") {
    args.push("--provider", resolvedProvider);
  }

  if (toolsets) {
    args.push("-t", toolsets);
  }

  if (maxTurns && maxTurns > 0) {
    args.push("--max-turns", String(maxTurns));
  }

  if (worktreeMode) args.push("-w");
  if (checkpoints) args.push("--checkpoints");
  if (cfgBoolean(config.verbose) === true) args.push("-v");

  // Tag sessions as "tool" source so they don't clutter the user's session history.
  // Requires hermes-agent >= PR #3255 (feat/session-source-tag).
  args.push("--source", "tool");

  // Bypass Hermes dangerous-command approval prompts.
  // Paperclip agents run as non-interactive subprocesses with no TTY,
  // so approval prompts would always timeout and deny legitimate commands
  // (curl, python3 -c, etc.). Agents operate in a sandbox — the approval
  // system is designed for human-attended interactive sessions.
  args.push("--yolo");

  // Failed resumes remain failures. Do not infer a safe restart from CLI text.
  if (sessionId) {
    args.push("--resume", sessionId);
    // Without this, Hermes changes into the directory the old session recorded
    // instead of staying in the run's workspace.
    args.push("--no-restore-cwd");
  }
  // Init event carries session_id before any model work, so a kill still
  // leaves a checkpoint the next wake can resume (PAR-6227).
  if (persistSession && checkpointEnabled && !extraArgs?.includes("--format")) {
    args.push("--format", "stream-json");
  }
  if (extraArgs?.length) args.push(...extraArgs);

  // ── Build environment ──────────────────────────────────────────────────
  const userEnv = config.env as Record<string, string> | undefined;
  const env: Record<string, string> = {
    // Remote: never hand the server's environment (PATH, HOME, keys) to another host.
    ...(remote ? {} : (process.env as Record<string, string>)),
    ...(userEnv && typeof userEnv === "object" ? userEnv : {}),
    ...buildPaperclipEnv(ctx.agent, ctx.agentIdentity),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
  };

  // Scope the overlay to this child process. Read the current bundle on every
  // invocation; never infer its availability from a persisted session ID.
  // Preserve an operator's explicit overlay before Paperclip's instructions.
  env.HERMES_EPHEMERAL_SYSTEM_PROMPT = joinPromptSections([
    env.HERMES_EPHEMERAL_SYSTEM_PROMPT,
    agentInstructions,
    renderTemplate(HERMES_SYSTEM_PROMPT_TEMPLATE, {
      agent: ctx.agent,
    }),
  ]);

  if (ctx.runId) env.PAPERCLIP_RUN_ID = ctx.runId;

  // PAPERCLIP_API_KEY is never accepted from config — the harness-minted run
  // token is the only source of Paperclip API identity.
  delete env.PAPERCLIP_API_KEY;
  // Wake context travels in the prompt; drop both inherited and configured copies.
  delete env.PAPERCLIP_WAKE_PAYLOAD_JSON;
  if ((ctx as any).authToken) env.PAPERCLIP_API_KEY = (ctx as any).authToken;
  // Remote: the bridge env points the CLI at the callback bridge with its own token, not the host token.
  if (remote?.bridge) Object.assign(env, remote.bridge.env);

  // BUG FIX: Read task context from ctx.context (wake context), not ctx.config (adapter config)
  const ctxContext = (ctx as any).context || {};
  const envTaskId = cfgString(ctxContext.taskId) || cfgString(ctxContext.issueId) || cfgString(ctx.config?.taskId);
  if (envTaskId) env.PAPERCLIP_TASK_ID = envTaskId;
  const envWakeReason = cfgString(ctxContext.wakeReason) || cfgString(ctx.config?.wakeReason);
  if (envWakeReason) env.PAPERCLIP_WAKE_REASON = envWakeReason;
  const envCommentId = cfgString(ctxContext.commentId) || cfgString(ctxContext.wakeCommentId) || cfgString(ctx.config?.commentId);
  if (envCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = envCommentId;

  // ── Resolve working directory ──────────────────────────────────────────
  const workspace = ctx.context?.paperclipWorkspace;
  const workspaceCwd = workspace && typeof workspace === "object"
    ? cfgString((workspace as Record<string, unknown>).cwd)
    : undefined;
  const cwd = remote
    ? remote.cwd
    : cfgString(config.cwd) || workspaceCwd || cfgString(ctx.config?.workspaceDir) || ".";
  if (!remote) {
    try {
      await ensureAbsoluteDirectory(cwd);
    } catch {
      // Non-fatal
    }
  }

  // ── Log start ──────────────────────────────────────────────────────────
  await ctx.onLog(
    "stdout",
    `[hermes] Starting Hermes Agent (model=${model}, provider=${resolvedProvider} [${resolvedFrom}], timeout=${timeoutSec}s${maxTurns ? `, max_turns=${maxTurns}` : ""})\n`,
  );
  if (sessionId) {
    await ctx.onLog(
      "stdout",
      `[hermes] Resuming session: ${sessionId}\n`,
    );
  }

  // ── Execute ────────────────────────────────────────────────────────────
  // Hermes writes non-error noise to stderr (MCP init, INFO logs, etc).
  // Paperclip renders all stderr as red/error in the UI.
  // Wrap onLog to reclassify benign stderr lines as stdout, and to checkpoint
  // the session id from the stream-json init event before the process can die.
  let streamBuffer = "";
  let checkpointedSessionId: string | null = null;
  // Only the first id from a system/init event counts. Tool output can echo
  // other ids; a later one must never replace the real session.
  const noteInitSessionId = async (event: { type: string; subtype?: string; sessionId?: string }) => {
    if (checkpointedSessionId) return;
    if (event.type !== "system" || event.subtype !== "init") return;
    const sessionId = event.sessionId;
    if (!sessionId || !isPlausibleHermesSessionId(sessionId)) return;
    checkpointedSessionId = sessionId;
    if (ctx.onSessionCheckpoint && checkpointEnabled) {
      await ctx.onSessionCheckpoint({ sessionId });
    }
  };
  const forwardStdoutLines = async (raw: string, flushTail: boolean) => {
    streamBuffer += raw;
    const lines = streamBuffer.split("\n");
    streamBuffer = flushTail ? "" : (lines.pop() ?? "");
    const human: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const event = parseHermesStreamJsonLine(trimmed);
      if (!event) {
        human.push(line);
        continue;
      }
      await noteInitSessionId(event);
      const rendered = formatHermesStreamEventForLog(event);
      if (rendered) human.push(rendered);
    }
    if (human.length > 0) {
      await ctx.onLog("stdout", `${human.join("\n")}\n`);
    }
  };
  const wrappedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
    if (stream === "stderr") {
      const trimmed = chunk.trimEnd();
      // Benign patterns that should NOT appear as errors:
      // - Structured log lines: [timestamp] INFO/DEBUG/WARN: ...
      // - MCP server registration messages
      // - Python import/site noise
      const isBenign = /^\[?\d{4}[-/]\d{2}[-/]\d{2}T/.test(trimmed) || // structured timestamps
        /^[A-Z]+:\s+(INFO|DEBUG|WARN|WARNING)\b/.test(trimmed) || // log levels
        /Successfully registered all tools/.test(trimmed) ||
        /MCP [Ss]erver/.test(trimmed) ||
        /tool registered successfully/.test(trimmed) ||
        /Application initialized/.test(trimmed);
      if (isBenign) {
        return ctx.onLog("stdout", chunk);
      }
    }
    // Flag off: forward stdout untouched so the old path is byte-identical.
    if (stream === "stdout" && checkpointEnabled) {
      return forwardStdoutLines(chunk, false);
    }
    return ctx.onLog(stream, chunk);
  };

  // Never start Hermes with an environment string the kernel refuses; remove
  // the query file once the process ends.
  for (const dropped of guardEnvStrings(env)) {
    await ctx.onLog(
      "stdout",
      `[hermes] Warning: left out environment variable ${dropped.key} (${dropped.bytes} bytes is over the kernel limit for one string)\n`,
    );
  }
  await ctx.onLog("stdout", `[hermes] Prompt: ${query.bytes} bytes via ${query.via}\n`);
  let result: Awaited<ReturnType<typeof runChildProcess>>;
  try {
    if (remote && remoteQuery) {
      // Fail early with a clear message when hermes is not installed on the host.
      await ensureAdapterExecutionTargetCommandResolvable(hermesCmd, remote.target, remote.cwd, env, {
        timeoutSec: 30,
      });
      await ctx.onLog("stdout", `[hermes] Running on ${describeAdapterExecutionTarget(remote.target)} in ${remote.cwd}\n`);
      const wrapped = wrapWithPidFile(remoteQuery.pidFile, hermesCmd, args);
      result = await runAdapterExecutionTargetProcess(ctx.runId, remote.target, wrapped.command, wrapped.args, {
        cwd: remote.cwd,
        env,
        timeoutSec,
        graceSec,
        onLog: wrappedOnLog,
        onSpawn: ctx.onSpawn,
        onRuntimeProgress: ctx.onRuntimeProgress,
        runLogTail: remote.bridge?.runLogTail,
        settleRunDisposition: remote.bridge?.settleRunDisposition,
      });
      // Timeout or cancel only ends the local ssh client; end the remote tree too.
      if (result.timedOut || result.signal) {
        await killRemoteTree(remote.run, remoteQuery.pidFile, graceSec);
      }
    } else {
      result = await runChildProcess(ctx.runId, hermesCmd, args, {
        cwd,
        env,
        timeoutSec,
        graceSec,
        onLog: wrappedOnLog,
        onSpawn: ctx.onSpawn,
      });
    }
  } catch (err) {
    if (remote && remoteQuery) await killRemoteTree(remote.run, remoteQuery.pidFile, graceSec);
    throw err;
  } finally {
    await query.cleanup();
  }
  if (streamBuffer.trim()) {
    await forwardStdoutLines("\n", true);
  }

  // ── Parse output ───────────────────────────────────────────────────────
  const parsed = parseHermesOutput(result.stdout || "", result.stderr || "");
  // The regexes above never match current Hermes output and read prose as cost.
  // Take the session id from the lines Hermes prints, and tokens and cost from
  // its own session record.
  const metered = await resolveRun(result.stdout || "", result.stderr || "", hermesStoreEnv, resumeBaseline, remoteSessions);
  parsed.sessionId = metered.sessionId ?? undefined;
  parsed.usage = metered.usage;
  parsed.costUsd = metered.costUsd;
  if (metered.usage) {
    await ctx.onLog(
      "stdout",
      `[hermes] Usage: input ${metered.usage.inputTokens}, cached ${metered.usage.cachedInputTokens ?? 0}, output ${metered.usage.outputTokens}${metered.costUsd !== undefined ? `, cost $${metered.costUsd.toFixed(4)} (Hermes estimate)` : ""}\n`,
    );
  }
  const streamed = parseHermesStreamJsonOutput(`${result.stdout || ""}\n${result.stderr || ""}`);
  if (!parsed.sessionId && (streamed.sessionId || checkpointedSessionId)) {
    parsed.sessionId = streamed.sessionId || checkpointedSessionId || undefined;
  }
  if (!parsed.response && streamed.response) parsed.response = streamed.response;
  if (!parsed.usage && streamed.usage) parsed.usage = streamed.usage;
  if (!parsed.errorMessage && streamed.errorMessage) parsed.errorMessage = streamed.errorMessage;

  await ctx.onLog(
    "stdout",
    `[hermes] Exit code: ${result.exitCode ?? "null"}, timed out: ${result.timedOut}\n`,
  );
  if (parsed.sessionId) {
    await ctx.onLog("stdout", `[hermes] Session: ${parsed.sessionId}\n`);
  }

  // ── Build result ───────────────────────────────────────────────────────
  const executionResult: AdapterExecutionResult = {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    provider: resolvedProvider,
    model,
  };

  if (parsed.errorMessage) {
    executionResult.errorMessage = parsed.errorMessage;
  } else if (!result.timedOut && typeof result.exitCode === "number" && result.exitCode !== 0) {
    executionResult.errorMessage = `Hermes exited with code ${result.exitCode}`;
  }

  if (parsed.usage) {
    executionResult.usage = parsed.usage;
    // This is the run's own usage, not a session total (the host would
    // otherwise subtract the previous run's).
    executionResult.usageBasis = "per_run";
    // Unset means "subscription_included": Hermes agents run on the company's
    // subscription, so the host keeps the tokens and books no cents. Set
    // adapterConfig.billingType (e.g. "api") to override.
    executionResult.billingType =
      (cfgString(config.billingType) as AdapterExecutionResult["billingType"]) || "subscription_included";
  }

  if (parsed.costUsd !== undefined) {
    executionResult.costUsd = parsed.costUsd;
  }

  // Summary from agent response. An echo-only stdout is not a summary.
  if (parsed.response) {
    executionResult.summary = parsed.response.slice(0, 2000);
  }

  const echoOnly =
    STRIP_HERMES_QUERY_ECHO &&
    !parsed.response &&
    stdoutStartsWithQueryEcho(result.stdout || "");

  // Set resultJson so Paperclip can persist run metadata (used for UI display + auto-comments)
  executionResult.resultJson = {
    result: parsed.response || "",
    session_id: parsed.sessionId || null,
    usage: parsed.usage || null,
    cost_usd: parsed.costUsd ?? null,
    ...(echoOnly ? { agentPromptEchoWithheld: true } : {}),
  };

  // Store session ID for next run
  if (persistSession && parsed.sessionId) {
    executionResult.sessionParams = {
      sessionId: parsed.sessionId,
      ...(remote ? { remoteExecution: adapterExecutionTargetSessionIdentity(remote.identity) } : {}),
    };
    executionResult.sessionDisplayId = parsed.sessionId.slice(0, 16);
  }

  return executionResult;
}
