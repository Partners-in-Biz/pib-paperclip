/**
 * A small Gmail + Google OAuth + Jev + file server stand-in, driven through an
 * injected fetch. It keeps messages, history records, labels and sends.
 */
import type { FetchLike } from "../../src/gmail/api.js";

export interface FakePart {
  mimeType: string;
  filename?: string;
  attachmentId?: string;
  size?: number;
  data?: string;
  headers?: Record<string, string>;
  parts?: FakePart[];
}

export interface FakeMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  headers: Record<string, string>;
  snippet: string;
  internalDate: number;
  payload?: FakePart;
}

export interface Call {
  method: string;
  url: URL;
  body: string | null;
  headers: Headers;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function b64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class FakeGmail {
  email = "peet@partnersinbiz.online";
  historyId = 1000;
  /** Oldest cursor history.list still accepts. */
  minHistoryId = 0;
  messages = new Map<string, FakeMessage>();
  history: Array<{ id: number; added?: string[]; labels?: Array<{ id: string; labelIds: string[] }> }> = [];
  labels: Array<{ id: string; name: string }> = [
    { id: "INBOX", name: "INBOX" },
    { id: "SENT", name: "SENT" },
    { id: "UNREAD", name: "UNREAD" },
  ];
  sent: Array<{ raw: string; mime: string; threadId: string | null; id: string }> = [];
  calls: Call[] = [];
  /** Override responses: return a Response to short-circuit. */
  intercept: ((call: Call) => Response | null | Promise<Response | null>) | null = null;
  tokenResponse: () => Response = () => json({ access_token: "fresh-token", expires_in: 3600, scope: "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send" });
  jevResponse: ((body: Record<string, unknown>) => Response) | null = null;
  files = new Map<string, { status: number; body: Uint8Array; type: string }>();
  private seq = 0;
  private labelSeq = 0;

  addMessage(message: Partial<FakeMessage> & { id: string; headers: Record<string, string> }, options: { history?: boolean } = {}): FakeMessage {
    const full: FakeMessage = {
      threadId: message.threadId ?? `t-${message.id}`,
      labelIds: message.labelIds ?? ["INBOX", "UNREAD"],
      snippet: message.snippet ?? "",
      internalDate: message.internalDate ?? Date.now(),
      ...message,
    };
    this.messages.set(full.id, full);
    if (options.history !== false) {
      this.historyId += 1;
      this.history.push({ id: this.historyId, added: [full.id] });
    }
    return full;
  }

  changeLabels(id: string, labelIds: string[]): void {
    const message = this.messages.get(id);
    if (message) message.labelIds = labelIds;
    this.historyId += 1;
    this.history.push({ id: this.historyId, labels: [{ id, labelIds }] });
  }

  count(method: string, path: string | RegExp): number {
    return this.calls.filter((c) => c.method === method && (typeof path === "string" ? c.url.pathname.endsWith(path) : path.test(c.url.pathname + c.url.search))).length;
  }

  private metadata(message: FakeMessage, headers: string[]) {
    const wanted = new Set(headers.map((h) => h.toLowerCase()));
    const contentType = message.headers["Content-Type"] ?? message.payload?.mimeType ?? "text/plain";
    const all = { ...message.headers, "Content-Type": contentType };
    return {
      id: message.id,
      threadId: message.threadId,
      labelIds: message.labelIds,
      snippet: message.snippet,
      internalDate: String(message.internalDate),
      historyId: String(this.historyId),
      payload: {
        mimeType: contentType.split(";")[0],
        headers: Object.entries(all)
          .filter(([name]) => wanted.size === 0 || wanted.has(name.toLowerCase()))
          .map(([name, value]) => ({ name, value })),
      },
    };
  }

  private partTree(part: FakePart | undefined, withData: boolean): Record<string, unknown> | undefined {
    if (!part) return undefined;
    return {
      mimeType: part.mimeType,
      filename: part.filename ?? "",
      body: { size: part.size ?? 0, ...(part.attachmentId ? { attachmentId: part.attachmentId } : {}), ...(withData && part.data ? { data: b64url(part.data) } : {}) },
      ...(part.headers ? { headers: Object.entries(part.headers).map(([name, value]) => ({ name, value })) } : {}),
      ...(part.parts ? { parts: part.parts.map((p) => this.partTree(p, withData)) } : {}),
    };
  }

  fetch: FetchLike = async (input, init = {}) => {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? init.body : null;
    const call: Call = { method, url, body, headers: new Headers(init.headers as HeadersInit | undefined) };
    this.calls.push(call);
    if (this.intercept) {
      const res = await this.intercept(call);
      if (res) return res;
    }
    if (url.host === "oauth2.googleapis.com") return this.tokenResponse();
    if (url.host === "api.typesafe.ai") {
      if (!this.jevResponse) return json({ error: "no jev" }, 500);
      return this.jevResponse(JSON.parse(body ?? "{}") as Record<string, unknown>);
    }
    if (url.host === "files.example.com") {
      const file = this.files.get(url.pathname);
      if (!file) return new Response("missing", { status: 404 });
      return new Response(file.body as unknown as BodyInit, { status: file.status, headers: { "content-type": file.type } });
    }
    if (url.host !== "gmail.googleapis.com") return new Response("unknown host", { status: 599 });
    const path = url.pathname.replace(/^\/(upload\/)?gmail\/v1\/users\/me/, "");
    if (method === "GET" && path === "/profile") return json({ emailAddress: this.email, historyId: String(this.historyId) });
    if (method === "GET" && path === "/history") {
      const start = Number(url.searchParams.get("startHistoryId"));
      if (start < this.minHistoryId) return json({ error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } }, 404);
      const max = Number(url.searchParams.get("maxResults") ?? 100);
      const offset = Number(url.searchParams.get("pageToken") ?? 0);
      const records = this.history.filter((r) => r.id > start);
      const page = records.slice(offset, offset + max);
      return json({
        history: page.map((r) => ({
          id: String(r.id),
          ...(r.added ? { messagesAdded: r.added.map((id) => ({ message: { id, threadId: this.messages.get(id)?.threadId ?? id, labelIds: this.messages.get(id)?.labelIds ?? [] } })) } : {}),
          ...(r.labels ? { labelsAdded: r.labels.map((l) => ({ message: { id: l.id, threadId: this.messages.get(l.id)?.threadId ?? l.id, labelIds: l.labelIds }, labelIds: l.labelIds })) } : {}),
        })),
        historyId: String(this.historyId),
        ...(offset + max < records.length ? { nextPageToken: String(offset + max) } : {}),
      });
    }
    if (method === "GET" && path === "/messages") {
      const q = url.searchParams.get("q") ?? "";
      let list = [...this.messages.values()];
      const rfc = /rfc822msgid:(\S+)/.exec(q)?.[1];
      if (rfc) list = list.filter((m) => m.headers["Message-ID"] === rfc);
      return json({ messages: list.map((m) => ({ id: m.id, threadId: m.threadId })), resultSizeEstimate: list.length });
    }
    const one = /^\/messages\/([^/]+)$/.exec(path);
    if (method === "GET" && one) {
      const message = this.messages.get(decodeURIComponent(one[1]!));
      if (!message) return json({ error: { code: 404, message: "Not Found" } }, 404);
      const format = url.searchParams.get("format");
      if (format === "metadata") return json(this.metadata(message, url.searchParams.getAll("metadataHeaders")));
      if (format === "full" && url.searchParams.get("fields")) return json({ id: message.id, payload: this.partTree(message.payload, false) });
      const meta = this.metadata(message, []);
      return json({ ...meta, payload: { ...(this.partTree(message.payload, true) ?? {}), headers: meta.payload.headers } });
    }
    const thread = /^\/threads\/([^/]+)$/.exec(path);
    if (method === "GET" && thread) {
      const list = [...this.messages.values()].filter((m) => m.threadId === decodeURIComponent(thread[1]!)).sort((a, b) => a.internalDate - b.internalDate);
      if (list.length === 0) return json({ error: { code: 404, message: "Not Found" } }, 404);
      return json({ id: thread[1], messages: list.map((m) => this.metadata(m, url.searchParams.getAll("metadataHeaders"))) });
    }
    if (method === "GET" && path === "/labels") return json({ labels: this.labels });
    if (method === "POST" && path === "/labels") {
      const name = String((JSON.parse(body ?? "{}") as { name?: string }).name);
      if (this.labels.some((l) => l.name.toLowerCase() === name.toLowerCase())) return json({ error: { code: 409, message: "Label name exists or conflicts" } }, 409);
      this.labelSeq += 1;
      const label = { id: `Label_${this.labelSeq}`, name };
      this.labels.push(label);
      return json(label);
    }
    if (method === "POST" && path === "/messages/batchModify") {
      const req = JSON.parse(body ?? "{}") as { ids: string[]; addLabelIds: string[]; removeLabelIds: string[] };
      for (const id of req.ids) {
        const m = this.messages.get(id);
        if (m) m.labelIds = [...new Set([...m.labelIds.filter((l) => !req.removeLabelIds?.includes(l)), ...req.addLabelIds])];
      }
      return new Response("", { status: 204 });
    }
    const modify = /^\/messages\/([^/]+)\/modify$/.exec(path);
    if (method === "POST" && modify) {
      const m = this.messages.get(modify[1]!);
      const req = JSON.parse(body ?? "{}") as { addLabelIds: string[]; removeLabelIds: string[] };
      if (!m) return json({ error: { code: 404, message: "Not Found" } }, 404);
      m.labelIds = [...new Set([...m.labelIds.filter((l) => !req.removeLabelIds?.includes(l)), ...(req.addLabelIds ?? [])])];
      return json({ id: m.id, threadId: m.threadId, labelIds: m.labelIds });
    }
    if (method === "POST" && path === "/messages/send") {
      let raw = "";
      let threadId: string | null = null;
      if (url.pathname.startsWith("/upload/")) {
        const parts = (body ?? "").split(/--pib_upload_[a-z0-9]+/);
        const meta = JSON.parse(parts[1]!.split("\r\n\r\n")[1]!.trim()) as { threadId?: string };
        threadId = meta.threadId ?? null;
        raw = b64url(parts[2]!.split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n$/, ""));
      } else {
        const req = JSON.parse(body ?? "{}") as { raw: string; threadId?: string };
        raw = req.raw;
        threadId = req.threadId ?? null;
      }
      const mime = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      this.seq += 1;
      const id = `sent-${this.seq}`;
      const messageId = /^Message-ID: (.+)$/m.exec(mime)?.[1]?.trim() ?? `<${id}@mail.gmail.com>`;
      const subject = /^Subject: (.+)$/m.exec(mime)?.[1]?.trim() ?? "";
      const thread = threadId ?? `t-${id}`;
      this.sent.push({ raw, mime, threadId, id });
      this.addMessage({ id, threadId: thread, labelIds: ["SENT"], headers: { "Message-ID": messageId, Subject: subject, From: this.email } });
      return json({ id, threadId: thread, labelIds: ["SENT"] });
    }
    return json({ error: { code: 400, message: `Unhandled ${method} ${path}` } }, 400);
  };
}

/** A Jev response builder for the triage questions. */
export function jevAnswers(answers: Record<string, unknown>) {
  return () => new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 42 } }), { status: 200, headers: { "content-type": "application/json" } });
}
