export type DriveEntityType = "project" | "crm_company";

export interface RegistryFolder {
  id: string;
  entity_type: string;
  entity_id: string;
  path: string;
  created_by_run?: string;
  folder_id: string;
  folder_url: string;
}

export interface EnsureBody {
  entity_type: DriveEntityType;
  entity_id: string;
  name: string;
  parent_entity_id?: string;
  created_by_run?: string;
}

export interface EnsureResult {
  folder: RegistryFolder;
  created: boolean;
  tree: Array<{ path: string; folderId: string; created: boolean }>;
}

export class BrokerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly folderId?: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = "BrokerError";
  }
}

export interface Broker {
  resolve(type: DriveEntityType, id: string): Promise<RegistryFolder | null>;
  ensure(body: EnsureBody): Promise<EnsureResult>;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

export function createBroker(fetchFn: FetchLike, cfg: { baseUrl: string; token: string }): Broker {
  const baseUrl = cfg.baseUrl.replace(/\/$/, "");

  async function resolve(type: DriveEntityType, id: string): Promise<RegistryFolder | null> {
    const url = `${baseUrl}/api/v1/workspace-folders/registry/resolve?${new URLSearchParams([["entity_type", type], ["entity_id", id]])}`;
    try {
      const res = await fetchFn(url, { method: "GET", headers: { Authorization: `Bearer ${cfg.token}` } });
      if (res.status === 404) return null;
      if (!res.ok) throw parseError(res.status, await res.text());
      const body = JSON.parse(await res.text()) as { data?: { folder: RegistryFolder }; folder?: RegistryFolder };
      const folder = body.data?.folder || body.folder;
      return folder || null;
    } catch (err) {
      if (err instanceof BrokerError) throw err;
      throw new BrokerError(`Network error during resolve: ${err instanceof Error ? err.message : String(err)}`, 500, true);
    }
  }

  async function ensure(body: EnsureBody): Promise<EnsureResult> {
    const url = `${baseUrl}/api/v1/workspace-folders/registry/ensure`;
    const postBody = { ...body };
    if (!body.created_by_run) delete postBody.created_by_run;
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
        body: JSON.stringify(postBody),
      });
      if (!res.ok) throw parseError(res.status, await res.text());
      const responseBody = JSON.parse(await res.text()) as { data?: EnsureResult; folder?: RegistryFolder; created?: boolean; tree?: Array<{ path: string; folderId: string; created: boolean }> };
      const result = responseBody.data || (responseBody as EnsureResult);
      return { folder: result.folder as RegistryFolder, created: result.created === true, tree: result.tree || [] };
    } catch (err) {
      if (err instanceof BrokerError) throw err;
      throw new BrokerError(`Network error during ensure: ${err instanceof Error ? err.message : String(err)}`, 500, true);
    }
  }

  return { resolve, ensure };
}

function parseError(status: number, text: string): BrokerError {
  let msg = "Unknown error";
  try {
    const body = JSON.parse(text) as { error?: string };
    if (body.error) msg = body.error;
  } catch {
    msg = text.slice(0, 200);
  }

  const folderId = text.match(/\(folderId:\s*([^)]+)\)/)?.[1];
  const path = text.match(/\(path:\s*([^)]+)\)/)?.[1];

  switch (status) {
    case 400:
      return new BrokerError(`Invalid request: ${msg}`, status, false);
    case 401:
    case 403:
      return new BrokerError(`Broker rejected the credential`, status, false);
    case 409:
      return new BrokerError(`Folder conflict: ${msg}`, status, false);
    case 503:
      return new BrokerError(`Broker not configured (Shared Drive)`, status, false);
    case 502:
      return new BrokerError(`Broker gateway error: ${msg}`, status, true, folderId, path);
    default:
      return new BrokerError(`Broker error: ${msg}`, status, true);
  }
}
