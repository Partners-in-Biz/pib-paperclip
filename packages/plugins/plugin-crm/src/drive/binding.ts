/**
 * Per-company Shared Drive binding: discover, set, and check status.
 * Storage: plugin state scoped to company (no DB migration needed, src-only release).
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { Viewer } from "../domain.js";
import { CrmError } from "../domain.js";
import { readConfig, SecretResolver, PIB_PLUGINS, pluginEvent } from "@partnersinbiz/pib-plugin-kit";

/** Drive binding event bare name (emitted as this, subscribers use pluginEvent to subscribe) */
const DRIVE_BINDING_EVENT_BARE = "drive.binding";

/** Drive binding event full name for subscribers */
export const DRIVE_BINDING_EVENT = pluginEvent(PIB_PLUGINS.crm, DRIVE_BINDING_EVENT_BARE);

/** Interface for the drive.binding event payload */
export interface DriveBindingEventPayload {
  companyId: string;
  connected: boolean; // bound || stored candidates non-empty
  bound: boolean;
  sharedDriveId?: string;
  serviceAccountEmail?: string;
  serviceAccountIsMember: boolean;
  candidates: Array<{ id: string; name: string }>;
}

// State key structure for company-scoped binding and candidates
const BINDING_STATE_KEY = (companyId: string) => ({
  scopeKind: "company" as const,
  scopeId: companyId,
  namespace: "crm-drive-binding",
  stateKey: "binding",
});

const CANDIDATES_STATE_KEY = (companyId: string) => ({
  scopeKind: "company" as const,
  scopeId: companyId,
  namespace: "crm-drive-binding",
  stateKey: "candidates",
});

interface BindingState {
  sharedDriveId: string;
  name: string;
  setBoundAt: string; // ISO timestamp
}

interface DriveBindingStatusResult {
  bound: boolean;
  sharedDriveId?: string;
  tokenSet?: boolean;
  serviceAccountEmail?: string;
  serviceAccountIsMember: boolean;
  identityError?: string;
}

