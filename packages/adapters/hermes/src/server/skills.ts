import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import { classifyPaperclipSkillLink } from "@paperclipai/adapter-utils/skill-link-classify";
import {
  isPaperclipSkillSourceMissing,
  type PaperclipSkillEntry,
  readInstalledSkillTargets,
  readPaperclipRuntimeSkillEntries,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { fileURLToPath } from "node:url";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveHermesHome(config: Record<string, unknown>): string {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const configuredHome = asString(env.HOME);
  const hermesHome = asString(env.HERMES_HOME);
  return hermesHome ? path.resolve(hermesHome) : path.join(configuredHome ? path.resolve(configuredHome) : os.homedir(), ".hermes");
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  category?: string;
  metadata?: Record<string, unknown>;
}

function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const frontmatter: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val: unknown = line.slice(idx + 1).trim();
    // Strip quotes
    if (typeof val === "string" && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    frontmatter[key] = val;
  }
  return frontmatter as SkillFrontmatter;
}

async function scanHermesSkills(
  skillsHome: string,
): Promise<AdapterSkillEntry[]> {
  const entries: AdapterSkillEntry[] = [];

  try {
    const categories = await fs.readdir(skillsHome, { withFileTypes: true });
    for (const cat of categories) {
      if (!cat.isDirectory()) continue;
      const catPath = path.join(skillsHome, cat.name);

      // Check if the category directory itself has a SKILL.md (top-level skill)
      const topLevelSkillMd = path.join(catPath, "SKILL.md");
      if (await fs.stat(topLevelSkillMd).catch(() => null)) {
        entries.push(await buildSkillEntry(cat.name, topLevelSkillMd, cat.name));
      }

      // Scan for sub-skills
      const items = await fs.readdir(catPath, { withFileTypes: true }).catch(() => []);
      for (const item of items) {
        if (!item.isDirectory()) continue;
        const skillMd = path.join(catPath, item.name, "SKILL.md");
        if (await fs.stat(skillMd).catch(() => null)) {
          const key = item.name;
          entries.push(await buildSkillEntry(key, skillMd, `${cat.name}/${item.name}`));
        }
      }
    }
  } catch {
    // ~/.hermes/skills/ doesn't exist — no skills available
  }

  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

async function buildSkillEntry(
  key: string,
  skillMdPath: string,
  categoryPath: string,
): Promise<AdapterSkillEntry> {
  let description: string | null = null;
  try {
    const content = await fs.readFile(skillMdPath, "utf8");
    const fm = parseSkillFrontmatter(content);
    description = fm.description ?? null;
  } catch {
    // ignore
  }

  return {
    key,
    runtimeName: key,
    desired: true, // Hermes loads all available skills
    managed: false,
    state: "installed",
    origin: "user_installed",
    originLabel: "Hermes skill",
    locationLabel: `~/.hermes/skills/${categoryPath}`,
    readOnly: true, // Hermes manages its own skills — Paperclip can't toggle them
    sourcePath: skillMdPath,
    targetPath: null,
    detail: description,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function buildHermesSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const home = resolveHermesHome(config);
  const hermesSkillsHome = path.join(home, "skills");

  // 1. Scan Paperclip-managed skills (bundled with the adapter)
  const paperclipEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(config, paperclipEntries);
  const desiredSet = new Set(desiredSkills);
  const availableByKey = new Map(paperclipEntries.map((e) => [e.key, e]));

  // 2. Scan Hermes's own skills from ~/.hermes/skills/
  const hermesSkillEntries = await scanHermesSkills(hermesSkillsHome);
  const hermesKeys = new Set(hermesSkillEntries.map((e) => e.key));

  // 3. Merge: Paperclip skills first (ephemeral), then Hermes skills
  const entries: AdapterSkillEntry[] = [];
  const warnings: string[] = [];

  // Paperclip-managed skills
  for (const entry of paperclipEntries) {
    const desired = desiredSet.has(entry.key);
    entries.push({
      key: entry.key,
      runtimeName: entry.runtimeName,
      desired,
      managed: true,
      state: desired ? "configured" : "available",
      origin: "company_managed",
      originLabel: "Managed by Paperclip",
      readOnly: false,
      sourcePath: entry.source,
      targetPath: null,
      detail: desired
        ? "Will be available on the next run via Hermes skill loading."
        : null,
    });
  }

  // Hermes-installed skills (read-only, always loaded)
  for (const entry of hermesSkillEntries) {
    // Skip if Paperclip already manages a skill with the same key
    if (availableByKey.has(entry.key)) continue;
    entries.push(entry);
  }

  // Check for desired skills that don't exist
  for (const desiredSkill of desiredSkills) {
    if (availableByKey.has(desiredSkill) || hermesKeys.has(desiredSkill)) continue;
    warnings.push(
      `Desired skill "${desiredSkill}" is not available in Paperclip or Hermes skills.`,
    );
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
      sourcePath: null,
      targetPath: null,
      detail:
        "Cannot find this skill in Paperclip or ~/.hermes/skills/.",
    });
  }

  return {
    adapterType: "hermes_local",
    supported: true,
    mode: "persistent",
    desiredSkills,
    entries,
    warnings,
  };
}

