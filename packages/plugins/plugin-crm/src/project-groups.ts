/**
 * Project grouping and hint helpers. No imports to keep this testable and safe for UI.
 */

export const CLIENT_PROJECT_KINDS = ["seo", "website", "app", "social", "ads", "campaigns", "book", "platform", "ops"] as const;
export type ClientProjectKind = (typeof CLIENT_PROJECT_KINDS)[number];

const PRIMARY_KINDS = ["website", "seo", "social"] as const;
const PRIMARY_LABELS: Record<(typeof PRIMARY_KINDS)[number], string> = {
  website: "Website",
  seo: "SEO",
  social: "Social",
};

export interface ProjectGroup<T = { projectId: string; name: string; kind?: string | null }> {
  kind: string | null;
  label: string;
  projects: T[];
}

/**
 * Groups projects by kind in order: Website, SEO, Social, other kinds in CLIENT_PROJECT_KINDS order,
 * unknown kinds, then "Not typed yet" for null kinds. Empty groups are omitted.
 * Stable order within each group (input order).
 */
export function groupProjectsByKind<T extends { kind?: string | null; projectId: string; name: string }>(
  projects: T[],
): ProjectGroup<T>[] {
  const groups = new Map<string | null, T[]>();

  for (const project of projects) {
    const kind = project.kind ?? null;
    if (!groups.has(kind)) {
      groups.set(kind, []);
    }
    groups.get(kind)!.push(project);
  }

  const result: ProjectGroup<T>[] = [];

  // Primary kinds in order
  for (const kind of PRIMARY_KINDS) {
    if (groups.has(kind)) {
      result.push({
        kind,
        label: PRIMARY_LABELS[kind],
        projects: groups.get(kind)!,
      });
    }
  }

  // Other known kinds
  for (const kind of CLIENT_PROJECT_KINDS) {
    if (!PRIMARY_KINDS.includes(kind as any) && groups.has(kind)) {
      result.push({
        kind,
        label: kind.charAt(0).toUpperCase() + kind.slice(1),
        projects: groups.get(kind)!,
      });
    }
  }

  // Unknown kinds (if any)
  for (const [kind, projs] of groups) {
    if (kind !== null && !CLIENT_PROJECT_KINDS.includes(kind as any)) {
      result.push({
        kind,
        label: kind.charAt(0).toUpperCase() + kind.slice(1),
        projects: projs,
      });
    }
  }

  // Not typed yet (null kind)
  if (groups.has(null)) {
    result.push({
      kind: null,
      label: "Not typed yet",
      projects: groups.get(null)!,
    });
  }

  return result;
}

/**
 * Returns hint strings for missing primary kinds. Omits kinds that are present,
 * and omits the hint line entirely if all three primary kinds are present or
 * there are no projects at all.
 */
export function missingKindHints<T extends { kind?: string | null }>(
  projects: T[],
): string[] {
  if (projects.length === 0) return [];

  const present = new Set(projects.map((p) => p.kind).filter((k) => k !== null && k !== undefined));

  const missing: string[] = [];
  for (const kind of PRIMARY_KINDS) {
    if (!present.has(kind)) {
      missing.push(kind);
    }
  }

  if (missing.length === 0) return [];

  const labels = missing.map((k) => PRIMARY_LABELS[k as (typeof PRIMARY_KINDS)[number]]);
  const noun = labels.length === 1 ? "project" : "projects";
  const joined = labels.length === 1 ? labels[0] : labels.length === 2 ? `${labels[0]} or ${labels[1]}` : `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
  return [`No ${joined} ${noun} linked yet.`];
}
