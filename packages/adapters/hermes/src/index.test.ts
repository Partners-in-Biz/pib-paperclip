import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import {
  createHermesGatewayServerAdapter,
  createHermesLocalServerAdapter,
  createServerAdapter,
  hermesGatewayType,
} from "./index.js";
import { createServerAdapter as createGatewayServerAdapterFromSubpath } from "./gateway/index.js";

test("root package export exposes Paperclip external adapter entrypoint", () => {
  const adapter = createServerAdapter();

  expect(adapter.type).toBe("hermes_local");
  expect(typeof adapter.execute).toBe("function");
  expect(typeof adapter.testEnvironment).toBe("function");
  expect(typeof adapter.sessionCodec?.deserialize).toBe("function");
  expect(adapter.sessionManagement?.nativeContextManagement).toBe("confirmed");
  expect(adapter.supportsLocalAgentJwt).toBe(true);
  expect(adapter.supportsInstructionsBundle).toBe(true);
  expect(adapter.instructionsPathKey).toBe("instructionsFilePath");
  expect(adapter.getRuntimeCommandSpec?.({ command: "hermes-dev" })).toMatchObject({
    command: "hermes-dev",
    detectCommand: "hermes-dev",
    installCommand: null,
  });
  expect(typeof adapter.detectModel).toBe("function");
  expect(typeof adapter.getConfigSchema).toBe("function");
});

test("root package export keeps explicit local and gateway adapter factories", () => {
  const localAdapter = createHermesLocalServerAdapter();
  const gatewayAdapter = createHermesGatewayServerAdapter();

  expect(localAdapter.type).toBe("hermes_local");
  expect(gatewayAdapter.type).toBe("hermes_gateway");
  expect(hermesGatewayType).toBe("hermes_gateway");
  expect(gatewayAdapter.supportsLocalAgentJwt).toBe(false);
  expect(gatewayAdapter.supportsInstructionsBundle).toBe(false);
});

test("gateway subpath export exposes the Hermes Gateway adapter entrypoint", () => {
  const adapter = createGatewayServerAdapterFromSubpath();

  expect(adapter.type).toBe("hermes_gateway");
  expect(typeof adapter.execute).toBe("function");
  expect(typeof adapter.testEnvironment).toBe("function");
  expect(typeof adapter.sessionCodec?.deserialize).toBe("function");
  expect(adapter.sessionManagement?.nativeContextManagement).toBe("confirmed");
  expect(typeof adapter.getConfigSchema).toBe("function");
});

test("Hermes adapter exposes bundled Paperclip task bridge skill", async () => {
  const adapter = createServerAdapter();
  const snapshot = await adapter.listSkills?.({
    adapterType: "hermes_local",
    agentId: "11111111-1111-4111-8111-111111111111",
    companyId: "22222222-2222-4222-8222-222222222222",
    config: {},
  });

  expect(snapshot?.entries.some((entry) => entry.runtimeName === "paperclip-task-bridge")).toBe(true);
});

test("Hermes keeps the operational Paperclip skill linked after an empty replacement", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-core-skill-"));
  try {
    const source = path.join(home, "runtime-skills", "paperclip");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), "# Paperclip\n", "utf8");
    const adapter = createServerAdapter();
    const snapshot = await adapter.syncSkills?.({
      adapterType: "hermes_local",
      agentId: "11111111-1111-4111-8111-111111111111",
      companyId: "22222222-2222-4222-8222-222222222222",
      config: {
        env: { HOME: home },
        paperclipRuntimeSkills: [{
          key: "paperclipai/paperclip/paperclip",
          runtimeName: "paperclip",
          source,
        }],
        paperclipSkillSync: { desiredSkills: [] },
      },
    }, []);

    expect(snapshot?.desiredSkills).toContain("paperclipai/paperclip/paperclip");
    expect((await fs.lstat(path.join(home, ".hermes", "skills", "paperclip"))).isSymbolicLink()).toBe(true);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("Hermes rejects a conflicting operational skill target", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-core-conflict-"));
  try {
    const source = path.join(home, "runtime-skills", "paperclip");
    const target = path.join(home, ".hermes", "skills", "paperclip");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), "# Paperclip\n", "utf8");
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "SKILL.md"), "# Conflicting skill\n", "utf8");
    const adapter = createServerAdapter();

    await expect(adapter.syncSkills?.({
      adapterType: "hermes_local",
      agentId: "11111111-1111-4111-8111-111111111111",
      companyId: "22222222-2222-4222-8222-222222222222",
      config: {
        env: { HOME: home },
        paperclipRuntimeSkills: [{
          key: "paperclipai/paperclip/paperclip",
          runtimeName: "paperclip",
          source,
        }],
      },
    }, [])).rejects.toThrow("occupied by another installation");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("Hermes rejects a live symlink owned by another operational skill", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-core-link-conflict-"));
  try {
    const source = path.join(home, "runtime-skills", "paperclip");
    const conflictingSource = path.join(home, "external-skills", "paperclip");
    const target = path.join(home, ".hermes", "skills", "paperclip");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), "# Paperclip\n", "utf8");
    await fs.mkdir(conflictingSource, { recursive: true });
    await fs.writeFile(path.join(conflictingSource, "SKILL.md"), "# External skill\n", "utf8");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(conflictingSource, target);
    const adapter = createServerAdapter();

    await expect(adapter.syncSkills?.({
      adapterType: "hermes_local",
      agentId: "11111111-1111-4111-8111-111111111111",
      companyId: "22222222-2222-4222-8222-222222222222",
      config: {
        env: { HOME: home },
        paperclipRuntimeSkills: [{
          key: "paperclipai/paperclip/paperclip",
          runtimeName: "paperclip",
          source,
        }],
      },
    }, [])).rejects.toThrow("occupied by another installation");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

