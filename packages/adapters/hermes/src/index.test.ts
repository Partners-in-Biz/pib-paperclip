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
import { reconcileHermesPaperclipSkills, type ReconcileHermesSkillsOptions } from "./server/skills.js";

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

const OTHER_VERSION = "55555555-5555-4555-8555-555555555555";

async function syncWithLink(opts: {
  linkRel: string[] | null; // path under home/skills/<company>-root, or null for a real dir
  linkRoot?: string; // override root that holds __versions__
  versionId?: string;
  currentVersionId?: string;
  sourceRel?: string[]; // source under the company root (default: the legacy direct child)
}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-versioned-link-"));
  try {
    const skillsRoot = path.join(home, "skills", COMPANY);
    const source = path.join(skillsRoot, ...(opts.sourceRel ?? ["paperclip"]));
    const target = path.join(home, ".hermes", "skills", "paperclip");
    await fs.mkdir(source, { recursive: true });
    await fs.mkdir(path.dirname(target), { recursive: true });
    let linked: string;
    if (opts.linkRel) {
      linked = path.join(opts.linkRoot ?? skillsRoot, ...opts.linkRel);
      await fs.mkdir(linked, { recursive: true });
      await fs.writeFile(path.join(linked, "SKILL.md"), "# Paperclip\n", "utf8");
      await fs.symlink(linked, target);
    } else {
      linked = target;
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, "SKILL.md"), "# Other\n", "utf8");
    }
    const config = {
      env: { HOME: home },
      paperclipRuntimeSkills: [{
        key: "paperclipai/paperclip/paperclip",
        runtimeName: "paperclip",
        source,
        skillId: SKILL_ID,
        ...(opts.versionId ? { versionId: opts.versionId } : {}),
        ...(opts.currentVersionId ? { currentVersionId: opts.currentVersionId } : {}),
      }],
    };
    const adapter = createServerAdapter();
    const run = () => adapter.syncSkills?.({
      adapterType: "hermes_local",
      agentId: "11111111-1111-4111-8111-111111111111",
      companyId: COMPANY,
      config,
    }, []);
    const lines: string[] = [];
    const reconcile = (options: ReconcileHermesSkillsOptions = {}) =>
      reconcileHermesPaperclipSkills(config, [], { onLog: (line) => { lines.push(line); }, ...options });
    return { run, reconcile, lines, home, skillsRoot, source, target, linked };
  } catch (err) {
    await fs.rm(home, { recursive: true, force: true });
    throw err;
  }
}

async function expectNoTempLinks(home: string) {
  const tmpEntries = await fs.readdir(path.join(home, ".hermes", ".paperclip-skill-tmp")).catch(() => []);
  expect(tmpEntries).toEqual([]);
  expect(await fs.readdir(path.join(home, ".hermes", "skills"))).toEqual(["paperclip"]);
}

const v = (...rel: string[]) => ["__versions__", ...rel];

test("Hermes re-points a versioned cache link when the entry carries no version", async () => {
  const ctx = await syncWithLink({ linkRel: v(SKILL_ID, VERSION_ID) });
  const snapshot = await ctx.run();
  expect(snapshot?.desiredSkills).toContain("paperclipai/paperclip/paperclip");
  expect(await fs.readlink(ctx.target)).toBe(ctx.source);
});

test("Hermes accepts a versioned cache link whose basename matches the entry versionId", async () => {
  const ctx = await syncWithLink({ linkRel: v(SKILL_ID, VERSION_ID), versionId: VERSION_ID });
  const snapshot = await ctx.run();
  expect(snapshot?.desiredSkills).toContain("paperclipai/paperclip/paperclip");
  expect(await fs.readlink(ctx.target)).toBe(ctx.linked);
});

test("Hermes re-points a link to another version of the same skill to the source", async () => {
  const ctx = await syncWithLink({ linkRel: v(SKILL_ID, VERSION_ID), versionId: OTHER_VERSION });
  const snapshot = await ctx.run();
  expect(snapshot?.desiredSkills).toContain("paperclipai/paperclip/paperclip");
  expect(await fs.readlink(ctx.target)).toBe(ctx.source);
  await expectNoTempLinks(ctx.home);
});

test("Hermes keeps a link at the current version when the run pins an older one, and warns", async () => {
  const ctx = await syncWithLink({ linkRel: v(SKILL_ID, VERSION_ID), versionId: OTHER_VERSION, currentVersionId: VERSION_ID });
  await ctx.reconcile();
  expect(await fs.readlink(ctx.target)).toBe(ctx.linked);
  expect(ctx.lines).toEqual([expect.stringContaining(`pinned ${OTHER_VERSION}, current ${ctx.linked} is linked; pins are best effort`)]);
});