export async function listHermesSkills(
  ctx: AdapterSkillContext,
): Promise<AdapterSkillSnapshot> {
  return buildHermesSkillSnapshot(ctx.config);
}

type SkillLinkFs = {
  readlink: (target: string) => Promise<string>;
  realpath: (target: string) => Promise<string>;
  rename: (from: string, to: string) => Promise<void>;
};

export interface ReconcileHermesSkillsOptions {
  /** One line per re-point or warning. The run passes its log; the sync route passes nothing. */
  onLog?: (line: string) => Promise<void> | void;
  /** Test seams: replace filesystem calls, or act right after the rename. */
  fs?: Partial<SkillLinkFs>;
  afterRename?: (target: string) => Promise<void> | void;
}

type SkillLinkState =
  | { kind: "missing" | "dangling" | "ours-stale" | "foreign"; linked: string | null }
  | { kind: "same"; atRequestedVersion: boolean; linked: string | null };

const FOREIGN_RENAME_CODES = new Set(["EISDIR", "ENOTDIR", "ENOTEMPTY", "EEXIST"]);

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

function occupiedError(entry: PaperclipSkillEntry, target: string): Error {
  return new Error(
    `Cannot reconcile Hermes skill "${entry.key}" because ${target} is occupied by another installation.`,
  );
}

async function inspectSkillLink(target: string, entry: PaperclipSkillEntry, ops: SkillLinkFs): Promise<SkillLinkState> {
  const stat = await fs.lstat(target).catch((err) => {
    if (errorCode(err) === "ENOENT") return null;
    throw err;
  });
  if (!stat) return { kind: "missing", linked: null };
  if (!stat.isSymbolicLink()) return { kind: "foreign", linked: null };
  const raw = await ops.readlink(target).catch(() => null);
  if (raw === null) return { kind: "foreign", linked: null };
  const linked = path.resolve(path.dirname(target), raw);
  // stat the value read, not the name: another run may swap the name in between.
  const dangling = await fs.stat(linked).then(() => false, (err) => errorCode(err) === "ENOENT");
  if (dangling) return { kind: "dangling", linked };
  const [resolvedTarget, resolvedSource] = await Promise.all([
    ops.realpath(linked).catch(() => null),
    ops.realpath(entry.source).catch(() => null),
  ]);
  return { ...classifyPaperclipSkillLink({ resolvedTarget, resolvedSource, entry }), linked };
}

