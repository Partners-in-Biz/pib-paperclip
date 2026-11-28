import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import express, { Router, type RequestHandler } from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentApiKeys,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  pluginCompanySettings,
  plugins,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { pluginRoutes } from "../routes/plugins.js";
import { memberRestrictionRouteGuard } from "../services/member-restriction/route-middleware.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import {
  parseVoiceRunProfileSetting,
  readVoiceRunProfileSetting,
  VOICE_PLUGIN_KEY,
} from "../services/heartbeat/voice-run-setting.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-15298 (plan PAR-15073 rev 3, 5.2 and 7 "Stage 1, company setting"): the board-only route for the
 * `voiceRunProfile` key in the voice plugin's company settings JSON, on the real route with the real actor
 * resolver and the member-restriction guard, plus the host call and the reader.
 */

const support = await getEmbeddedPostgresTestSupport();

describe("voice run profile setting database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => expect(support.supported).toBe(true));
});

describe("parseVoiceRunProfileSetting", () => {
  it("accepts the three values only", () => {
    expect(["off", "profile", "profile_and_warm"].map(parseVoiceRunProfileSetting)).toEqual(["off", "profile", "profile_and_warm"]);
    for (const bad of ["warm", "Profile", " profile", "", null, undefined, 1, true, {}, ["profile"]]) {
      expect(parseVoiceRunProfileSetting(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

const FOLDER_KEY = "notes";

function manifest(): PaperclipPluginManifestV1 {
  return {
    id: VOICE_PLUGIN_KEY, apiVersion: 1, version: "1.0.0", displayName: "Voice", description: "voice fixture",
    author: "Paperclip", categories: ["ui"], capabilities: ["local.folders"], entrypoints: { worker: "dist/worker.js" },
    localFolders: [{ folderKey: FOLDER_KEY, displayName: "Notes", access: "read" }],
  } as PaperclipPluginManifestV1;
}

(support.supported ? describe : describe.skip)("voice run profile company setting (PAR-15298)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  const OWNER = `owner-${randomUUID()}`;
  const ADMIN = `admin-${randomUUID()}`;
  const RESTRICTED = `restricted-${randomUUID()}`;
  const VIEWER = `viewer-${randomUUID()}`;
  const id: Record<string, string> = {};
  let sessionUser: string | null = null;
  let app: express.Express;
  let localApp: express.Express;
  let folderRoot: string;

  function mount(routeDb: Db, deploymentMode: "authenticated" | "local_trusted") {
    const instance = express();
    instance.use(express.json());
    instance.use(actorMiddleware(db, {
      deploymentMode,
      resolveSession: async () => sessionUser
        ? { session: { id: `session-${sessionUser}`, userId: sessionUser }, user: { id: sessionUser, name: sessionUser, email: null } } as never
        : null,
    }));
    const api = Router();
    api.use(memberRestrictionRouteGuard(db) as RequestHandler);
    api.use(pluginRoutes(routeDb, {} as never, undefined, undefined, undefined, undefined));
    instance.use("/api", api);
    instance.use(errorHandler);
    return instance;
  }

  const route = (companyId = id.A!) => `/api/plugins/${id.plugin}/companies/${companyId}/voice-run-profile`;
  const bearer = (value: string) => ({ authorization: ["Bearer", value].join(" ") });
  const row = async (companyId = id.A!) => (await db.select().from(pluginCompanySettings).where(and(
    eq(pluginCompanySettings.pluginId, id.plugin!), eq(pluginCompanySettings.companyId, companyId))))[0] ?? null;
  const voiceActivity = async () => (await db.select().from(activityLog).where(eq(activityLog.entityId, id.plugin!)))
    .filter((entry) => entry.action.startsWith("plugin.voice_run_profile."));
  /** Every refusal: the same row and no new activity entry. */
  async function expectNothingWritten(before: Awaited<ReturnType<typeof row>>, activityBefore: number) {
    expect(await row()).toEqual(before);
    expect(await voiceActivity()).toHaveLength(activityBefore);
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-voice-run-profile-");
    db = createDb(tempDb.connectionString);
    const [a] = await db.insert(companies).values({
      name: "A", issuePrefix: `A${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce",
    }).returning();
    const [b] = await db.insert(companies).values({ name: "B", issuePrefix: `B${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
    id.A = a!.id;
    id.B = b!.id;
    const now = new Date();
    for (const user of [OWNER, ADMIN, RESTRICTED, VIEWER]) {
      await db.insert(authUsers).values({ id: user, name: user, email: `${user}@example.test`, emailVerified: true, createdAt: now, updatedAt: now });
    }
    await db.insert(instanceUserRoles).values({ userId: ADMIN, role: "instance_admin" });
    await db.insert(companyMemberships).values([
      { companyId: id.A, principalType: "user", principalId: OWNER, membershipRole: "owner", status: "active" },
      { companyId: id.B, principalType: "user", principalId: OWNER, membershipRole: "owner", status: "active" },
      { companyId: id.A, principalType: "user", principalId: RESTRICTED, membershipRole: "operator", status: "active", restricted: true },
      { companyId: id.A, principalType: "user", principalId: VIEWER, membershipRole: "viewer", status: "active" },
    ]);
    const [agent] = await db.insert(agents).values({ companyId: id.A, name: "Ren", status: "active" }).returning();
    const keyValue = `pcp_${randomUUID()}`;
    await db.insert(agentApiKeys).values({ companyId: id.A, agentId: agent!.id, responsibleUserId: OWNER, name: "test",
      keyHash: createHash("sha256").update(keyValue).digest("hex") });
    id.agentKey = keyValue;
    const [plugin] = await db.insert(plugins).values({
      pluginKey: VOICE_PLUGIN_KEY, packageName: "@partnersinbiz/plugin-voice", version: "1.0.0", manifestJson: manifest(), status: "ready",
    }).returning();
    id.plugin = plugin!.id;
    const [other] = await db.insert(plugins).values({
      pluginKey: "paperclip.other", packageName: "paperclip-other", version: "1.0.0",
      manifestJson: { ...manifest(), id: "paperclip.other" }, status: "ready",
    }).returning();
    id.other = other!.id;
    folderRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voice-run-profile-"));
    app = mount(db, "authenticated");
    localApp = mount(db, "local_trusted");
  }, 120_000);

  afterAll(async () => {
    if (folderRoot) await fs.rm(folderRoot, { recursive: true, force: true });
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    sessionUser = null;
    await db.update(plugins).set({ status: "ready" }).where(eq(plugins.id, id.plugin!));
    await db.delete(pluginCompanySettings);
    await db.delete(activityLog);
  });

  it("a session board user sets and clears it; each write adds one activity entry; the instance flag stays off", async () => {
    sessionUser = OWNER;
    const set = await request(app).put(route()).send({ value: "profile" });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toMatchObject({ value: "profile", previous: null });
    expect((await row())?.settingsJson).toEqual({ voiceRunProfile: "profile" });
    expect(await readVoiceRunProfileSetting(db, id.A!)).toBe("profile");
    expect((await request(app).get(route())).body).toMatchObject({ value: "profile", effective: "profile" });

    const cleared = await request(app).delete(route());
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body).toMatchObject({ value: null, previous: "profile" });
    expect((await row())?.settingsJson).toEqual({});
    expect(await readVoiceRunProfileSetting(db, id.A!)).toBe("off");

    const entries = await voiceActivity();
    expect(entries.map((entry) => [entry.action, entry.companyId, entry.actorType, entry.actorId])).toEqual(expect.arrayContaining([
      ["plugin.voice_run_profile.set", id.A, "user", OWNER],
      ["plugin.voice_run_profile.cleared", id.A, "user", OWNER],
    ]));
    expect(entries).toHaveLength(2);
  });

  it("an invalid or missing value is refused with 400 and writes nothing", async () => {
    sessionUser = OWNER;
    await request(app).put(route()).send({ value: "profile" }).expect(200);
    const before = await row();
    const activityBefore = (await voiceActivity()).length;
    for (const body of [{ value: "warm" }, { value: "Profile" }, { value: null }, {}, { value: ["profile"] }]) {
      const res = await request(app).put(route()).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    await expectNothingWritten(before, activityBefore);
  });

  it("one pinned answer per caller, and nothing written on any refusal", async () => {
    const before = await row();
    const answers: Record<string, number> = {};
    sessionUser = null;
    answers.agent = (await request(app).put(route()).set(bearer(id.agentKey!)).send({ value: "profile" })).status;
    answers.agentDelete = (await request(app).delete(route()).set(bearer(id.agentKey!))).status;
    answers.none = (await request(app).put(route()).send({ value: "profile" })).status;
    sessionUser = ADMIN;
    answers.instanceAdminNotMember = (await request(app).put(route()).send({ value: "profile" })).status;
    sessionUser = VIEWER;
    answers.viewer = (await request(app).put(route()).send({ value: "profile" })).status;
    sessionUser = RESTRICTED;
    answers.restricted = (await request(app).put(route()).send({ value: "profile" })).status;
    answers.restrictedLocalFolders = (await request(app).put(`/api/plugins/${id.plugin}/companies/${id.A}/local-folders/${FOLDER_KEY}`)
      .send({ path: folderRoot })).status;
    sessionUser = OWNER;
    answers.otherPlugin = (await request(app).put(`/api/plugins/${id.other}/companies/${id.A}/voice-run-profile`).send({ value: "profile" })).status;
    expect(answers).toEqual({
      agent: 403,
      agentDelete: 403,
      none: 403,
      instanceAdminNotMember: 403,
      viewer: 403,
      restricted: answers.restrictedLocalFolders,
      restrictedLocalFolders: 403,
      otherPlugin: 404,
    });
    await expectNothingWritten(before, 0);
    expect(await row(id.B!)).toBeNull();

    // The local board (local_trusted) is the one other caller let through.
    const local = await request(localApp).put(route()).send({ value: "profile_and_warm" });
    expect(local.status, JSON.stringify(local.body)).toBe(200);
    expect(await readVoiceRunProfileSetting(db, id.A!)).toBe("profile_and_warm");
  });

  it("a failing settings read gives a non-2xx answer and writes nothing", async () => {
    sessionUser = OWNER;
    await request(app).put(route()).send({ value: "profile" }).expect(200);
    const before = await row();
    const failingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "transaction") return Reflect.get(target, prop, receiver);
        return (fn: (tx: unknown) => Promise<unknown>) => target.transaction((tx) => fn(new Proxy(tx, {
          get(txTarget, txProp, txReceiver) {
            if (txProp === "select") return () => { throw new Error("settings read failed"); };
            return Reflect.get(txTarget, txProp, txReceiver);
          },
        })));
      },
    }) as Db;
    const failing = mount(failingDb, "authenticated");
    const res = await request(failing).put(route()).send({ value: "profile_and_warm" });
    expect(res.status).toBeGreaterThanOrEqual(500);
    await expectNothingWritten(before, 1);
  });

  it("setting it keeps localFolders, and a host localFolders write keeps it; the host call cannot set it", async () => {
    sessionUser = OWNER;
    const localFolders = { [FOLDER_KEY]: { path: "/srv/notes", access: "read", requiredDirectories: [], requiredFiles: [] } };
    await db.insert(pluginCompanySettings).values({ pluginId: id.plugin!, companyId: id.A!, settingsJson: { localFolders }, lastError: "kept" });
    await request(app).put(route()).send({ value: "profile" }).expect(200);
    const afterSet = await row();
    expect(afterSet?.settingsJson).toEqual({ localFolders, voiceRunProfile: "profile" });
    expect(afterSet?.lastError).toBe("kept");
    expect(afterSet?.enabled).toBe(true);

    const host = buildHostServices(db, id.plugin!, VOICE_PLUGIN_KEY, { forPlugin: () => ({ emit: async () => {}, subscribe: () => {}, clear: () => {} }) } as never,
      undefined, { manifest: manifest() });
    try {
      await host.localFolders.configure({
        companyId: id.A!, folderKey: FOLDER_KEY, path: folderRoot,
        // A plugin passing the key along is ignored: the host writes `localFolders` only.
        ...({ voiceRunProfile: "profile_and_warm", settingsJson: { voiceRunProfile: "profile_and_warm" } } as object),
      } as Parameters<typeof host.localFolders.configure>[0]);
    } finally {
      host.dispose();
    }
    const afterHost = await row();
    expect(afterHost?.settingsJson.voiceRunProfile).toBe("profile");
    expect((afterHost?.settingsJson.localFolders as Record<string, { path: string }>)[FOLDER_KEY]?.path).toBe(folderRoot);
    expect(await readVoiceRunProfileSetting(db, id.A!)).toBe("profile");
  });

  it("merges inside one transaction: concurrent key writes both survive, a failed audit rolls the write back", async () => {
    const registry = pluginRegistryService(db);
    await Promise.all([
      registry.mergeCompanySettingsKey(id.plugin!, id.A!, "voiceRunProfile", "profile"),
      registry.mergeCompanySettingsKey(id.plugin!, id.A!, "otherKey", 1),
      registry.mergeCompanySettingsKey(id.plugin!, id.A!, "thirdKey", true),
    ]);
    expect((await row())?.settingsJson).toEqual({ voiceRunProfile: "profile", otherKey: 1, thirdKey: true });

    await expect(registry.mergeCompanySettingsKey(id.plugin!, id.A!, "voiceRunProfile", "profile_and_warm", async () => {
      throw new Error("audit failed");
    })).rejects.toThrow("audit failed");
    expect((await row())?.settingsJson.voiceRunProfile).toBe("profile");

    // Removing the key from a missing row writes nothing.
    await registry.mergeCompanySettingsKey(id.plugin!, id.B!, "voiceRunProfile", undefined);
    expect(await row(id.B!)).toBeNull();
  });

  it("reads off for no row, no key, a lost key, an invalid value, the plugin disabled; companies never share", async () => {
    const registry = pluginRegistryService(db);
    expect(await readVoiceRunProfileSetting(db, id.A!)).toBe("off");
    await db.insert(pluginCompanySettings).values({ pluginId: id.plugin!, companyId: id.A!, settingsJson: { localFolders: {} } });
    expect(await readVoiceRunProfileSetting(db, id.A!)).toBe("off");

    await registry.mergeCompanySettingsKey(id.plugin!, id.A!, "voiceRunProfile", "profile_and_warm");
    expect(await readVoiceRunProfileSetting(db, id.A!)).toBe("profile_and_warm");
    expect(await readVoiceRunProfileSetting(db, id.B!)).toBe("off");

    await db.update(pluginCompanySettings).set({ enabled: false }).where(eq(pluginCompanySettings.companyId, id.A!));
    expect(await readVoiceRunProfileSetting(db, id.A!)).toBe("off");
    await db.update(pluginCompanySettings).set({ enabled: true }).where(eq(pluginCompanySettings.companyId, id.A!));
    await db.update(plugins).set({ status: "disabled" }).where(eq(plugins.id, id.plugin!));
    expect(await readVoiceRunProfileSetting(db, id.A!)).toBe("off");
    await db.update(plugins).set({ status: "ready" }).where(eq(plugins.id, id.plugin!));

    await db.update(pluginCompanySettings).set({ settingsJson: { voiceRunProfile: "turbo" } }).where(eq(pluginCompanySettings.companyId, id.A!));
    expect(await readVoiceRunProfileSetting(db, id.A!)).toBe("off");

    // A whole-JSON write from a stale read (the localFolders path) drops the key: it reads as off.
    await registry.mergeCompanySettingsKey(id.plugin!, id.A!, "voiceRunProfile", "profile");
    await registry.upsertCompanySettings(id.plugin!, id.A!, { settingsJson: { localFolders: {} } });
    expect(await readVoiceRunProfileSetting(db, id.A!)).toBe("off");

    // Company B on, company A untouched.
    await registry.mergeCompanySettingsKey(id.plugin!, id.B!, "voiceRunProfile", "profile");
    expect(await readVoiceRunProfileSetting(db, id.B!)).toBe("profile");
    expect(await readVoiceRunProfileSetting(db, id.A!)).toBe("off");
  });
});
