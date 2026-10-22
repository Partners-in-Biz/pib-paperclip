export class BrokerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly code?: string,
  ) {
    super(message);
    this.name = "BrokerError";
  }
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

export interface WebBrokerClientConfig {
  baseUrl: string;
  token: string;
  orgId: string;
  orgSlug: string;
}

export interface WebBroker {
  get<T>(path: string, query?: Record<string, string>): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
}

export function createWebBroker(fetchFn: FetchLike, cfg: WebBrokerClientConfig): WebBroker {
  const baseUrl = cfg.baseUrl.replace(/\/$/, "");
  const headers = (): Record<string, string> => ({
    Authorization: `Bearer ${cfg.token}`,
    "X-Org-Id": cfg.orgId,
    "X-Org-Slug": cfg.orgSlug,
    Accept: "application/json",
    "Content-Type": "application/json",
  });

  async function request<T>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
    const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
    const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}${qs}`;
    try {
      const res = await fetchFn(url, {
        method,
        headers: headers(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      if (!res.ok) throw parseError(res.status, text);
      if (!text.trim()) return {} as T;
      return JSON.parse(text) as T;
    } catch (err) {
      if (err instanceof BrokerError) throw err;
      throw new BrokerError(`Network error: ${err instanceof Error ? err.message : String(err)}`, 500, true);
    }
  }

  return {
    get: (path, query) => request("GET", path, undefined, query),
    post: (path, body) => request("POST", path, body),
    patch: (path, body) => request("PATCH", path, body),
  };
}

function parseError(status: number, text: string): BrokerError {
  let msg = "Unknown error";
  let code: string | undefined;
  try {
    const body = JSON.parse(text) as { error?: string; code?: string; message?: string };
    if (body.error) msg = body.error;
    if (body.code) code = body.code;
    if (body.message) msg = body.message;
  } catch {
    msg = text.slice(0, 200);
  }
  if (status === 401 || status === 403) return new BrokerError("The web broker rejected the credential.", status, false, code);
  if (status === 400) return new BrokerError(`Invalid request: ${msg}`, status, false, code);
  return new BrokerError(`Broker error: ${msg}`, status, status >= 500, code);
}
