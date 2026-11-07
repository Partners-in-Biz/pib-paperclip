/**
 * PAR-8128: the company's own Drive folder must be asked for. Over the host's REAL plugin event bus, every producer's
 * save shape reaches the CRM route: a client save and an `ownWork` save are filed, a save with neither (a producer
 * that lost its client, or an older producer) is refused with `no_client` and the resolver is never asked.
 */
import { describe, it, expect, vi } from "vitest";
import { driveSave } from "@partnersinbiz/pib-plugin-kit";
import { registerDriveSaveRoute, type DriveSaveRouteDeps } from "../src/drive/save-route.js";
import { resolveProducerSaveProject } from "../src/drive/tools.js";

interface ScopedBus {
  subscribe(pattern: string, fn: (event: any) => Promise<void> | void): void;
  emit(name: string, companyId: string, payload: unknown): Promise<{ errors: unknown[] }>;
}
interface HostBus {
  forPlugin(pluginId: string): ScopedBus;
}

const BUS_MODULE = new URL("../../../../server/src/services/plugin-event-bus.ts", import.meta.url).href;
async function hostBus(): Promise<HostBus> {
  const mod = (await import(/* @vite-ignore */ BUS_MODULE)) as { createPluginEventBus: () => HostBus };
  return mod.createPluginEventBus();
}

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

function crmDeps() {
  const resolveProject = vi.fn(async (..._args: unknown[]) => "p1" as string | null);
  const save = vi.fn(async (..._args: unknown[]) => ({ status: "saved", driveFileId: FILE_ID, url: `https://drive.google.com/file/d/${FILE_ID}/view` }));
  return { resolveProject, save } as DriveSaveRouteDeps & { resolveProject: typeof resolveProject; save: typeof save };
}

const base = { companyId: CO, kind: "marketing", name: "2026-11-07 hero abcd1234 v1.png", mimeType: "image/png", bytes: Buffer.from("png"), subfolder: "02 Assets" as const, timeoutMs: 2_000 };

describe("own Drive folder only on request (PAR-8128), host event bus", () => {
  it.each([
    ["partnersinbiz.studio"],
    ["partnersinbiz.social"],
    ["partnersinbiz.ads"],
    ["partnersinbiz.seo"],
    ["partnersinbiz.cockpit"],
  ])("%s: no client and no ownWork is refused and never resolved", async (producer) => {
    const bus = await hostBus();
    const deps = crmDeps();
    registerDriveSaveRoute(pluginCtx(bus, "partnersinbiz.crm"), deps);
    const result = await driveSave(pluginCtx(bus, producer), { ...base });
    expect(result).toMatchObject({ status: "failed", reason: "no_client" });
    expect(deps.resolveProject).not.toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
  });

  it.each([["partnersinbiz.studio"], ["partnersinbiz.social"], ["partnersinbiz.ads"], ["partnersinbiz.seo"]])("%s: ownWork reaches the resolver as own work", async (producer) => {
    const bus = await hostBus();
    const deps = crmDeps();
    registerDriveSaveRoute(pluginCtx(bus, "partnersinbiz.crm"), deps);
    const result = await driveSave(pluginCtx(bus, producer), { ...base, ownWork: true });
    expect(result.status).toBe("saved");
    expect(deps.resolveProject.mock.calls[0]![2]).toMatchObject({ ownWork: true });
    expect(deps.resolveProject.mock.calls[0]![2]).not.toHaveProperty("clientRef", expect.anything());
  });

  it("a client save is filed for that client, not as own work", async () => {
    const bus = await hostBus();
    const deps = crmDeps();
    registerDriveSaveRoute(pluginCtx(bus, "partnersinbiz.crm"), deps);
    const result = await driveSave(pluginCtx(bus, "partnersinbiz.seo"), { ...base, kind: "seo", client: { kind: "company", ref: "co-a" } });
    expect(result.status).toBe("saved");
    expect(deps.resolveProject.mock.calls[0]![2]).toMatchObject({ clientKind: "company", clientRef: "co-a" });
    expect(deps.resolveProject.mock.calls[0]![2]).not.toHaveProperty("ownWork");
  });

  it("cockpit: the issue's project is passed through for the CRM to check", async () => {
    const bus = await hostBus();
    const deps = crmDeps();
    registerDriveSaveRoute(pluginCtx(bus, "partnersinbiz.crm"), deps);
    const result = await driveSave(pluginCtx(bus, "partnersinbiz.cockpit"), { ...base, kind: "ops", subfolder: "05 Evidence", projectId: "proj-client" });
    expect(result.status).toBe("saved");
    expect(deps.resolveProject.mock.calls[0]![2]).toMatchObject({ projectId: "proj-client" });
  });

  it("the kit refuses ownWork together with a client before anything is sent", async () => {
    const bus = await hostBus();
    const deps = crmDeps();
    registerDriveSaveRoute(pluginCtx(bus, "partnersinbiz.crm"), deps);
    const result = await driveSave(pluginCtx(bus, "partnersinbiz.studio"), { ...base, ownWork: true, client: { kind: "company", ref: "co-a" } });
    expect(result).toMatchObject({ status: "failed", reason: "invalid_input" });
    expect(deps.resolveProject).not.toHaveBeenCalled();
  });
});

describe("resolveProducerSaveProject (PAR-8128)", () => {
  function resolverCtx(opts: { ownProjectId?: string; linked?: string[] }) {
    return {
      db: {
        namespace: "plugin_crm",
        query: vi.fn(async (sql: string, params: unknown[]) => {
          if (/WHERE company_id = \$1 AND project_id = \$2/.test(sql)) return (opts.linked ?? []).includes(params[1] as string) ? [{ project_id: params[1] }] : [];
          return [];
        }),
      },
      config: { get: vi.fn(async () => ({})) },
      state: { get: vi.fn(async () => ({ drive: { ownProjectId: opts.ownProjectId } })) },
    } as any;
  }

  it("no client and no ownWork: null even when the own project is set", async () => {
    await expect(resolveProducerSaveProject(resolverCtx({ ownProjectId: "own-1" }), CO, {})).resolves.toBeNull();
  });

  it("projectId not linked to a client and not the own project: refused", async () => {
    await expect(resolveProducerSaveProject(resolverCtx({ ownProjectId: "own-1", linked: ["client-p"] }), CO, { projectId: "other-p" })).resolves.toBeNull();
  });

  it("projectId linked to a client: that project", async () => {
    await expect(resolveProducerSaveProject(resolverCtx({ ownProjectId: "own-1", linked: ["client-p"] }), CO, { projectId: "client-p" })).resolves.toBe("client-p");
  });
});