/** Helper to emit drive.binding event. Failures do not fail the tool. */
async function emitBindingEvent(
  ctx: PluginContext,
  companyId: string,
  payload: DriveBindingEventPayload,
): Promise<void> {
  try {
    await ctx.events.emit(DRIVE_BINDING_EVENT_BARE, companyId, payload as unknown as Record<string, unknown>);
  } catch (error) {
    ctx.logger.info("drive.binding event emit failed (non-fatal)", {
      companyId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Helper to publish status event with stored candidates. Reads candidates from state and sets connected appropriately. */
async function publishStatusEvent(
  ctx: PluginContext,
  companyId: string,
  data: {
    bound: boolean;
    sharedDriveId?: string;
    serviceAccountEmail?: string;
    serviceAccountIsMember: boolean;
  },
): Promise<void> {
  // Read stored candidates from state
  const candidatesData = await ctx.state.get(CANDIDATES_STATE_KEY(companyId));
  const candidates = (Array.isArray(candidatesData) ? candidatesData : []).filter(
    (c: unknown) => c && typeof c === "object" && typeof (c as Record<string, unknown>).id === "string" && typeof (c as Record<string, unknown>).name === "string"
  ) as Array<{ id: string; name: string }>;

  const payload: DriveBindingEventPayload = {
    companyId,
    connected: data.bound || candidates.length > 0,
    bound: data.bound,
    sharedDriveId: data.sharedDriveId,
    serviceAccountIsMember: data.serviceAccountIsMember,
    candidates,
  };

  if (data.serviceAccountEmail) {
    payload.serviceAccountEmail = data.serviceAccountEmail;
  }

  await emitBindingEvent(ctx, companyId, payload);
}

/** Extract config-pinned sharedDriveId. */
function pinnedDriveId(cfg: Record<string, unknown>): string {
  const driveConfig = (cfg.drive as { sharedDriveId?: string }) || {};
  return (driveConfig.sharedDriveId || "").trim();
}

/** Get effective binding from config or state. */
async function effectiveBinding(
  ctx: PluginContext,
  companyId: string,
  cfg: Record<string, unknown>,
): Promise<BindingState | undefined> {
  const configId = pinnedDriveId(cfg);
  if (configId) {
    // Config-pinned: return a minimal binding state (no name/setBoundAt from config)
    return { sharedDriveId: configId, name: "", setBoundAt: "" };
  }

  const stateBinding = await ctx.state.get(BINDING_STATE_KEY(companyId));
  if (stateBinding && typeof stateBinding === "object") {
    return stateBinding as BindingState;
  }
  return undefined;
}

/** Get the effective sharedDriveId for this company (config or state). Returns empty if unbound. */
export async function effectiveSharedDriveId(
  ctx: PluginContext,
  companyId: string,
  cfg: Record<string, unknown>,
): Promise<string> {
  const binding = await effectiveBinding(ctx, companyId, cfg);
  return binding ? binding.sharedDriveId : "";
}

export async function driveBindingDiscover(
  ctx: PluginContext,
  viewer: Viewer,
  params: Record<string, unknown>,
): Promise<unknown> {
  const drives = params.drives as Array<{ id: string; name: string }>;
  if (!Array.isArray(drives)) throw new CrmError("Missing or invalid drives array");

  // Validate and cap drives array
  if (drives.length > 500) throw new CrmError("Drives list exceeds 500 entries");
  for (const drive of drives) {
    if (typeof drive.id !== "string" || !drive.id.trim()) {
      throw new CrmError("Invalid drive entry: id must be a non-empty string");
    }
    if (typeof drive.name !== "string" || !drive.name.trim()) {
      throw new CrmError("Invalid drive entry: name must be a non-empty string");
    }
  }

  const companyId = viewer.companyId;
  const cfg = await readConfig(ctx, companyId);

  // If config-pinned, report but do not overwrite
  const configSharedDriveId = pinnedDriveId(cfg);
  const isConfigPinned = configSharedDriveId !== "";

  // Get the Paperclip company name
  const paperclipCompany = await ctx.companies.get(companyId);
  const companyName = paperclipCompany?.name || "";

  // Store the candidate list in state
  await ctx.state.set(CANDIDATES_STATE_KEY(companyId), drives);

  // Report existing binding if config-pinned (highest precedence)
  if (isConfigPinned) {
    await emitBindingEvent(ctx, companyId, {
      companyId,
      connected: true,
      bound: true,
      sharedDriveId: configSharedDriveId,
      serviceAccountIsMember: false,
      candidates: drives,
    });
    return {
      bound: true,
      sharedDriveId: configSharedDriveId,
      alreadyBound: true,
      candidates: drives,
    };
  }

  // Report existing state binding
  const existingBinding = await ctx.state.get(BINDING_STATE_KEY(companyId));
  if (existingBinding && typeof existingBinding === "object") {
    const binding = existingBinding as BindingState;
    await emitBindingEvent(ctx, companyId, {
      companyId,
      connected: true,
      bound: true,
      sharedDriveId: binding.sharedDriveId,
      serviceAccountIsMember: false,
      candidates: drives,
    });
    return {
      bound: true,
      sharedDriveId: binding.sharedDriveId,
      name: binding.name,
      alreadyBound: true,
      candidates: drives,
    };
  }

  // No existing binding; attempt auto-bind if exactly one match
  const targetName = companyName.trim().toLowerCase();
  const exactMatches = drives.filter((d) => d.name.trim().toLowerCase() === targetName);

  if (exactMatches.length === 1) {
    const match = exactMatches[0];
    const newBinding: BindingState = {
      sharedDriveId: match.id,
      name: match.name,
      setBoundAt: new Date().toISOString(),
    };
    await ctx.state.set(BINDING_STATE_KEY(companyId), newBinding);
    await emitBindingEvent(ctx, companyId, {
      companyId,
      connected: true,
      bound: true,
      sharedDriveId: match.id,
      serviceAccountIsMember: false,
      candidates: drives,
    });
    return {
      bound: true,
      sharedDriveId: match.id,
      name: match.name,
      autoPicked: true,
    };
  }

  // Multiple or no matches: don't set, just return candidates
  await emitBindingEvent(ctx, companyId, {
    companyId,
    connected: drives.length > 0,
    bound: false,
    serviceAccountIsMember: false,
    candidates: drives,
  });
  return {
    bound: false,
    candidates: drives,
    reason: exactMatches.length === 0 ? "none" : "several",
  };
}

export async function driveBindingSet(
  ctx: PluginContext,
  viewer: Viewer,
  params: Record<string, unknown>,
): Promise<unknown> {
  const sharedDriveId = params.sharedDriveId as string;
  if (!sharedDriveId) throw new CrmError("Missing sharedDriveId");

  const companyId = viewer.companyId;
  const cfg = await readConfig(ctx, companyId);

  // Check if config-pinned
  const configSharedDriveId = pinnedDriveId(cfg);
  if (configSharedDriveId !== "") {
    throw new CrmError("This company's Shared Drive is pinned in settings (drive.sharedDriveId). Only an operator can change it.");
  }

  // Get the candidates from state
  const candidatesData = await ctx.state.get(CANDIDATES_STATE_KEY(companyId));
  const candidates = (Array.isArray(candidatesData) ? candidatesData : []) as Array<{ id: string; name: string }>;

  // Verify sharedDriveId is in the candidate list
  const found = candidates.find((c) => c.id === sharedDriveId);
  if (!found) {
    throw new CrmError(`Shared Drive ID not in discovered list. Run drive_binding_discover first or check the ID against the discovered list.`);
  }

  // Store the binding
  const newBinding: BindingState = {
    sharedDriveId,
    name: found.name,
    setBoundAt: new Date().toISOString(),
  };
  await ctx.state.set(BINDING_STATE_KEY(companyId), newBinding);

  // Emit binding event
  await emitBindingEvent(ctx, companyId, {
    companyId,
    connected: true,
    bound: true,
    sharedDriveId,
    serviceAccountIsMember: false,
    candidates,
  });

  return {
    bound: true,
    sharedDriveId,
    name: found.name,
  };
}

export async function driveBindingStatus(
  ctx: PluginContext,
  viewer: Viewer,
): Promise<DriveBindingStatusResult> {
  const companyId = viewer.companyId;
  const cfg = await readConfig(ctx, companyId);

  // Get effective binding (config-pinned or state)
  const binding = await effectiveBinding(ctx, companyId, cfg);
  const bound = !!binding;
  const sharedDriveId = binding?.sharedDriveId;

  // Check if driveBrokerToken is set
  const tokenSet = !!cfg.driveBrokerToken;

  // Always return basic status; only fetch identity if token is set
  if (!tokenSet) {
    await publishStatusEvent(ctx, companyId, {
      bound,
      sharedDriveId,
      serviceAccountIsMember: false,
    });
    return {
      bound,
      sharedDriveId,
      tokenSet,
      serviceAccountIsMember: false,
    };
  }

  // Token is set: try to get identity from the broker
  let serviceAccountEmail: string | undefined;
  let serviceAccountIsMember = false;
  let identityError: string | undefined;

  try {
    const resolver = new SecretResolver(ctx, companyId, cfg);
    const token = await resolver.get("driveBrokerToken");
    if (!token) {
      // No token available; return status without identity info
      await publishStatusEvent(ctx, companyId, {
        bound,
        sharedDriveId,
        serviceAccountIsMember: false,
      });
      return {
        bound,
        sharedDriveId,
        tokenSet: false,
        serviceAccountIsMember: false,
      };
    }

    const baseUrl = (cfg.driveBrokerUrl as string) || "https://partnersinbiz.online";
    // Only append shared_drive_id param when bound
    const url = bound && sharedDriveId
      ? `${baseUrl}/api/v1/workspace-broker/identity?shared_drive_id=${encodeURIComponent(sharedDriveId)}`
      : `${baseUrl}/api/v1/workspace-broker/identity`;

    const res = await ctx.http.fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.ok) {
      const body = JSON.parse(await res.text()) as { serviceAccountEmail?: string; isMember?: boolean };
      serviceAccountEmail = body.serviceAccountEmail;
      serviceAccountIsMember = body.isMember === true;
    } else {
      identityError = `broker identity unavailable (status ${res.status})`;
    }
  } catch {
    identityError = "broker identity unavailable (network error)";
  }

  // Emit event with available info (excluding secrets) and stored candidates
  await publishStatusEvent(ctx, companyId, {
    bound,
    sharedDriveId,
    serviceAccountEmail,
    serviceAccountIsMember,
  });

  const response: DriveBindingStatusResult = {
    bound,
    sharedDriveId,
    tokenSet,
    serviceAccountIsMember,
  };

  if (serviceAccountEmail) {
    response.serviceAccountEmail = serviceAccountEmail;
  }
  if (identityError) {
    response.identityError = identityError;
  }

  return response;
}

/**
 * Handler for Setup plugin's drive.binding.set event.
 * Thin wrapper around driveBindingSet that catches errors and logs.
 * Never throws; validation and emission are handled by driveBindingSet.
 */
export async function onDriveBindingSetEvent(
  ctx: PluginContext,
  event: { companyId: string; payload: Record<string, unknown> },
): Promise<void> {
  const companyId = event.companyId;
  const sharedDriveId = event.payload.sharedDriveId;

  // Validate payload.sharedDriveId is a non-empty string
  if (typeof sharedDriveId !== "string" || !sharedDriveId.trim()) {
    ctx.logger.info("drive.binding.set event rejected: sharedDriveId must be a non-empty string", { companyId });
    return;
  }

  try {
    // Call the existing driveBindingSet function (it validates, persists, and emits)
    await driveBindingSet(ctx, { companyId } as Viewer, { sharedDriveId });
  } catch (error) {
    ctx.logger.info("drive.binding.set event handler failed", {
      companyId,
      sharedDriveId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