/** Make the link under a unique temporary name beside skills/, then rename it over the name. */
async function swapSkillLink(entry: PaperclipSkillEntry, target: string, tmpDir: string, ops: SkillLinkFs) {
  await fs.mkdir(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, `${entry.runtimeName}.${process.pid}.${randomBytes(6).toString("hex")}`);
  try {
    await fs.symlink(entry.source, tmp);
    await ops.rename(tmp, target);
  } catch (err) {
    const code = errorCode(err);
    if (code && FOREIGN_RENAME_CODES.has(code)) throw occupiedError(entry, target);
    if (code === "EXDEV") {
      throw new Error(
        `Cannot link Hermes skill "${entry.key}": the temporary link ${tmp} and ${target} are on different filesystems (EXDEV).`,
      );
    }
    throw err;
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

async function linkSkillAtomically(
  entry: PaperclipSkillEntry,
  target: string,
  tmpDir: string,
  oldLinked: string | null,
  ops: SkillLinkFs,
  options: ReconcileHermesSkillsOptions,
) {
  for (let attempt = 1; ; attempt += 1) {
    await swapSkillLink(entry, target, tmpDir, ops);
    await options.afterRename?.(target);
    const after = await inspectSkillLink(target, entry, ops);
    if (after.kind === "missing" || after.kind === "dangling") {
      if (attempt < 2) continue;
      throw new Error(
        `Cannot reconcile Hermes skill "${entry.key}": ${target} points at ${after.linked ?? "nothing"}, which was removed during the swap.`,
      );
    }
    if (after.kind === "foreign") throw occupiedError(entry, target);
    if (oldLinked) await options.onLog?.(`Re-pointed skill "${entry.key}" from ${oldLinked} to ${entry.source}.`);
    if (after.linked !== path.resolve(entry.source)) {
      await options.onLog?.(`Skill "${entry.key}": another run linked ${after.linked} meanwhile; carrying on.`);
    }
    return;
  }
}

export async function reconcileHermesPaperclipSkills(
  config: Record<string, unknown>,
  requestedDesiredSkills?: string[],
  options: ReconcileHermesSkillsOptions = {},
): Promise<string[]> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = requestedDesiredSkills
    ? Array.from(new Set([
        ...resolveLegacyPaperclipDesiredSkillNames({}, availableEntries),
        ...requestedDesiredSkills,
      ]))
    : resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
  const desiredSet = new Set(desiredSkills);
  const skillsHome = path.join(resolveHermesHome(config), "skills");
  await fs.mkdir(skillsHome, { recursive: true });
  const installed = await readInstalledSkillTargets(skillsHome);
  const availableByRuntimeName = new Map(availableEntries.map((entry) => [entry.runtimeName, entry]));
  // Beside the real parent of skills/, so the rename stays on one filesystem.
  const tmpDir = path.join(path.dirname(await fs.realpath(skillsHome)), ".paperclip-skill-tmp");
  const ops: SkillLinkFs = {
    readlink: (target) => fs.readlink(target),
    realpath: (target) => fs.realpath(target),
    rename: (from, to) => fs.rename(from, to),
    ...options.fs,
  };

  for (const entry of availableEntries) {
    if (!desiredSet.has(entry.key) || isPaperclipSkillSourceMissing(entry)) continue;
    const target = path.join(skillsHome, entry.runtimeName);
    const state = await inspectSkillLink(target, entry, ops);
    if (state.kind === "foreign") throw occupiedError(entry, target);
    if (state.kind === "same") {
      if (!state.atRequestedVersion && entry.versionId) {
        await options.onLog?.(
          `Warning: skill "${entry.key}" pinned ${entry.versionId}, current ${state.linked} is linked; pins are best effort on a shared profile.`,
        );
      }
      continue;
    }
    await linkSkillAtomically(entry, target, tmpDir, state.linked, ops, options);
  }

  for (const [name, installedEntry] of installed.entries()) {
    const available = availableByRuntimeName.get(name);
    if (!available || desiredSet.has(available.key)) continue;
    if (installedEntry.targetPath !== available.source) continue;
    await fs.unlink(path.join(skillsHome, name)).catch(() => {});
  }

  return desiredSkills;
}

export async function syncHermesSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  await reconcileHermesPaperclipSkills(ctx.config, desiredSkills);
  return buildHermesSkillSnapshot(ctx.config);
}

export function resolveHermesDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; runtimeName?: string | null }>,
): string[] {
  return resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
}
