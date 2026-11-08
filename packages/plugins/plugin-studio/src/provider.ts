/**
 * Generation providers. Higgsfield REST only for now, behind a small interface so own keys or other providers can
 * follow. Native fetch: `ctx.http.fetch` has a 30 s limit.
 *
 * The API, as verified live by hf.py (2026-10-22, 2026-10-26): v2 routes use `Authorization: Key <id>:<secret>`;
 * bodies are flat JSON; there is no balance endpoint, `estimate` is free, and HTTP 402 means really out of credits.
 */
import { randomUUID } from "node:crypto";
import { StudioError } from "./errors.js";

export const HIGGSFIELD_BASE = "https://platform.higgsfield.ai";

/**
 * `out_of_credits`, `rejected`: nothing was charged. `unavailable`: the provider answered with a server error and
 * nothing started, so a retry is safe. `unknown`: no answer, so the job may have started and a retry could pay twice.
 */
export type ProviderErrorCode = "out_of_credits" | "rejected" | "unavailable" | "unknown";

export class ProviderError extends Error {
  constructor(message: string, readonly code: ProviderErrorCode) {
    super(message);
    this.name = "ProviderError";
  }
}

export type JobState = { state: "pending" } | { state: "done"; urls: string[]; credits: number | null } | { state: "failed"; message: string };

export interface GenerationProvider {
  readonly key: string;
  estimate(model: string, body: Record<string, unknown>): Promise<number>;
  submit(model: string, body: Record<string, unknown>): Promise<string>;
  status(jobId: string): Promise<JobState>;
}

const MODEL = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/i;

export function assertModel(model: string): void {
  if (!MODEL.test(model) || model.includes("..") || model.length > 120) {
    throw new StudioError(`"${model}" is not a model id. Example: higgsfield-ai/soul/v2/standard`, "bad_model");
  }
}

/** A price must be a finite number above zero: 0, a negative or NaN is "no price", never a free job. */
export function creditsIn(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  for (const key of ["credits", "estimated_credits", "cost", "total_credits"]) {
    const value = (body as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) > 0) return Number(value);
  }
  return null;
}

/** File URLs in a result, the original first (`raw`, then `url`, then the typed fields), without repeats. */
export function outputUrls(node: unknown): string[] {
  const groups: Record<"raw" | "url" | "image_url" | "video_url", string[]> = { raw: [], url: [], image_url: [], video_url: [] };
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (key in groups && typeof child === "string" && /^https?:\/\//.test(child)) groups[key as keyof typeof groups].push(child);
        else walk(child);
      }
    }
  };
  walk(node);
  // A provider may echo the request: a signed link to one of our own reference files is never an output.
  return [...new Set([...groups.raw, ...groups.url, ...groups.image_url, ...groups.video_url])].filter((url) => !isStorageLink(url));
}

function isStorageLink(url: string): boolean {
  return /r2\.cloudflarestorage\.com|X-Amz-Signature=/i.test(url);
}

/** Provider answers can echo the request: no link (a signed reference link included) reaches an error, agent or log. */
export function scrubLinks(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, "<link>");
}

/** Set PIB_STUDIO_FAKE_PROVIDER=1 for local runs: generations then spend nothing and never reach Higgsfield. */
export function fakeProviderOn(): boolean {
  return process.env.PIB_STUDIO_FAKE_PROVIDER === "1";
}

/** A 1x1 PNG: what the fake provider's jobs "make". */
export const FAKE_OUTPUT_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/**
 * A provider that spends nothing, for tests and local runs. Every job is done at once. It keeps how many jobs it
 * took, never the request bodies, because those carry signed reference links.
 */
export function fakeProvider(creditsEach = 1): GenerationProvider & { readonly submitted: () => number } {
  let count = 0;
  return {
    key: "fake",
    submitted: () => count,
    async estimate(model) {
      assertModel(model);
      return creditsEach;
    },
    async submit(model) {
      assertModel(model);
      count += 1;
      return `fake-${randomUUID()}`;
    },
    async status() {
      return { state: "done", urls: ["https://fake-provider.invalid/output.png"], credits: null };
    },
  };
}

export function higgsfieldProvider(apiKey: string, base = HIGGSFIELD_BASE): GenerationProvider {
  if (!apiKey.includes(":")) throw new StudioError("The Higgsfield key must be in <key-id>:<key-secret> form.", "not_configured");

  async function call(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 60_000): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: { Authorization: `Key ${apiKey}`, "Content-Type": "application/json", "User-Agent": "pib-studio/1.0" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ProviderError(`Higgsfield did not answer: ${error instanceof Error ? error.name : "network error"}`, "unknown");
    }
    const text = await res.text().catch(() => "");
    if (res.status === 402) throw new ProviderError("The Higgsfield API balance is out of credits.", "out_of_credits");
    if (res.status === 401 || res.status === 403) throw new ProviderError(`Higgsfield refused the key (HTTP ${res.status}).`, "rejected");
    if (res.status >= 500 || res.status === 429) throw new ProviderError(`Higgsfield is unavailable (HTTP ${res.status}).`, "unavailable");
    if (!res.ok) throw new ProviderError(`Higgsfield refused the request (HTTP ${res.status}): ${scrubLinks(text).slice(0, 300)}`, "rejected");
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new ProviderError("Higgsfield answered with something that is not JSON.", "unavailable");
    }
  }

  return {
    key: "higgsfield",
    async estimate(model, body) {
      const credits = creditsIn(await call("POST", `/estimate/${model}`, body));
      if (credits === null) throw new StudioError(`Higgsfield gave no price for ${model}, so nothing was started.`, "no_price");
      return credits;
    },
    async submit(model, body) {
      const answer = (await call("POST", `/${model}`, body)) as Record<string, unknown>;
      const id = answer.id ?? answer.request_id;
      if (typeof id !== "string" || !id) throw new ProviderError("Higgsfield accepted the job but gave no id.", "unknown");
      return id;
    },
    async status(jobId) {
      const answer = (await call("GET", `/requests/${encodeURIComponent(jobId)}/status`, undefined, 30_000)) as Record<string, unknown>;
      const state = String(answer.status ?? "").toLowerCase();
      if (["completed", "succeeded", "success"].includes(state)) return { state: "done", urls: outputUrls(answer), credits: creditsIn(answer) };
      if (["failed", "error", "canceled", "cancelled", "nsfw"].includes(state)) return { state: "failed", message: `Higgsfield reported ${state}.` };
      return { state: "pending" };
    },
  };
}