const COMPANY = "22222222-2222-4222-8222-222222222222";
const SKILL_ID = "33333333-3333-4333-8333-333333333333";
const VERSION_ID = "44444444-4444-4444-8444-444444444444";

async function syncWithLink(opts: {
  linkRel: string[] | null; // path under home/skills/<company>-root, or null for a real dir
  linkRoot?: string; // override root that holds __versions__
  versionId?: string;
}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-versioned-link-"));
  try {
    const skillsRoot = path.join(home, "skills", COMPANY);
    const source = path.join(skillsRoot, "paperclip");
    const target = path.join(home, ".hermes", "skills", "paperclip");
    await fs.mkdir(source, { recursive: true });
    await fs.mkdir(path.dirname(target), { recursive: true });
    let linked: string;
    if (opts.linkRel) {
      linked = path.join(opts.linkRoot ?? skillsRoot, "__versions__", ...opts.linkRel);
      await fs.mkdir(linked, { recursive: true });
      await fs.writeFile(path.join(linked, "SKILL.md"), "# Paperclip\n", "utf8");
      await fs.symlink(linked, target);
    } else {
      linked = target;
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, "SKILL.md"), "# Other\n", "utf8");
    }
    const adapter = createServerAdapter();
    const run = () => adapter.syncSkills?.({
      adapterType: "hermes_local",
      agentId: "11111111-1111-4111-8111-111111111111",
      companyId: COMPANY,
      config: {
        env: { HOME: home },
        paperclipRuntimeSkills: [{
          key: "paperclipai/paperclip/paperclip",
          runtimeName: "paperclip",
          source,
          ...(opts.versionId ? { versionId: opts.versionId } : {}),
        }],
      },
    }, []);
    return { run, target, linked };
  } catch (err) {
    await fs.rm(home, { recursive: true, force: true });
    throw err;
  }
}

test("Hermes treats a versioned cache link under the same skills root as the same installation (no versionId)", async () => {
  const ctx = await syncWithLink({ linkRel: [SKILL_ID, VERSION_ID] });
  const snapshot = await ctx.run();
  expect(snapshot?.desiredSkills).toContain("paperclipai/paperclip/paperclip");
  expect(await fs.readlink(ctx.target)).toBe(ctx.linked);
});

test("Hermes accepts a versioned cache link whose basename matches the entry versionId", async () => {
  const ctx = await syncWithLink({ linkRel: [SKILL_ID, VERSION_ID], versionId: VERSION_ID });
  const snapshot = await ctx.run();
  expect(snapshot?.desiredSkills).toContain("paperclipai/paperclip/paperclip");
  expect(await fs.readlink(ctx.target)).toBe(ctx.linked);
});

test("Hermes rejects a versioned cache link with a non-matching versionId", async () => {
  const ctx = await syncWithLink({
    linkRel: [SKILL_ID, VERSION_ID],
    versionId: "55555555-5555-4555-8555-555555555555",
  });
  await expect(ctx.run()).rejects.toThrow("occupied by another installation");
});

test("Hermes rejects a versioned cache link under a different company root", async () => {
  const ctx = await syncWithLink({
    linkRel: [SKILL_ID, VERSION_ID],
    linkRoot: path.join(os.tmpdir(), `paperclip-other-root-${process.pid}-${Date.now()}`),
  });
  try {
    await expect(ctx.run()).rejects.toThrow("occupied by another installation");
  } finally {
    await fs.rm(path.dirname(path.dirname(path.dirname(ctx.linked))), { recursive: true, force: true });
  }
});

test("Hermes rejects a real directory at the target even with a versions cache present", async () => {
  const ctx = await syncWithLink({ linkRel: null, versionId: VERSION_ID });
  await expect(ctx.run()).rejects.toThrow("occupied by another installation");
});
