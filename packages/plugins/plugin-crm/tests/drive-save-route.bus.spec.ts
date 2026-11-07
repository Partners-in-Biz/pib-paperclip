/**
 * PAR-8114: the Drive save route over the host's REAL plugin event bus (server/src/services/plugin-event-bus.ts),
 * with a producer (Studio) and the CRM both subscribed. The SDK test harness accepts any event name, which hid that
 * the CRM listened on a name the host never delivers and replied with names the host refuses.
 */
import { describe, it, expect, vi } from "vitest";
import { driveSave, DRIVE_PRODUCER_PLUGINS } from "@partnersinbiz/pib-plugin-kit";
import { registerDriveSaveRoute, type DriveSaveRouteDeps } from "../src/drive/save-route.js";

interface ScopedBus {
  subscribe(pattern: string, fn: (event: any) => Promise<void> | void): void;
  emit(name: string, companyId: string, payload: unknown): Promise<{ errors: unknown[] }>;
}
interface HostBus {
  forPlugin(pluginId: string): ScopedBus;
}

// A runtime path so the plugin's tsc does not pull server sources into its program; vitest loads the TS directly.
const BUS_MODULE = new URL("../../../../server/src/services/plugin-event-bus.ts", import.meta.url).href;
async function hostBus(): Promise<HostBus> {
  const mod = (await import(/* @vite-ignore */ BUS_MODULE)) as { createPluginEventBus: () => HostBus };
  return mod.createPluginEventBus();
}

/** The worker ctx.events the SDK gives a plugin, wired straight to its scoped host bus. */
function pluginCtx(bus: HostBus, pluginId: string) {
  const scoped = bus.forPlugin(pluginId);
  return {
    events: {
      on: (name: string, ...rest: unknown[]) => {
        const fn = rest[rest.length - 1] as (event: any) => Promise<void>;
        scoped.subscribe(name, fn);
        return () => undefined;
      },
      emit: async (name: string, companyId: string, payload: unknown) => {
        await scoped.emit(name, companyId, payload);
      },
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as any;
}

const CO = "company-a";
const FILE_ID = "1AbCdEfGhIjKlMnOp";

function crmDeps(over: Partial<DriveSaveRouteDeps> = {}) {
  const resolveProject = vi.fn(async (..._args: unknown[]) => "p1" as string | null);
  const save = vi.fn(async (..._args: unknown[]) => ({ status: "saved", driveFileId: FILE_ID, url: `https://drive.google.com/file/d/${FILE_ID}/view` }));
  return { resolveProject, save, ...over } as DriveSaveRouteDeps & { resolveProject: typeof resolveProject; save: typeof save };
}

const opts = (extra: Record<string, unknown> = {}) => ({
  companyId: CO,
  kind: "marketing",
  name: "2026-11-07 hero abcd1234 v1.png",
  mimeType: "image/png",
  bytes: Buffer.from("png-bytes"),
  subfolder: "02 Assets" as const,
  client: { kind: "company", ref: "co-a" },
  timeoutMs: 2_000,
  ...extra,
});

describe("Drive save route on the host event bus", () => {
  it("the host refuses a plugin emit named with the plugin. prefix (why the old CRM replies never left)", async () => {
    const crm = (await hostBus()).forPlugin("partnersinbiz.crm");
    await expect(crm.emit("plugin.partnersinbiz.crm.drive.file.saved", CO, {})).rejects.toThrow(/plugin\./);
  });

  it("Studio's driveSave reaches the CRM and gets drive.file.saved back, for the right company, client and 02 Assets", async () => {
    const bus = await hostBus();
    const deps = crmDeps();
    registerDriveSaveRoute(pluginCtx(bus, "partnersinbiz.crm"), deps);

    const result = await driveSave(pluginCtx(bus, "partnersinbiz.studio"), opts());

    expect(result).toMatchObject({ status: "saved", driveFileId: FILE_ID });
    expect(deps.resolveProject).toHaveBeenCalledWith(expect.anything(), CO, { kind: "marketing", clientKind: "company", clientRef: "co-a" });
    expect(deps.save).toHaveBeenCalledTimes(1);
    expect(deps.save.mock.calls[0]![1]).toMatchObject({ companyId: CO, userId: null });
    expect(deps.save.mock.calls[0]![2]).toMatchObject({ companyId: CO, projectId: "p1", fileKind: "marketing", subfolder: "02 Assets", mimeType: "image/png" });
  });

  it.each([...DRIVE_PRODUCER_PLUGINS])("producer %s is heard", async (producer) => {
    const bus = await hostBus();
    const deps = crmDeps();
    registerDriveSaveRoute(pluginCtx(bus, "partnersinbiz.crm"), deps);
    expect((await driveSave(pluginCtx(bus, producer), opts())).status).toBe("saved");
  });

  it("an unknown plugin's request never reaches the Drive", async () => {
    const bus = await hostBus();
    const deps = crmDeps();
    registerDriveSaveRoute(pluginCtx(bus, "partnersinbiz.crm"), deps);
    const result = await driveSave(pluginCtx(bus, "someone.else"), opts({ timeoutMs: 100 }));
    expect(result.status).toBe("no_ack");
    expect(deps.resolveProject).not.toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("a refusal comes back as drive.file.failed with its reason (no project for the client)", async () => {
    const bus = await hostBus();
    const deps = crmDeps({ resolveProject: vi.fn(async () => null) });
    registerDriveSaveRoute(pluginCtx(bus, "partnersinbiz.crm"), deps);
    const result = await driveSave(pluginCtx(bus, "partnersinbiz.studio"), opts());
    expect(result).toMatchObject({ status: "failed", reason: "no_project" });
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("a save error comes back as handler_error, not a timeout", async () => {
    const bus = await hostBus();
    const deps = crmDeps({ save: vi.fn(async () => { throw new Error("google down"); }) });
    registerDriveSaveRoute(pluginCtx(bus, "partnersinbiz.crm"), deps);
    expect(await driveSave(pluginCtx(bus, "partnersinbiz.studio"), opts())).toMatchObject({ status: "failed", reason: "handler_error", hint: "google down" });
  });

  it("a reply for one company does not settle the same request id waiting in another company", async () => {
    const bus = await hostBus();
    const studio = pluginCtx(bus, "partnersinbiz.studio");
    const pending = driveSave(studio, opts({ companyId: "company-b", requestId: "req1", timeoutMs: 150 }));
    await bus.forPlugin("partnersinbiz.crm").emit("drive.file.saved", CO, { requestId: "req1", driveFileId: FILE_ID, url: "https://x" });
    expect((await pending).status).toBe("no_ack");
  });
});
