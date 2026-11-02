/**
 * Bounded copy of the wake payload JSON for PAPERCLIP_WAKE_PAYLOAD_JSON.
 *
 * Linux refuses to start a process when ONE environment string is longer than
 * 131072 bytes (MAX_ARG_STRLEN, spawn E2BIG). The wake payload carries the
 * whole task history (executionContinuation.messages, 100-177 KB). The run
 * prompt already holds the full text, so the env copy is bounded: oldest
 * history goes first, the newest messages and every message the current
 * request points at stay, and an "envTruncation" note says what was dropped.
 * A payload under the limit is returned unchanged.
 *
 * Ported from the pib-ops host patch hermes-e2big ([wake-bound]).
 * Upstream: paperclipai/paperclip#13872, #13144.
 */

export const WAKE_ENV_DEFAULT_MAX_BYTES = 120000;
export const WAKE_ENV_MIN_MAX_BYTES = 8000;
export const WAKE_ENV_MAX_MAX_BYTES = 125000;

type Json = Record<string, any>;

export function wakeEnvMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(String(env.PIB_WAKE_PAYLOAD_MAX_BYTES ?? ""), 10);
  return Number.isFinite(raw)
    ? Math.min(Math.max(raw, WAKE_ENV_MIN_MAX_BYTES), WAKE_ENV_MAX_MAX_BYTES)
    : WAKE_ENV_DEFAULT_MAX_BYTES;
}

function bytesOf(value: unknown): number {
  return Buffer.byteLength(typeof value === "string" ? value : (JSON.stringify(value) ?? ""), "utf8");
}

