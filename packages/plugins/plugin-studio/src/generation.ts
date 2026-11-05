/**
 * The generation queue. A request is priced, checked against the cap and reserved, then waits in the queue. A
 * one-minute job submits, polls and stores, because renders outlast any action or tool call. Each unit of a batch is
 * its own row, so each is charged, refunded and retried on its own.
 *
 *   queued -> submitting -> submitted -> storing -> succeeded
 *                                    \-> failed
 *
 * Money rules:
 * - Refund only when the provider clearly charged nothing (refused, out of credits, reported failure).
 * - A submission that got no answer may have started. It's never sent again, and its credits stay spent.
 * - A worker restart can't double-spend: a row left in `submitting` is failed with its credits kept, never resubmitted.
 */
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { scopeOfRow, type ClientScope } from "@partnersinbiz/pib-plugin-kit";
import { storeAsset } from "./assets.js";
import { StudioConfig } from "./config.js";
import { credits, iso, num, table } from "./db.js";
import { errorText, StudioError } from "./errors.js";
import { adjust, assertFits, capCheck, currentPeriod, refund, reserve, withCompanyLock, type LedgerTarget } from "./ledger.js";
import { DEFAULT_PRESET_MODEL, DEFAULT_PRESET_RATIO, PHOTO_PRESETS, buildPhotoPresetPrompt, getPhotoPreset } from "./presets.js";
import { assertModel, higgsfieldProvider, ProviderError, type GenerationProvider } from "./provider.js";
import { assertReachable, scopeForWork, scopeInput, type ResolvedScope } from "./scope.js";
import { MAX_ASSET_BYTES, sniffMime } from "./storage.js";

export const MAX_BATCH = 8;
const MAX_PARAMS_BYTES = 16 * 1024;
const MAX_IN_FLIGHT = 4;
const LOST_AFTER_MS = 15 * 60 * 1000;
const JOB_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MAX_STORE_ATTEMPTS = 10;
const MAX_RETRIES = 20;
const OUT_OF_CREDITS_PAUSE_MS = 30 * 60 * 1000;

export interface Runtime {
  provider(config: StudioConfig): Promise<GenerationProvider>;
  download(url: string): Promise<Uint8Array<ArrayBuffer>>;
  now(): number;
}

export interface GenerationRow {
  id: string;
  group_id: string;
  company_id: string;
  client_kind: string | null;
  client_ref: string | null;
  client_name: string | null;
  project_id: string | null;
  issue_id: string | null;
  agent_id: string | null;
  user_id: string | null;
  provider: string;
  model: string;
  prompt: string;
  params: unknown;
  name: string | null;
  status: string;
  period: string;
  estimated_credits: unknown;
  actual_credits: unknown;
  provider_job_id: string | null;
  output_url: string | null;
  attempts: unknown;
  asset_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: unknown;
  updated_at: unknown;
  submitted_at: unknown;
  finished_at: unknown;
}

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const low = ip.toLowerCase();
    if (low.startsWith("::ffff:")) return isPrivateAddress(low.slice(7));
    return low === "::1" || low === "::" || /^f[cd]/.test(low) || /^fe[89ab]/.test(low);
  }
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

export interface PinnedAddress {
  address: string;
  family: number;
}

export interface DownloadResponse {
  status: number;
  header(name: string): string | null;
  body: AsyncIterable<Uint8Array>;
  /** Drops the connection; safe to call after the body was read. */
  close(): void;
}

/** How a download reaches the network. Swapped in tests; the default never follows a redirect. */
export interface DownloadTransport {
  resolve(host: string): Promise<PinnedAddress[]>;
  get(url: URL, pinned: PinnedAddress, signal: AbortSignal): Promise<DownloadResponse>;
}

