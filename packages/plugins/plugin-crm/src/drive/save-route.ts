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
  resolveProject: (ctx: any, companyId: string, client: { kind?: string; clientKind?: string; clientRef?: string; ownWork?: boolean; projectId?: string }) => Promise<string | null | undefined>;
  save: (ctx: any, viewer: Parameters<typeof saveDriveFile>[1], input: Parameters<typeof saveDriveFile>[2]) => Promise<{ status: string; driveFileId?: string; url?: string; hint?: string }>;
  /** Clock for the timing logs; tests pin it. */
  now?: () => number;
}

const DEFAULT_DEPS: DriveSaveRouteDeps = {
  resolveProject: resolveProducerSaveProject as DriveSaveRouteDeps["resolveProject"],
  save: saveDriveFile as unknown as DriveSaveRouteDeps["save"],
};

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export function registerDriveSaveRoute(ctx: RouteCtx, deps: DriveSaveRouteDeps = DEFAULT_DEPS, producers: readonly string[] = DRIVE_PRODUCER_PLUGINS): void {
  // Producer allowlist, host-set company and bare reply names all live in registerProducerRoute.
  const now = deps.now ?? Date.now;
  const handle = async ({ producer, companyId, requestId, payload, reply: send }: ProducerRequest) => {
    // Timing logs (PAR-10212): one line when the request arrives and one when it ends, each with elapsed ms, so a slow
    // save (project lookup, folder ensure, upload) can be told from a hung one in the journal. Ids, sizes and steps only:
    // never the file name, its bytes or the signed link.
    const startedAt = now();
    const finish = (outcome: string, extra: Record<string, unknown> = {}) =>
      ctx.logger.info("Drive save finished", { requestId, producer, companyId, outcome, elapsedMs: now() - startedAt, ...extra });
    const reply = (name: string, _companyId: string, body: Record<string, unknown>) => {
      const { requestId: _ignored, ...rest } = body;
      return send(name, rest);
    };
    const { kind, name, mimeType, contentBase64, publicUrl, sha256, subfolder, clientKind, clientRef } = payload;
    const ownWork = payload.ownWork === true;
    const workProjectId = str(payload.projectId)?.trim() || undefined;
    ctx.logger.info("Drive save request received", {
      requestId,
      producer,
      companyId,
      kind: str(kind),
      subfolder: str(subfolder),
      mimeType: str(mimeType),
      mode: typeof payload.r2Url === "string" && payload.r2Url ? "r2" : contentBase64 ? "bytes" : publicUrl ? "public_url" : "none",
      base64Length: typeof contentBase64 === "string" ? contentBase64.length : undefined,
    });

    try {
      // Never mix clients (PAR-8128): the own folder is only for a producer that says the work is ours. A save that
      // names no client, no project and no ownWork lost its client somewhere, so it is refused, not filed as ours.
      if (!workProjectId && !ownWork && !(str(clientKind) && str(clientRef))) {
        await reply(DRIVE_EVENTS.failed, companyId, { requestId, reason: "no_client", hint: "The save named no client and was not marked as the company's own work (ownWork), so it was not filed anywhere." });
        finish("no_client");
        return;
      }
      const resolveStartedAt = now();
      const projectId = await deps.resolveProject(ctx, companyId, { kind: str(kind), clientKind: str(clientKind), clientRef: str(clientRef), ...(ownWork ? { ownWork } : {}), ...(workProjectId ? { projectId: workProjectId } : {}) });
      if (!projectId) {
        const hint = workProjectId
          ? "This work's project is not linked to a client in the CRM and is not the company's own Drive project. Link it (client projects) and retry."
          : clientRef
            ? "No project is linked to this client in the CRM. Link one (client projects) and retry."
            : "No project is set for the company's own Drive folder. Set drive.ownProjectId in the CRM settings.";
        await reply(DRIVE_EVENTS.failed, companyId, { requestId, reason: "no_project", hint });
        finish("no_project", { resolveProjectMs: now() - resolveStartedAt });
        return;
      }
      const resolveProjectMs = now() - resolveStartedAt;
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
      // A large file (PAR-8125): a signed R2 link, checked against R2 hosts in saveDriveFile. Progress goes back to the
      // producer after each chunk, so its wait restarts while the transfer keeps moving.
      if (typeof payload.r2Url === "string" && payload.r2Url) {
        input.r2Url = payload.r2Url;
        if (typeof payload.size === "number") input.size = payload.size;
        input.onProgress = async (bytesDone, bytesTotal) => {
          await reply(DRIVE_EVENTS.progress, companyId, { requestId, bytesDone, bytesTotal }).catch(() => undefined);
        };
      }

      // A system viewer: the producer already checked its own user; the CRM writes on the company's behalf.
      const saveStartedAt = now();
      const result = await deps.save(ctx, { companyId, userId: null, agentId: null, role: null }, input);
      const saveMs = now() - saveStartedAt;
      if (result.status === "saved") {
        await reply(DRIVE_EVENTS.saved, companyId, { requestId, driveFileId: result.driveFileId, url: result.url });
      } else {
        await reply(DRIVE_EVENTS.failed, companyId, { requestId, reason: result.status, hint: result.hint });
      }
      finish(result.status, { projectId, resolveProjectMs, saveMs });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.info("Drive save event handler failed", { requestId, producer, error: message, elapsedMs: now() - startedAt });
      await reply(DRIVE_EVENTS.failed, companyId, { requestId, reason: "handler_error", hint: message }).catch(() => undefined);
    }
  };

  registerProducerRoute(ctx, DRIVE_EVENTS.saveRequested, handle, producers);
}
