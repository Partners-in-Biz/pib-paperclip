import type { WebBroker } from "./broker.js";

export const GOOGLE_CUSTOMER_PRESET = "758-529-6111";
export const GOOGLE_LOGIN_CUSTOMER_PRESET = "281-429-3621";

export function normalizeGoogleAdsId(id: string): string {
  return id.replace(/\D/g, "");
}

export interface WebAdConnection {
  id: string;
  provider: "google" | "meta" | string;
  status?: string;
  connected?: boolean;
  customerId?: string | null;
  loginCustomerId?: string | null;
}

type ConnectionsPayload = { connections?: WebAdConnection[]; data?: { connections?: WebAdConnection[] } };

function connectionsOf(body: ConnectionsPayload): WebAdConnection[] {
  return body.data?.connections ?? body.connections ?? [];
}

export async function listConnections(broker: WebBroker): Promise<WebAdConnection[]> {
  const body = await broker.get<ConnectionsPayload>("/api/v1/ads/connections");
  return connectionsOf(body);
}

export async function startGoogleAuthorize(broker: WebBroker, input: { returnPath: string }): Promise<{ authorizeUrl: string }> {
  const body = await broker.post<{ authorizeUrl?: string; data?: { authorizeUrl?: string } }>("/api/v1/ads/google/oauth/authorize", {
    returnPath: input.returnPath,
  });
  const authorizeUrl = body.data?.authorizeUrl ?? body.authorizeUrl;
  if (!authorizeUrl) throw new Error("The broker did not return an authorize address.");
  return { authorizeUrl };
}

export async function startMetaAuthorize(broker: WebBroker, input: { returnPath: string }): Promise<{ authorizeUrl: string }> {
  const body = await broker.post<{ authorizeUrl?: string; data?: { authorizeUrl?: string } }>("/api/v1/ads/connections/meta/authorize", {
    returnPath: input.returnPath,
  });
  const authorizeUrl = body.data?.authorizeUrl ?? body.authorizeUrl;
  if (!authorizeUrl) throw new Error("The broker did not return an authorize address.");
  return { authorizeUrl };
}

export interface GoogleCustomerRow {
  customerId: string;
  descriptiveName?: string;
  manager?: boolean;
}

export async function listGoogleCustomers(broker: WebBroker, connectionId: string): Promise<GoogleCustomerRow[]> {
  const body = await broker.get<{ customers?: GoogleCustomerRow[]; data?: { customers?: GoogleCustomerRow[] } }>(
    "/api/v1/ads/google/customers",
    { connectionId },
  );
  return body.data?.customers ?? body.customers ?? [];
}

export async function setGoogleCustomer(
  broker: WebBroker,
  connectionId: string,
  input: { customerId: string; loginCustomerId?: string },
): Promise<void> {
  await broker.patch(`/api/v1/ads/google/connections/${encodeURIComponent(connectionId)}/customer`, {
    customerId: normalizeGoogleAdsId(input.customerId),
    ...(input.loginCustomerId ? { loginCustomerId: normalizeGoogleAdsId(input.loginCustomerId) } : {}),
  });
}

export function webConnectionStatus(connections: WebAdConnection[]): { google: boolean; meta: boolean; googleConnectionId: string | null } {
  const google = connections.find((c) => c.provider === "google" && (c.connected === true || c.status === "connected"));
  const meta = connections.find((c) => c.provider === "meta" && (c.connected === true || c.status === "connected"));
  return {
    google: Boolean(google),
    meta: Boolean(meta),
    googleConnectionId: google?.id ?? null,
  };
}
