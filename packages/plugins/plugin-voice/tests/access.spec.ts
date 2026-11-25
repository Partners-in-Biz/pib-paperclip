/**
 * The access guard of Voice (access stage A, spec PAR-12578 sections 4.4 to 4.6; PAR-12678): the kit's test helper on
 * the real plugin (registration, table, data handlers, source, behaviour and agent checks), `voice.use` off for every
 * preset, the one-file rule for `usePluginAction`, the gated app-shell slot, and the real handlers under each switch mode.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { PERMISSION_DENIED, PRESETS, accessCompanyScope, accessGrantScope } from "@partnersinbiz/pib-plugin-kit";
import { assertPluginAccess } from "@partnersinbiz/pib-plugin-kit/access-testing";
import { AccessRefused, checkAccess, unwrapRefusal } from "@partnersinbiz/pib-plugin-ui";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { ACCESS_TABLE } from "../src/access-table.js";
import { voiceAccess } from "../src/ui/actions.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });

const id = (n: number) => `a4f00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [COMPANY, OWNER, OPERATOR, GRANTED, SETTINGS_ONLY] = [1, 2, 3, 4, 5].map(id);
const NOT_SET_UP = /Voice is not set up yet/;

describe("Voice access guard", () => {
  it("every action goes through the guard and the table, data handlers are the named two; switch off passes, enforce refuses (4.5 items 1 to 6)", async () => {
    const harness = createTestHarness({ manifest });
    await assertPluginAccess({ harness, setup: plugin.definition.setup, manifest, table: ACCESS_TABLE, srcDir: SRC });
  });

  it("the table names only Voice's own resources, nothing is scoped, and only Full access holds a voice key (off by default, S7)", () => {
    for (const [key, entry] of Object.entries(ACCESS_TABLE)) {
      expect(typeof entry === "object" && "resource" in entry, key).toBe(true);
      if (typeof entry !== "object" || !("resource" in entry)) continue;
      expect(entry.resource, key).toMatch(/^voice\.(use|settings)$/);
      expect(entry.scoped, key).toBeUndefined();
    }
    expect(ACCESS_TABLE.transcribe).toEqual({ resource: "voice.use", action: "create" });
    expect(ACCESS_TABLE["live-session"]).toEqual({ resource: "voice.use", action: "create" });
    for (const preset of Object.values(PRESETS)) {
      if (preset.id === "fullAccess") continue;
      expect(preset.permissions.filter((p) => p.startsWith("voice.")), preset.id).toEqual([]);
    }
  });

  it("only src/ui/actions.ts imports usePluginAction; every other UI file uses the wrapped hook", () => {
    const direct = files(join(SRC, "ui"))
      .filter((f) => relative(SRC, f) !== join("ui", "actions.ts"))
      .filter((f) => /\busePluginAction\b/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(direct).toEqual([]);
  });

  it("each manifest slot's export renders its body inside the access gate", () => {
    const index = readFileSync(join(SRC, "ui", "index.tsx"), "utf8");
    const slots = manifest.ui?.slots ?? [];
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      const body = index.match(new RegExp(`export function ${slot.exportName}\\(\\)[^]*?\\n}\\n`))?.[0] ?? "";
      expect(body, slot.exportName).toMatch(/useAccess\(useAccessMe\(\), /);
      expect(body, slot.exportName).toMatch(/<AccessGate state=\{access\} kind="widget">/);
    }
  });

  describe("real handlers", () => {
    async function voice(mode?: "off" | "enforce") {
      const harness = createTestHarness({ manifest });
      const at = new Date().toISOString();
      const member = (userId: string, role: string) => ({ id: `m-${userId}`, companyId: COMPANY, principalType: "user" as const, principalId: userId, status: "active" as const, membershipRole: role, grants: [], createdAt: at, updatedAt: at });
      harness.seed({ accessMembers: [member(OWNER, "owner"), member(OPERATOR, "member"), member(GRANTED, "member"), member(SETTINGS_ONLY, "member")] });
      await plugin.definition.setup(harness.ctx);
      if (mode) await harness.ctx.state.set(accessCompanyScope(COMPANY), { mode, rev: 1, userIds: [], receivedAt: at });
      // The manager preset (every area but Voice): the mic stays shut.
      await harness.ctx.state.set(accessGrantScope(COMPANY, OPERATOR), { preset: "manager", allow: [] });
      await harness.ctx.state.set(accessGrantScope(COMPANY, SETTINGS_ONLY), { allow: ["voice.settings:view", "voice.settings:edit"] });
      await harness.ctx.state.set(accessGrantScope(COMPANY, GRANTED), { allow: ["voice.use:create", "voice.use:view"] });
      const as = (userId: string) => ({ companyId: COMPANY, actor: { type: "user" as const, userId } });
      return { harness, as };
    }

    it("switch absent or off: an operator gets today's answer (the handler runs)", async () => {
      for (const mode of [undefined, "off"] as const) {
        const { harness, as } = await voice(mode);
        await expect(harness.performAction("transcribe", { audio: "" }, as(OPERATOR))).rejects.toThrow(NOT_SET_UP);
        await expect(harness.performAction("live-session", {}, as(OPERATOR))).rejects.toThrow(NOT_SET_UP);
      }
    });

    it("enforce: an operator without voice.use gets the refusal form; the owner and a person granted voice.use get today's answer", async () => {
      const { harness, as } = await voice("enforce");
      for (const key of ["transcribe", "live-session", "set-agent-voice"]) {
        expect(await harness.performAction(key, {}, as(OPERATOR)), key).toMatchObject({ ok: false, refused: true, code: PERMISSION_DENIED });
      }
      await expect(harness.performAction("transcribe", { audio: "" }, as(OWNER))).rejects.toThrow(NOT_SET_UP);
      await expect(harness.performAction("live-session", {}, as(GRANTED))).rejects.toThrow(NOT_SET_UP);
      // voice.use alone does not change an agent's voice.
      expect(await harness.performAction("set-agent-voice", {}, as(GRANTED))).toMatchObject({ refused: true, code: PERMISSION_DENIED });
    });

    it("the gate: open with the switch absent or off, for the owner and with voice.use; closed without voice.use under enforce", async () => {
      const gate = async (mode: "off" | "enforce" | undefined, userId: string) => {
        const { harness, as } = await voice(mode);
        // As `useAccessMe` reads it: the kit's answer through `voiceAccess`.
        return checkAccess(async (params) => voiceAccess(await harness.performAction("access.me", params, as(userId))), COMPANY);
      };
      expect(await gate(undefined, OPERATOR)).toBe("open");
      expect(await gate("off", OPERATOR)).toBe("open");
      expect(await gate("enforce", OWNER)).toBe("open");
      expect(await gate("enforce", GRANTED)).toBe("open");
      expect(await gate("enforce", OPERATOR)).toBe("closed");
      // voice.settings alone opens the kit's gate, but there is no mic to show for it.
      expect(await gate("enforce", SETTINGS_ONLY)).toBe("closed");
    });

    it("voiceAccess keeps a refusal, a closed answer and an unread (no permissions) open answer as they are", () => {
      const refusal = { ok: false, refused: true, code: PERMISSION_DENIED, message: "No" };
      expect(voiceAccess(refusal)).toBe(refusal);
      const unread = { mode: "enforce", open: true, permissions: [] };
      expect(voiceAccess(unread)).toBe(unread);
      expect(voiceAccess(null)).toBeNull();
    });

    it("a refusal throws with the worker's message instead of reading as success (withRefusal)", async () => {
      const { harness, as } = await voice("enforce");
      const answer = await harness.performAction("transcribe", { audio: "" }, as(OPERATOR));
      expect(() => unwrapRefusal(answer)).toThrow(AccessRefused);
      expect(() => unwrapRefusal(answer)).toThrow((answer as { message: string }).message);
    });

    it("the two data handlers answer as today under enforce (they carry no caller, spec 4.4)", async () => {
      const { harness } = await voice("enforce");
      expect(await harness.getData("status", { companyId: COMPANY })).toEqual({ configured: false, liveEnabled: false, voiceNoteAutoSend: false });
    });
  });
});
