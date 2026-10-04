/**
 * Connection tokens: sealed at rest, opened only here, refreshed before they lapse. A connection is either a sign-in (`oauth`, the sealed
 * bundle lives in the row) or a saved system-user token (`token`, read from the plugin settings each time; nothing sealed).
 *
 * A token the platform rejects turns the connection to `needs_reconnect` and opens one issue for a person (signing in again is a grant).
 */
import { openJson, sealJson, sealedVersion } from "@partnersinbiz/pib-plugin-kit";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { audit, getConnection, listConnections, updateConnection, type ConnectionRow } from "./db.js";
import { AdsError, errorMessage } from "./domain.js";
import { ownerAssignee, closeIssue, openIssueOnce } from "./issues.js";
import { ADS_ORIGINS, platformLabel } from "./platforms.js";
import { ProviderError } from "./providers/http.js";
import type { TokenBundle } from "./providers/types.js";
import { providerEnv, type AdsRuntime } from "./runtime.js";

const MINUTE = 60_000;
const DAY = 86_400_000;
/** Meta's long-lived tokens are re-exchanged when this close to the end (they last about 60 days). */
export const META_REFRESH_WITHIN_MS = 10 * DAY;
/** Google access tokens last an hour: refreshed when this close to the end. */
export const GOOGLE_REFRESH_WITHIN_MS = 5 * MINUTE;

function expiresSoon(conn: ConnectionRow, withinMs: number, now: Date): boolean {
  if (!conn.token_expires_at) return false;
  return Date.parse(conn.token_expires_at) - now.getTime() <= withinMs;
}

/** The connection's token, refreshed first when it is about to lapse. Throws `ProviderError` (token invalid) or `AdsError`. */
export async function tokenFor(rt: AdsRuntime, conn: ConnectionRow): Promise<TokenBundle> {
  if (conn.status === "disabled") throw new AdsError("This connection was removed. Connect again.");
  if (conn.status === "needs_reconnect") throw new AdsError(`${platformLabel(conn.platform)} needs to be signed in again before anything can be read.`, "needs_reconnect");
  if (conn.mode === "token") {
    const saved = conn.platform === "mock" ? "mock" : await rt.config.systemToken(conn.platform);
    if (!saved) throw new AdsError("The system-user token is no longer saved in the plugin settings.", "needs_reconnect");
    return { accessToken: saved, scopes: conn.scopes };
  }
  if (conn.platform === "mock") return { accessToken: "mock-access", scopes: ["mock"] };
  if (!conn.token_enc) throw new AdsError("This connection has no stored sign-in. Connect again.", "needs_reconnect");
  const keyring = await rt.config.keyring();
  let bundle = openJson<TokenBundle>(conn.token_enc, keyring);
  const withinMs = conn.platform === "google" ? GOOGLE_REFRESH_WITHIN_MS : META_REFRESH_WITHIN_MS;
  const stale = sealedVersion(conn.token_enc) !== keyring.currentVersion;
  if (expiresSoon({ ...conn, token_expires_at: bundle.expiresAt ?? conn.token_expires_at }, withinMs, rt.now())) {
    // Google's access token expires every hour; Meta's long-lived one is exchanged again. Either failing as invalid means signing in again.
    bundle = await rt.provider(conn.platform).refresh(await providerEnv(rt, conn.platform), bundle);
    await updateConnection(rt.ctx, rt.companyId, conn.id, { tokenEnc: sealJson(bundle, keyring), keyVersion: keyring.currentVersion, expiresAt: bundle.expiresAt ?? null, lastOk: true });
  } else if (stale) {
    // A rotated encryption key: re-seal with the current one now that the old one opened it.
    await updateConnection(rt.ctx, rt.companyId, conn.id, { tokenEnc: sealJson(bundle, keyring), keyVersion: keyring.currentVersion });
  }
  return bundle;
}