test("Hermes re-points a __runtime__ link when the source is a version folder, and logs it", async () => {
  const ctx = await syncWithLink({ linkRel: ["__runtime__", "paperclip"], sourceRel: v(SKILL_ID, VERSION_ID) });
  await ctx.reconcile();
  expect(await fs.readlink(ctx.target)).toBe(ctx.source);
  expect(ctx.lines).toEqual([`Re-pointed skill "paperclipai/paperclip/paperclip" from ${ctx.linked} to ${ctx.source}.`]);
});

test("Hermes refuses a link to another skill id's version folder", async () => {
  const ctx = await syncWithLink({ linkRel: v("66666666-6666-4666-8666-666666666666", VERSION_ID), versionId: VERSION_ID });
  await expect(ctx.run()).rejects.toThrow(`Cannot reconcile Hermes skill "paperclipai/paperclip/paperclip" because ${ctx.target} is occupied by another installation.`);
  expect(await fs.readlink(ctx.target)).toBe(ctx.linked);
});

test.each(["readlink", "realpath"] as const)("Hermes refuses, never re-points, when %s throws", async (op) => {
  const ctx = await syncWithLink({ linkRel: v(SKILL_ID, VERSION_ID), versionId: OTHER_VERSION });
  const fsOps = { [op]: async () => { throw Object.assign(new Error("boom"), { code: "EIO" }); } };
  await expect(ctx.reconcile({ fs: fsOps })).rejects.toThrow("occupied by another installation");
  expect(await fs.readlink(ctx.target)).toBe(ctx.linked);
});

test("Hermes names both paths when the rename crosses filesystems", async () => {
  const ctx = await syncWithLink({ linkRel: v(SKILL_ID, VERSION_ID), versionId: OTHER_VERSION });
  const rename = async () => { throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); };
  await expect(ctx.reconcile({ fs: { rename } })).rejects.toThrow(
    new RegExp(`temporary link .*\\.paperclip-skill-tmp.* and ${ctx.target} are on different filesystems \\(EXDEV\\)`),
  );
  expect(await fs.readlink(ctx.target)).toBe(ctx.linked);
  await expectNoTempLinks(ctx.home);
});

async function moveLink(target: string, to: string) {
  const tmp = `${target}.hook`;
  await fs.symlink(to, tmp);
  await fs.rename(tmp, target);
}

test("Hermes carries on when another run re-links the skill right after the swap", async () => {
  const ctx = await syncWithLink({ linkRel: v(SKILL_ID, VERSION_ID), versionId: OTHER_VERSION });
  await ctx.reconcile({ afterRename: (target) => moveLink(target, ctx.linked) });
  expect(await fs.readlink(ctx.target)).toBe(ctx.linked);
  expect(ctx.lines.at(-1)).toContain(`another run linked ${ctx.linked} meanwhile; carrying on`);
});

test("Hermes redoes the swap once when the read-back target was removed, then fails", async () => {
  const ctx = await syncWithLink({ linkRel: v(SKILL_ID, VERSION_ID), versionId: OTHER_VERSION });
  const gone = path.join(ctx.skillsRoot, ...v(SKILL_ID, "removed"));
  let calls = 0;
  await ctx.reconcile({ afterRename: async (target) => { calls += 1; if (calls === 1) await moveLink(target, gone); } });
  expect(calls).toBe(2);
  expect(await fs.readlink(ctx.target)).toBe(ctx.source);

  await moveLink(ctx.target, ctx.linked);
  await expect(ctx.reconcile({ afterRename: (target) => moveLink(target, gone) })).rejects.toThrow("removed during the swap");
  await expectNoTempLinks(ctx.home);
});

test.each(["new", "dangling", "ours-stale"] as const)("two parallel reconciles both succeed on a %s link, and a reader never sees it missing", async (kind) => {
  const ctx = await syncWithLink({ linkRel: v(SKILL_ID, VERSION_ID), versionId: OTHER_VERSION });
  for (let loop = 0; loop < 20; loop += 1) {
    await fs.rm(ctx.target, { force: true });
    if (kind === "dangling") await fs.symlink(path.join(ctx.skillsRoot, ...v(SKILL_ID, "removed")), ctx.target);
    if (kind === "ours-stale") await fs.symlink(ctx.linked, ctx.target);
    let done = false;
    let seenValid = kind === "ours-stale";
    const reader = (async () => {
      while (!done) {
        try {
          await fs.lstat(ctx.target);
          const linked = await fs.readlink(ctx.target);
          await fs.stat(path.resolve(path.dirname(ctx.target), linked));
          seenValid = true;
        } catch (err) {
          if (seenValid) throw err;
        }
      }
    })();
    await Promise.all([ctx.reconcile(), ctx.reconcile()]).finally(() => { done = true; });
    await reader;
    expect(await fs.readlink(ctx.target)).toBe(ctx.source);
    expect((await fs.stat(ctx.target)).isDirectory()).toBe(true);
  }
  await expectNoTempLinks(ctx.home);
});

test("Hermes rejects a versioned cache link under a different company root", async () => {
  const ctx = await syncWithLink({
    linkRel: v(SKILL_ID, VERSION_ID),
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