function clip<T>(text: T, maxChars: number): T | string {
  if (typeof text !== "string" || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} characters here; the full text is in the run prompt and the issue]`;
}

function newest<T>(list: T[] | undefined, count: number): T[] | undefined {
  return Array.isArray(list) && list.length > count ? list.slice(list.length - count) : list;
}

function clipResult(value: unknown, maxBytes: number): unknown {
  if (value === undefined || value === null) return value;
  const bytes = bytesOf(value);
  return bytes > maxBytes ? { truncated: true, bytes } : value;
}

function protectedMessageIds(payload: Json, continuation: Json, messages: Json[]): Set<string> {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value) ids.add(value);
  };
  for (const id of Array.isArray(continuation.originCommentIds) ? continuation.originCommentIds : []) add(id);
  for (const id of Array.isArray(payload.commentIds) ? payload.commentIds : []) add(id);
  add(payload.latestCommentId);
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (
      message &&
      message.authorType === "user" &&
      !message.createdByRunId &&
      !message.deleted &&
      typeof message.body === "string" &&
      message.body.trim()
    ) {
      add(message.id);
      break;
    }
  }
  for (const message of messages.slice(-2)) add(message?.id);
  return ids;
}

interface Notes {
  truncatedForEnv: true;
  originalBytes: number;
  maxBytes: number;
  droppedMessages: number;
  droppedMessageBytes: number;
  clipped: string[];
  note: string;
}

function trimMessages(payload: Json, continuation: Json, maxBytes: number, notes: Notes): void {
  const owners = [continuation.resumeDelta, continuation].filter(
    (owner): owner is Json => Boolean(owner) && typeof owner === "object" && Array.isArray(owner.messages),
  );
  if (owners.length === 0) return;
  const originals: Json[][] = owners.map((owner) => owner.messages);
  const protectedIds = new Set(originals.flatMap((messages) => [...protectedMessageIds(payload, continuation, messages)]));
  owners.forEach((owner) => {
    owner.messages = [];
  });
  let used = bytesOf(payload) + 1500;
  const sizeOf = (message: unknown) => bytesOf(message) + 1;
  originals.forEach((messages) => {
    messages.forEach((message) => {
      if (protectedIds.has(message?.id)) used += sizeOf(message);
    });
  });
  owners.forEach((owner, index) => {
    const messages = originals[index];
    const keep = new Set<number>();
    messages.forEach((message, at) => {
      if (protectedIds.has(message?.id)) keep.add(at);
    });
    const share = index === 0 && owners.length > 1 ? 0.3 : 1;
    const ceiling = used + Math.max(0, (maxBytes - used) * share);
    let spent = used;
    for (let at = messages.length - 1; at >= 0; at--) {
      if (keep.has(at)) continue;
      const size = sizeOf(messages[at]);
      if (spent + size > ceiling) break;
      keep.add(at);
      spent += size;
    }
    used = spent;
    const kept = messages.filter((_message, at) => keep.has(at));
    notes.droppedMessages += messages.length - kept.length;
    notes.droppedMessageBytes += messages.reduce((sum, message, at) => (keep.has(at) ? sum : sum + sizeOf(message)), 0);
    owner.messages = kept;
  });
}

export function boundWakePayloadJson(json: string | null, maxBytes: number = wakeEnvMaxBytes()): string | null {
  if (typeof json !== "string" || bytesOf(json) <= maxBytes) return json;
  let payload: Json;
  try {
    payload = JSON.parse(json);
  } catch {
    return json;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return json;

  const notes: Notes = {
    truncatedForEnv: true,
    originalBytes: bytesOf(json),
    maxBytes,
    droppedMessages: 0,
    droppedMessageBytes: 0,
    clipped: [],
    note: "This copy is bounded to stay under the Linux limit for one environment string. The run prompt and the issue thread hold the full text.",
  };
  const clipped = (name: string) => {
    if (!notes.clipped.includes(name)) notes.clipped.push(name);
  };
  payload.envTruncation = notes;
  payload.fallbackFetchNeeded = true;
  const fits = () => bytesOf(payload) <= maxBytes;
  const continuation: Json | null =
    payload.executionContinuation && typeof payload.executionContinuation === "object" ? payload.executionContinuation : null;

  // 1. Oldest task history goes first.
  if (continuation) trimMessages(payload, continuation, maxBytes, notes);
  if (fits()) return JSON.stringify(payload);

  // 2. Clip long texts.
  const protectedIds = continuation
    ? protectedMessageIds(payload, continuation, Array.isArray(continuation.messages) ? continuation.messages : [])
    : new Set<string>();
  if (continuation) {
    for (const owner of [continuation, continuation.resumeDelta]) {
      if (!owner || !Array.isArray(owner.messages)) continue;
      for (const message of owner.messages as Json[]) {
        if (!message || typeof message !== "object") continue;
        const limit = protectedIds.has(message.id) ? 12000 : 4000;
        if (typeof message.body === "string" && message.body.length > limit) {
          message.body = clip(message.body, limit);
          clipped("message bodies");
        }
      }
    }
    if (typeof continuation.objective === "string" && continuation.objective.length > 12000) {
      continuation.objective = clip(continuation.objective, 12000);
      clipped("objective");
    }
    if (typeof continuation.completedWork === "string" && continuation.completedWork.length > 4000) {
      continuation.completedWork = clip(continuation.completedWork, 4000);
      clipped("completedWork");
    }
    for (const list of [continuation.completedActions, continuation.interactionOutcomes]) {
      if (!Array.isArray(list)) continue;
      for (const entry of list as Json[]) {
        if (entry && typeof entry === "object" && bytesOf(entry.result) > 1200) {
          entry.result = clipResult(entry.result, 1200);
          clipped("results");
        }
      }
    }
  }
  if (
    payload.issue &&
    typeof payload.issue === "object" &&
    typeof payload.issue.description === "string" &&
    payload.issue.description.length > 6000
  ) {
    payload.issue.description = clip(payload.issue.description, 6000);
    payload.issue.descriptionTruncated = true;
    clipped("issue description");
  }
  if (Array.isArray(payload.comments)) {
    for (const comment of payload.comments as Json[]) {
      if (comment && typeof comment.body === "string" && comment.body.length > 3000) {
        comment.body = clip(comment.body, 3000);
        comment.bodyTruncated = true;
        clipped("comment bodies");
      }
    }
  }
  if (fits()) return JSON.stringify(payload);

  // 3. Fewer evidence entries, and only the messages the current request points at.
  if (continuation) {
    for (const key of ["completedActions", "interactionOutcomes", "recoveryOutcomes"]) {
      if (Array.isArray(continuation[key]) && continuation[key].length > 8) {
        continuation[key] = newest(continuation[key], 8);
        clipped(key);
      }
    }
    const keepOnly = (owner: Json | undefined) => {
      if (!owner || !Array.isArray(owner.messages)) return;
      const kept = (owner.messages as Json[]).filter((message) => protectedIds.has(message?.id));
      notes.droppedMessages += owner.messages.length - kept.length;
      owner.messages = kept;
      for (const message of kept) {
        if (typeof message.body === "string" && message.body.length > 6000) message.body = clip(message.body, 6000);
      }
    };
    keepOnly(continuation);
    keepOnly(continuation.resumeDelta);
  }
  if (fits()) return JSON.stringify(payload);

  // 4. The continuation keeps its identity and objective only.
  if (continuation) {
    payload.executionContinuation = {
      version: 1,
      companyId: continuation.companyId,
      issueId: continuation.issueId,
      trigger: continuation.trigger,
      originCommentIds: newest(continuation.originCommentIds, 50),
      objective: clip(continuation.objective, 4000),
      messages: [],
      unresolvedInteractionIds: newest(continuation.unresolvedInteractionIds, 20),
      coverage: {
        kind: "truncated_for_env",
        throughCommentId: continuation.coverage?.throughCommentId ?? null,
        summaryThroughCommentId: null,
      },
    };
    clipped("whole continuation");
  }
  if (fits()) return JSON.stringify(payload);

  // 5. Last resort: identity of the task only. The prompt and the issue hold everything else.
  const issue: Json = payload.issue && typeof payload.issue === "object" ? payload.issue : {};
  return JSON.stringify({
    reason: payload.reason ?? null,
    issue: {
      id: issue.id ?? null,
      identifier: issue.identifier ?? null,
      title: clip(issue.title ?? null, 300),
      status: issue.status ?? null,
      workMode: issue.workMode ?? null,
      priority: issue.priority ?? null,
      description: clip(issue.description ?? null, 2000),
      descriptionTruncated: true,
    },
    checkedOutByHarness: payload.checkedOutByHarness === true,
    latestCommentId: payload.latestCommentId ?? null,
    commentIds: newest(payload.commentIds, 50) ?? [],
    truncated: true,
    fallbackFetchNeeded: true,
    envTruncation: { ...notes, clipped: [...notes.clipped, "everything but the task identity"] },
  });
}