/** A lookup that always answers with the address that was checked, so the connection can't be rebound by a second DNS answer. */
export function pinnedLookup(pinned: PinnedAddress): LookupFunction {
  return (_host, options, callback) => {
    if (options.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
    else callback(null, pinned.address, pinned.family);
  };
}

export const httpsTransport: DownloadTransport = {
  async resolve(host) {
    const family = isIP(host);
    if (family) return [{ address: host, family }];
    return lookup(host, { all: true, verbatim: true });
  },
  get(url, pinned, signal) {
    return new Promise((resolve, reject) => {
      // node:https never follows a redirect, and TLS still checks the certificate against the URL's own host name.
      const req = httpsRequest(url, { method: "GET", signal, headers: { "User-Agent": "pib-studio/1.0" }, lookup: pinnedLookup(pinned) }, (res) => {
        resolve({
          status: res.statusCode ?? 0,
          header: (name) => {
            const value = res.headers[name.toLowerCase()];
            return (Array.isArray(value) ? value[0] : value) ?? null;
          },
          body: res,
          close: () => res.destroy(),
        });
      });
      req.on("error", reject);
      req.end();
    });
  },
};

export interface DownloadOptions {
  transport?: DownloadTransport;
  maxBytes?: number;
  timeoutMs?: number;
}

/**
 * A provider's result URL is still a URL from outside: https and a public address only, one request to the address
 * that was checked (no redirects, no second lookup), and a size limit enforced while the body streams in.
 */
export async function downloadOutput(url: string, options: DownloadOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
  const transport = options.transport ?? httpsTransport;
  const maxBytes = options.maxBytes ?? MAX_ASSET_BYTES;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("The result is not on an https URL");
  const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
  const addresses = await transport.resolve(host);
  if (!addresses[0] || addresses.some((a) => isPrivateAddress(a.address))) throw new Error("The result URL points at a private address");
  const res = await transport.get(parsed, addresses[0], AbortSignal.timeout(options.timeoutMs ?? 300_000));
  try {
    if (res.status >= 300 && res.status < 400) throw new Error(`The result URL redirects (HTTP ${res.status}); Studio doesn't follow redirects`);
    if (res.status < 200 || res.status >= 300) throw new Error(`Download failed: HTTP ${res.status}`);
    const tooBig = "The result is larger than Studio stores";
    if (Number(res.header("content-length") ?? 0) > maxBytes) throw new Error(tooBig);
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.byteLength;
      if (total > maxBytes) throw new Error(tooBig);
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    res.close();
  }
}

export const defaultRuntime: Runtime = {
  provider: async (config) => higgsfieldProvider(await config.higgsfieldKey()),
  download: (url) => downloadOutput(url),
  now: () => Date.now(),
};

function target(row: GenerationRow): LedgerTarget {
  return { generationId: row.id, companyId: row.company_id, clientKind: row.client_kind, clientRef: row.client_ref, period: row.period };
}

export interface Actor {
  agentId?: string | null;
  runId?: string | null;
  userId?: string | null;
  issueId?: string | null;
  projectId?: string | null;
}

function requestBody(params: Record<string, unknown>): { model: string; prompt: string; body: Record<string, unknown> } {
  const presetId = params.preset === undefined || params.preset === null || params.preset === "" ? null : params.preset;
  const preset = presetId === null ? null : getPhotoPreset(presetId);
  if (presetId !== null && !preset) throw new StudioError(`Unknown preset ${String(presetId)}. Known presets: ${PHOTO_PRESETS.map((p) => p.id).join(", ")}.`, "unknown_preset");
  const model = String(params.model ?? (preset ? DEFAULT_PRESET_MODEL : "")).trim();
  assertModel(model);
  // With a preset, "prompt" is only the optional note; the preset builds the wording.
  const prompt = (preset ? buildPhotoPresetPrompt(preset, String(params.prompt ?? "")) : String(params.prompt ?? "")).trim();
  if (!prompt) throw new StudioError("prompt is required.", "bad_request");
  const extra = params.params ?? {};
  if (typeof extra !== "object" || Array.isArray(extra) || extra === null) throw new StudioError("params must be an object of the model's own fields.", "bad_request");
  const defaults = preset ? { aspect_ratio: DEFAULT_PRESET_RATIO } : {};
  const body = { ...defaults, ...(extra as Record<string, unknown>), prompt };
  if (JSON.stringify(body).length > MAX_PARAMS_BYTES) throw new StudioError("The request is too long.", "bad_request");
  return { model, prompt, body };
}

export async function estimateGeneration(ctx: PluginContext, companyId: string, params: Record<string, unknown>, actor: Actor, runtime = defaultRuntime) {
  const { model, body } = requestBody(params);
  const batch = batchSize(params);
  const where = await scopeForWork(ctx, companyId, scopeInput(params), actor.projectId ?? null);
  const each = await (await runtime.provider(new StudioConfig(ctx, companyId))).estimate(model, body);
  const check = await capCheck(ctx, companyId, where.scope);
  return { model, batchSize: batch, creditsEach: each, creditsTotal: credits(each * batch), monthlyCap: check.cap.monthlyCredits, capSource: check.cap.source, usedThisMonth: check.used, remaining: check.remaining };
}

function batchSize(params: Record<string, unknown>): number {
  const batch = params.batchSize === undefined ? 1 : Number(params.batchSize);
  if (!Number.isInteger(batch) || batch < 1 || batch > MAX_BATCH) throw new StudioError(`batchSize must be a whole number from 1 to ${MAX_BATCH}.`, "bad_request");
  return batch;
}

export async function requestGeneration(ctx: PluginContext, companyId: string, params: Record<string, unknown>, actor: Actor, runtime = defaultRuntime) {
  const { model, prompt, body } = requestBody(params);
  const batch = batchSize(params);
  const projectId = actor.projectId ?? null;
  const where: ResolvedScope = await scopeForWork(ctx, companyId, scopeInput(params), projectId);
  const provider = await runtime.provider(new StudioConfig(ctx, companyId));
  const each = await provider.estimate(model, body);
  const total = credits(each * batch);
  const name = typeof params.name === "string" && params.name.trim() ? params.name.trim().slice(0, 200) : (getPhotoPreset(params.preset)?.label ?? prompt.slice(0, 80));
  const groupId = randomUUID();
  const ids = Array.from({ length: batch }, () => randomUUID());
  const period = currentPeriod(new Date(runtime.now()));

  const after = await withCompanyLock(companyId, async () => {
    const check = await capCheck(ctx, companyId, where.scope, period);
    assertFits(check, total);
    for (const id of ids) {
      await ctx.db.execute(
        `INSERT INTO ${table(ctx, "generations")} (id, group_id, company_id, client_kind, client_ref, client_name, project_id, issue_id, agent_id, run_id, user_id, provider, model, prompt, params, name, status, period, estimated_credits)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, 'queued', $17, $18)`,
        [id, groupId, companyId, where.scope?.kind ?? null, where.scope?.id ?? null, where.client?.name ?? null, projectId, actor.issueId ?? null, actor.agentId ?? null, actor.runId ?? null, actor.userId ?? null, provider.key, model, prompt, JSON.stringify(body), name, period, each],
      );
      await reserve(ctx, { generationId: id, companyId, clientKind: where.scope?.kind ?? null, clientRef: where.scope?.id ?? null, period }, each);
    }
    return credits(check.used + total);
  });

  return { groupId, generationIds: ids, model, batchSize: batch, status: "queued", creditsReserved: total, usedThisMonthAfter: after, client: where.scope };
}

function generationOut(row: GenerationRow) {
  return {
    id: row.id,
    groupId: row.group_id,
    status: row.status,
    model: row.model,
    assetId: row.asset_id,
    estimatedCredits: num(row.estimated_credits),
    actualCredits: row.actual_credits == null ? null : num(row.actual_credits),
    error: row.error_message,
    errorCode: row.error_code,
    createdAt: iso(row.created_at),
    finishedAt: iso(row.finished_at),
  };
}

export async function generationStatus(ctx: PluginContext, companyId: string, params: Record<string, unknown>, projectId: string | null) {
  const id = String(params.generationId ?? params.groupId ?? "").trim();
  if (!id) throw new StudioError("generationId or groupId is required.", "bad_request");
  const rows = await ctx.db.query<GenerationRow>(`SELECT * FROM ${table(ctx, "generations")} WHERE company_id = $1 AND (id = $2 OR group_id = $2) ORDER BY created_at`, [companyId, id]);
  if (!rows[0]) throw new StudioError(`Generation ${id} was not found in this company.`, "unknown_generation");
  await assertReachable(ctx, companyId, scopeOfRow(rows[0]), projectId);
  return { generations: rows.map(generationOut) };
}

async function update(ctx: PluginContext, row: GenerationRow, fields: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(fields);
  const sets = keys.map((key, i) => `${key} = $${i + 2}`).join(", ");
  await ctx.db.execute(`UPDATE ${table(ctx, "generations")} SET ${sets}, updated_at = now() WHERE id = $1`, [row.id, ...keys.map((key) => fields[key])]);
  Object.assign(row, fields);
}

async function fail(ctx: PluginContext, runtime: Runtime, row: GenerationRow, code: string, message: string, options: { refund: boolean }): Promise<void> {
  await update(ctx, row, { status: "failed", error_code: code, error_message: message.slice(0, 500), finished_at: new Date(runtime.now()).toISOString() });
  if (options.refund) await refund(ctx, target(row), num(row.estimated_credits));
  await reportIfGroupDone(ctx, row);
}

const OPEN = ["queued", "submitting", "submitted", "storing"];

/**
 * One comment on the issue when a whole batch is settled, then a wake for the assigned agent: a plugin's comment wakes
 * nobody by itself. Agents don't need to poll. The result is already saved, so a refused wake (no agent assigned, issue
 * closed, blocked or over budget) only gets logged.
 */
async function reportIfGroupDone(ctx: PluginContext, row: GenerationRow): Promise<void> {
  if (!row.issue_id) return;
  try {
    const rows = await ctx.db.query<GenerationRow>(`SELECT * FROM ${table(ctx, "generations")} WHERE group_id = $1 ORDER BY created_at`, [row.group_id]);
    if (rows.some((r) => OPEN.includes(r.status))) return;
    const lines = rows.map((r) => (r.status === "succeeded" ? `- Asset \`${r.asset_id}\` (${r.name ?? "untitled"})` : `- Failed: ${r.error_message ?? "unknown"}`));
    const done = rows.filter((r) => r.status === "succeeded").length;
    await ctx.issues.createComment(row.issue_id, `Studio finished ${done} of ${rows.length} from ${row.model}.\n${lines.join("\n")}\n\nOpen a file with \`studio-get-asset\`.`, row.company_id);
  } catch (error) {
    ctx.logger.info("Studio result comment skipped", { error: errorText(error) });
    return;
  }
  try {
    await ctx.issues.requestWakeup(row.issue_id, row.company_id, { reason: "studio_generation_finished", idempotencyKey: `studio-finished:${row.group_id}` });
  } catch (error) {
    ctx.logger.info("Studio wake skipped", { issueId: row.issue_id, error: errorText(error) });
  }
}

/** Stops one company's queue for a while once Higgsfield says the balance is empty. Forgotten on restart, by design. */
const pausedUntil = new Map<string, number>();
let running = false;

export function resetQueueStateForTests(): void {
  pausedUntil.clear();
  running = false;
}

export async function processQueue(ctx: PluginContext, runtime: Runtime = defaultRuntime): Promise<{ submitted: number; stored: number; failed: number }> {
  const totals = { submitted: 0, stored: 0, failed: 0 };
  if (running) return totals;
  running = true;
  const handles = new Map<string, { config: StudioConfig; provider: Promise<GenerationProvider> }>();
  const handle = (companyId: string) => {
    let found = handles.get(companyId);
    if (!found) {
      const config = new StudioConfig(ctx, companyId);
      found = { config, provider: runtime.provider(config) };
      handles.set(companyId, found);
    }
    return found;
  };
  try {
    const open = await ctx.db.query<GenerationRow>(
      `SELECT * FROM ${table(ctx, "generations")} WHERE status IN ('queued', 'submitting', 'submitted', 'storing') ORDER BY created_at LIMIT 200`,
    );
    const inFlight = new Map<string, number>();
    const count = (companyId: string, by: number) => inFlight.set(companyId, (inFlight.get(companyId) ?? 0) + by);
    for (const row of open) if (row.status === "submitting" || row.status === "submitted") count(row.company_id, 1);

    for (const row of open) {
      try {
        if (row.status === "submitting") {
          if (runtime.now() - new Date(String(row.updated_at)).getTime() > LOST_AFTER_MS) {
            count(row.company_id, -1);
            await fail(ctx, runtime, row, "lost_submission", "Studio stopped while sending this to the provider, so it may have started. It wasn't sent again, and its credits stay spent.", { refund: false });
            totals.failed += 1;
          }
        } else if (row.status === "submitted") {
          if (await poll(ctx, runtime, row, await handle(row.company_id).provider)) count(row.company_id, -1);
        }
      } catch (error) {
        ctx.logger.info("Studio poll failed", { generationId: row.id, error: errorText(error) });
      }
    }

    // Stored one at a time: a video is held in memory while it moves.
    for (const row of open) {
      if (row.status !== "storing") continue;
      if (await store(ctx, runtime, row, handle(row.company_id).config)) totals.stored += 1;
      else if ((row.status as string) === "failed") totals.failed += 1;
    }

    for (const row of open) {
      if (row.status !== "queued") continue;
      const until = pausedUntil.get(row.company_id);
      if (until && until > runtime.now()) continue;
      if ((inFlight.get(row.company_id) ?? 0) >= MAX_IN_FLIGHT) continue;
      try {
        const outcome = await submit(ctx, runtime, row, await handle(row.company_id).provider);
        if (outcome === "submitted") {
          count(row.company_id, 1);
          totals.submitted += 1;
        } else if (outcome === "failed") totals.failed += 1;
      } catch (error) {
        // Settings are missing or unreadable: nothing was sent, so it stays queued.
        ctx.logger.info("Studio submit held back", { generationId: row.id, error: errorText(error) });
      }
    }
  } finally {
    running = false;
  }
  return totals;
}

async function submit(ctx: PluginContext, runtime: Runtime, row: GenerationRow, provider: GenerationProvider): Promise<"submitted" | "failed" | "waiting" | "skipped"> {
  // Survives a restart between the insert and its ledger row.
  await reserve(ctx, target(row), num(row.estimated_credits));
  const claim = await ctx.db.execute(`UPDATE ${table(ctx, "generations")} SET status = 'submitting', updated_at = now() WHERE id = $1 AND status = 'queued'`, [row.id]);
  if (!claim.rowCount) return "skipped";
  row.status = "submitting";
  try {
    const body = typeof row.params === "string" ? (JSON.parse(row.params) as Record<string, unknown>) : (row.params as Record<string, unknown>);
    const jobId = await provider.submit(row.model, body);
    await update(ctx, row, { status: "submitted", provider_job_id: jobId, submitted_at: new Date(runtime.now()).toISOString() });
    return "submitted";
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    if (error.code === "unavailable" && num(row.attempts) + 1 < MAX_RETRIES) {
      await update(ctx, row, { status: "queued", attempts: num(row.attempts) + 1, error_message: error.message });
      return "waiting";
    }
    if (error.code === "out_of_credits") pausedUntil.set(row.company_id, runtime.now() + OUT_OF_CREDITS_PAUSE_MS);
    if (error.code === "unknown") {
      await fail(ctx, runtime, row, "unknown_submission", "The provider didn't answer, so this may have started. It wasn't sent again, and its credits stay spent.", { refund: false });
    } else {
      await fail(ctx, runtime, row, error.code, error.message, { refund: true });
    }
    return "failed";
  }
}

/** True when the row left the in-flight set. */
async function poll(ctx: PluginContext, runtime: Runtime, row: GenerationRow, provider: GenerationProvider): Promise<boolean> {
  if (!row.provider_job_id) {
    await fail(ctx, runtime, row, "lost_submission", "No provider job id was saved. Its credits stay spent.", { refund: false });
    return true;
  }
  let state;
  try {
    state = await provider.status(row.provider_job_id);
  } catch (error) {
    if (error instanceof ProviderError && error.code === "rejected" && num(row.attempts) + 1 >= MAX_RETRIES) {
      await fail(ctx, runtime, row, "status_refused", error.message, { refund: false });
      return true;
    }
    await update(ctx, row, { attempts: num(row.attempts) + 1 });
    return false;
  }
  if (state.state === "failed") {
    await fail(ctx, runtime, row, "provider_failed", state.message, { refund: true });
    return true;
  }
  if (state.state === "pending") {
    const started = new Date(String(row.submitted_at ?? row.updated_at)).getTime();
    if (runtime.now() - started > JOB_TIMEOUT_MS) {
      await fail(ctx, runtime, row, "timed_out", "The provider hadn't finished after 2 hours. Its credits stay spent.", { refund: false });
      return true;
    }
    return false;
  }
  const url = state.urls[0];
  if (!url) {
    await fail(ctx, runtime, row, "no_output", "The provider finished but gave no file. Its credits stay spent.", { refund: false });
    return true;
  }
  await update(ctx, row, { status: "storing", output_url: url, actual_credits: state.credits, attempts: 0 });
  return true;
}

async function store(ctx: PluginContext, runtime: Runtime, row: GenerationRow, config: StudioConfig): Promise<boolean> {
  try {
    const bytes = await runtime.download(String(row.output_url));
    const mime = sniffMime(bytes);
    if (!mime) throw new StudioError("The provider's file is not an image or video Studio stores.", "unsupported_type");
    const scope: ClientScope = scopeOfRow(row);
    // The generation's id is the asset's id, so repeating this after a restart lands on the same file and row.
    await storeAsset(ctx, config, {
      id: row.id,
      companyId: row.company_id,
      scope,
      clientName: row.client_name,
      projectId: row.project_id,
      issueId: row.issue_id,
      name: row.name ?? row.prompt.slice(0, 80),
      source: "generated",
      sourceRef: `generation:${row.id}`,
      generationId: row.id,
      agentId: row.agent_id,
      userId: row.user_id,
      bytes,
      mime,
    });
    const actual = row.actual_credits == null ? null : num(row.actual_credits);
    if (actual !== null && actual !== num(row.estimated_credits)) await adjust(ctx, target(row), credits(actual - num(row.estimated_credits)));
    await update(ctx, row, { status: "succeeded", asset_id: row.id, finished_at: new Date(runtime.now()).toISOString(), error_message: null, error_code: null });
    await reportIfGroupDone(ctx, row);
    return true;
  } catch (error) {
    const attempts = num(row.attempts) + 1;
    if (attempts >= MAX_STORE_ATTEMPTS) {
      await fail(ctx, runtime, row, "store_failed", `The file was made but couldn't be saved: ${errorText(error)}. Its credits stay spent.`, { refund: false });
    } else {
      await update(ctx, row, { attempts, error_message: errorText(error).slice(0, 500) });
    }
    return false;
  }
}