/** Records that the platform rejected the token and asks a person to sign in again, once. */
export async function markNeedsReconnect(rt: AdsRuntime, conn: ConnectionRow, reason: string): Promise<void> {
  if (conn.status === "needs_reconnect" && conn.reconnect_issue_id) return;
  await updateConnection(rt.ctx, rt.companyId, conn.id, { status: "needs_reconnect", statusDetail: reason.slice(0, 400) });
  await audit(rt.ctx, rt.companyId, { actor: "system", action: "connection.needs_reconnect", subject: conn.id, detail: { platform: conn.platform, reason: reason.slice(0, 200) } });
  try {
    const opened = await openIssueOnce(rt.ctx, {
      companyId: rt.companyId,
      originId: `${ADS_ORIGINS.reconnect}${conn.id}`,
      title: `Sign in again: ${conn.label}`,
      description: [
        `${platformLabel(conn.platform)} stopped accepting the sign-in "${conn.label}": ${reason.slice(0, 300)}`,
        "",
        "Until it is signed in again, numbers for its ad accounts stop updating and no alert can fire for them.",
        "",
        "1. Open Ads -> Accounts.",
        `2. Click **Sign in again** on "${conn.label}" and sign in with the account that has the ad accounts.`,
        "",
        "Signing in is a one-time grant only a person can give. The issue closes by itself when the connection works again.",
      ].join("\n"),
      assignee: await ownerAssignee(rt.ctx, rt.companyId),
      wakeReason: "An ad platform connection needs signing in again",
      priority: "high",
    });
    await updateConnection(rt.ctx, rt.companyId, conn.id, { reconnectIssueId: opened.id });
  } catch (error) {
    rt.ctx.logger.info("Ads reconnect issue could not be opened", { connectionId: conn.id, error: errorMessage(error) });
  }
}

/** The connection works again: clear the flag and close the issue that asked for a sign-in. */
export async function markConnected(rt: AdsRuntime, conn: ConnectionRow): Promise<void> {
  await updateConnection(rt.ctx, rt.companyId, conn.id, { status: "connected", statusDetail: null, reconnectIssueId: null, lastOk: true });
  await closeIssue(rt.ctx, rt.companyId, conn.reconnect_issue_id, "done", "The connection works again.");
}

export interface RefreshOutcome {
  connectionId: string;
  result: "fresh" | "refreshed" | "needs_reconnect" | "failed" | "skipped";
  error?: string;
}

/** Hourly: keep every token alive. A token that cannot be renewed is flagged before it lapses, not after a sync fails. */
export async function refreshConnection(rt: AdsRuntime, conn: ConnectionRow): Promise<RefreshOutcome> {
  if (conn.status === "disabled" || conn.status === "needs_reconnect") return { connectionId: conn.id, result: "skipped" };
  if (conn.mode === "token" || conn.platform === "mock") return { connectionId: conn.id, result: "fresh" };
  try {
    const before = conn.token_expires_at;
    const keyring = await rt.config.keyring();
    const bundle = conn.token_enc ? openJson<TokenBundle>(conn.token_enc, keyring) : null;
    const expiry = bundle?.expiresAt ?? before;
    const withinMs = conn.platform === "google" ? GOOGLE_REFRESH_WITHIN_MS : META_REFRESH_WITHIN_MS;
    if (!expiry || Date.parse(expiry) - rt.now().getTime() > withinMs) {
      if (conn.status === "expiring") await updateConnection(rt.ctx, rt.companyId, conn.id, { status: "connected", statusDetail: null });
      return { connectionId: conn.id, result: "fresh" };
    }
    await tokenFor(rt, conn);
    if (conn.status === "expiring") await updateConnection(rt.ctx, rt.companyId, conn.id, { status: "connected", statusDetail: null });
    return { connectionId: conn.id, result: "refreshed" };
  } catch (error) {
    if (error instanceof ProviderError && error.tokenInvalid) {
      await markNeedsReconnect(rt, conn, error.message);
      return { connectionId: conn.id, result: "needs_reconnect", error: error.message };
    }
    // A passing outage must not flag the connection; say so only when the token is close to lapsing.
    const message = errorMessage(error);
    if (conn.token_expires_at && Date.parse(conn.token_expires_at) - rt.now().getTime() < 2 * DAY) {
      await updateConnection(rt.ctx, rt.companyId, conn.id, { status: "expiring", statusDetail: `Could not renew: ${message}`.slice(0, 400) });
    }
    return { connectionId: conn.id, result: "failed", error: message };
  }
}

export async function refreshAllConnections(rt: AdsRuntime): Promise<RefreshOutcome[]> {
  const out: RefreshOutcome[] = [];
  for (const conn of await listConnections(rt.ctx, rt.companyId)) out.push(await refreshConnection(rt, conn));
  return out;
}

/** What the page shows about a connection: never the token. */
export function connectionView(conn: ConnectionRow) {
  return {
    id: conn.id,
    platform: conn.platform,
    label: conn.label,
    mode: conn.mode,
    status: conn.status,
    statusDetail: conn.status_detail,
    canWrite: conn.can_write,
    scopes: conn.scopes,
    expiresAt: conn.token_expires_at,
    lastOkAt: conn.last_ok_at,
  };
}

export async function requireConnection(ctx: PluginContext, companyId: string, id: string): Promise<ConnectionRow> {
  const conn = await getConnection(ctx, companyId, id);
  if (!conn || conn.status === "disabled") throw new AdsError("That connection was not found.");
  return conn;
}

