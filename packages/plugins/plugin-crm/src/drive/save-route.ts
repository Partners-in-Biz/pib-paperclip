/**
 * The Drive save route for producer plugins (kit `driveSave`), PAR-8114.
 *
 * The host delivers a plugin's emit as `plugin.<emitterId>.<name>` and refuses emits whose name starts with
 * `plugin.`. So the CRM subscribes to `plugin.<producer>.drive.save-requested` for each known producer (the host has
 * only a trailing wildcard), accepts only those producers, and replies with the bare `drive.file.saved` /
 * `drive.file.failed`, which the host delivers as `plugin.partnersinbiz.crm.drive.file.*` (what the kit listens on).
 * The company comes from the event, which the host checks against the producer, and decides which Drive is written.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { DRIVE_EVENTS, DRIVE_PRODUCER_PLUGINS } from "@partnersinbiz/pib-plugin-kit";
import { resolveProducerSaveProject } from "./tools.js";
import { saveDriveFile } from "./save.js";
import { registerProducerRoute, type ProducerRequest } from "./producer-route.js";

type RouteCtx = Pick<PluginContext, "events" | "logger">;

export interface DriveSaveRouteDeps {
  resolveProject: (ctx: any, companyId: string, client: { kind?: string; clientKind?: string; clientRef?: string }) => Promise<string | null | undefined>;
  save: (ctx: any, viewer: Parameters<typeof saveDriveFile>[1], input: Parameters<typeof saveDriveFile>[2]) => Promise<{ status: string; driveFileId?: string; url?: string; hint?: string }>;
}

const DEFAULT_DEPS: DriveSaveRouteDeps = {
  resolveProject: resolveProducerSaveProject as DriveSaveRouteDeps["resolveProject"],
  save: saveDriveFile as unknown as DriveSaveRouteDeps["save"],
};

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export function registerDriveSaveRoute(ctx: RouteCtx, deps: DriveSaveRouteDeps = DEFAULT_DEPS, producers: readonly string[] = DRIVE_PRODUCER_PLUGINS): void {
  // Producer allowlist, host-set company and bare reply names all live in registerProducerRoute.
  const handle = async ({ producer, companyId, requestId, payload, reply: send }: ProducerRequest) => {
    const reply = (name: string, _companyId: string, body: Record<string, unknown>) => {
      const { requestId: _ignored, ...rest } = body;
      return send(name, rest);
    };
    const { kind, name, mimeType, contentBase64, publicUrl, sha256, subfolder, clientKind, clientRef } = payload;

    try {
      const projectId = await deps.resolveProject(ctx, companyId, { kind: str(kind), clientKind: str(clientKind), clientRef: str(clientRef) });
      if (!projectId) {
        const hint = clientRef
          ? "No project is linked to this client in the CRM. Link one (client projects) and retry."
          : "No project is set for the company's own Drive folder. Set drive.ownProjectId in the CRM settings.";
        await reply(DRIVE_EVENTS.failed, companyId, { requestId, reason: "no_project", hint });
        return;
      }
      const input: Parameters<typeof saveDriveFile>[2] = {
        companyId,
        projectId,
        fileKind: str(kind) || "ops",
        name: str(name) || "",
        mimeType: str(mimeType) || "",
      };
      if (contentBase64) input.contentBase64 = contentBase64 as string;
      if (publicUrl) input.publicUrl = publicUrl as string;
      if (sha256) input.sha256 = sha256 as string;
      if (subfolder) input.subfolder = subfolder as string;

      // A system viewer: the producer already checked its own user; the CRM writes on the company's behalf.
      const result = await deps.save(ctx, { companyId, userId: null, agentId: null, role: null }, input);
      if (result.status === "saved") {
        await reply(DRIVE_EVENTS.saved, companyId, { requestId, driveFileId: result.driveFileId, url: result.url });
      } else {
        await reply(DRIVE_EVENTS.failed, companyId, { requestId, reason: result.status, hint: result.hint });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.info("Drive save event handler failed", { requestId, producer, error: message });
      await reply(DRIVE_EVENTS.failed, companyId, { requestId, reason: "handler_error", hint: message }).catch(() => undefined);
    }
  };

  registerProducerRoute(ctx, DRIVE_EVENTS.saveRequested, handle, producers);
}
