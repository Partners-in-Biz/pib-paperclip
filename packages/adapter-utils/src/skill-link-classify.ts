import path from "node:path";
import type { PaperclipSkillEntry } from "./server-utils.js";

/**
 * Decide whether an adapter may repoint a profile's skill link.
 * - same: the link already serves this entry; leave it. atRequestedVersion is
 *   false when it sits at the entry's other known version (current vs pinned).
 * - ours-stale: the link points at another projection of this same skill in
 *   this company's managed root; it may be replaced.
 * - foreign: anything else; never touch it.
 *
 * Pure: the caller passes realpath results (null when readlink/realpath
 * threw). Unknown or underivable inputs fail closed to foreign.
 */
export type PaperclipSkillLinkClass =
  | { kind: "same"; atRequestedVersion: boolean }
  | { kind: "ours-stale" }
  | { kind: "foreign" };

export type PaperclipSkillLinkEntry = Pick<
  PaperclipSkillEntry,
  "key" | "runtimeName" | "versionId" | "currentVersionId" | "skillId"
>;

const MANAGED_MARKERS = new Set(["__versions__", "__runtime__", "__catalog__"]);
const RUNTIME_HASH_SUFFIX = /--[0-9a-f]{10}$/;
const FOREIGN: PaperclipSkillLinkClass = { kind: "foreign" };

function splitResolved(value: string) {
  return path.resolve(value).split(path.sep);
}

function isPath(parts: string[], expected: string[]) {
  return parts.length === expected.length && parts.every((part, index) => part === expected[index]);
}

function companyRootOf(source: string[]): { root: string[]; skillIdFromSource: string | null } | null {
  const markerIndex = source.findIndex((part) => MANAGED_MARKERS.has(part));
  if (markerIndex >= 0) {
    // The root must be a real folder (not the filesystem root) and the marker
    // must have something after it.
    if (markerIndex < 2 || markerIndex >= source.length - 1) return null;
    const isVersionSource = source[markerIndex] === "__versions__" && source.length === markerIndex + 3;
    return { root: source.slice(0, markerIndex), skillIdFromSource: isVersionSource ? source[markerIndex + 1] : null };
  }
  const name = source[source.length - 1];
  if (source.length < 3 || !name || name.startsWith("__")) return null;
  return { root: source.slice(0, -1), skillIdFromSource: null };
}

export function classifyPaperclipSkillLink(input: {
  resolvedTarget: string | null;
  resolvedSource: string | null;
  entry: PaperclipSkillLinkEntry;
}): PaperclipSkillLinkClass {
  const { resolvedTarget, resolvedSource, entry } = input;
  if (!resolvedTarget || !resolvedSource) return FOREIGN;
  if (!path.isAbsolute(resolvedTarget) || !path.isAbsolute(resolvedSource)) return FOREIGN;
  const runtimeName = entry.runtimeName?.trim();
  if (!runtimeName) return FOREIGN;
  const target = splitResolved(resolvedTarget);
  const source = splitResolved(resolvedSource);
  if (isPath(target, source)) return { kind: "same", atRequestedVersion: true };

  const company = companyRootOf(source);
  if (!company) return FOREIGN;
  const { root } = company;
  const skillId = entry.skillId?.trim() || company.skillIdFromSource;

  if (skillId) {
    for (const versionId of [entry.versionId, entry.currentVersionId]) {
      if (versionId && isPath(target, [...root, "__versions__", skillId, versionId])) {
        return { kind: "same", atRequestedVersion: Boolean(entry.versionId) && versionId === entry.versionId };
      }
    }
    // a. any other version of this skill
    if (target.length === root.length + 3 && isPath(target.slice(0, root.length + 2), [...root, "__versions__", skillId])) {
      return { kind: "ours-stale" };
    }
  }
  // b, c. this skill's runtime or catalog projection
  if (isPath(target, [...root, "__runtime__", runtimeName]) || isPath(target, [...root, "__catalog__", runtimeName])) {
    return { kind: "ours-stale" };
  }
  // d. the legacy direct-child projection, named by slug
  const slug = runtimeName.replace(RUNTIME_HASH_SUFFIX, "");
  if (slug && !slug.startsWith("__") && isPath(target, [...root, slug])) return { kind: "ours-stale" };
  // e. a bundled Paperclip skill inside an installed server release
  if (entry.key.startsWith("paperclipai/paperclip/")
    && isPath(target.slice(-4), ["@paperclipai", "server", "skills", runtimeName])) {
    return { kind: "ours-stale" };
  }
  return FOREIGN;
}
