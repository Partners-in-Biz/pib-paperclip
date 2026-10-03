/**
 * What the host does to a plugin-managed skill, copied from its source
 * (server/src/services/plugin-managed-skills.ts: canonicalSkillKey,
 * withManagedSkillKey, buildDeclaredSkillFiles, managedSkillDefaultDrift).
 *
 * Why this exists. The first version of the eval harness decided "is the company's
 * copy what the plugin ships?" by comparing two strings, and its fake host handed
 * back the shipped text byte for byte. The real host never does: it injects a
 * `key: "plugin/<plugin>/<skill>"` line into the frontmatter when it stores the
 * skill, so the strings were never equal and every live `record` and `baseline`
 * refused. A fake that returns whatever the code under test expects cannot catch
 * that; this one stores what the host stores and answers with the host's own
 * `defaultDrift` verdict. Checked against the host source and against the live
 * company_skills rows (the key line sits at the end of the frontmatter).
 */
import type { PluginManagedSkillDeclaration } from "@paperclipai/plugin-sdk";
import { PLUGIN_KEY } from "../../src/constants.js";
import { SKILLS } from "../../src/skills.js";

const normalizeAgentUrlKey = (value: string): string | null => {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : null;
};

/** `plugin/partnersinbiz-cockpit/operator`. */
export function canonicalSkillKey(skillKey: string, pluginKey: string = PLUGIN_KEY): string {
  return `plugin/${normalizeAgentUrlKey(pluginKey) ?? "plugin"}/${skillKey}`;
}

/** Verbatim from the host: the stored SKILL.md is the declared one with the key line set. */
export function withManagedSkillKey(markdown: string, canonicalKey: string): string {
  const keyLine = `key: ${JSON.stringify(canonicalKey)}`;
  const normalized = markdown.replace(/\r\n/g, "\n");
  const frontmatter = /^---\n([\s\S]*?)\n---(\n?)/.exec(normalized);
  if (!frontmatter) return ["---", keyLine, "---", "", normalized].join("\n");
  const currentBody = frontmatter[1] ?? "";
  const nextBody = /^key\s*:/m.test(currentBody) ? currentBody.replace(/^key\s*:.*$/m, keyLine) : [currentBody, keyLine].filter(Boolean).join("\n");
  return `---\n${nextBody}\n---${frontmatter[2] ?? ""}${normalized.slice(frontmatter[0].length)}`;
}

/** The files the host would store for a declaration, by path inside the skill. */
export function declaredFiles(declaration: PluginManagedSkillDeclaration): Record<string, string> {
  const files: Record<string, string> = {};
  files["SKILL.md"] = declaration.markdown?.trim() ? withManagedSkillKey(declaration.markdown, canonicalSkillKey(declaration.skillKey)) : "";
  for (const file of declaration.files ?? []) files[file.path] = file.content;
  return files;
}

export function declarationOf(skillKey: string): PluginManagedSkillDeclaration {
  const found = SKILLS.find((s) => s.skillKey === skillKey);
  if (!found) throw new Error(`The Cockpit declares no skill ${skillKey}.`);
  return found;
}

/** What a company holds for a managed skill: the SKILL.md text and its other files. */
export interface InstalledCopy {
  skillId: string;
  /** The stored SKILL.md; null is a skill row without text. */
  markdown: string | null;
  /** Other files by path. Omitted: exactly the declared ones. */
  files?: Record<string, string>;
  /** Tests that model a host which does not report drift at all (an older server) set this false. */
  hostReportsDrift?: boolean;
}

/** The host's `managedSkillDefaultDrift`: the paths whose stored content differs from the declared one, or null. */
export function hostDefaultDrift(declaration: PluginManagedSkillDeclaration, installed: InstalledCopy): { changedFiles: string[] } | null {
  const declared = declaredFiles(declaration);
  const stored: Record<string, string | null> = { ...(installed.files ?? Object.fromEntries(Object.entries(declared).filter(([path]) => path !== "SKILL.md"))), "SKILL.md": installed.markdown };
  const paths = new Set([...Object.keys(declared), ...Object.keys(stored)]);
  const changed = [...paths].filter((path) => (stored[path] ?? null) !== (declared[path] ?? null)).sort((a, b) => a.localeCompare(b));
  return changed.length > 0 ? { changedFiles: changed } : null;
}

/** A company's copy as the host leaves it right after a sync (`reset` / `reconcile`): host-shaped text, nothing edited. */
export function installedLikeHost(skillKey: string, skillId = `skill-${skillKey}`): InstalledCopy {
  const declaration = declarationOf(skillKey);
  const files = declaredFiles(declaration);
  const { "SKILL.md": markdown, ...rest } = files;
  return { skillId, markdown: markdown ?? null, files: rest };
}
