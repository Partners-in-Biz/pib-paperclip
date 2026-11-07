/**
 * Names for "Made by" (PAR-8120), from the host's company user directory. Shows the person's name, then email;
 * never the raw user id. No React here so tests can import it; the hook is in ./maker.ts.
 */
export type MadeBy = { agentId: string | null; userId: string | null } | null | undefined;

/** userId -> name (or email) from GET /api/companies/:id/user-directory. */
export function parseDirectory(body: unknown): Map<string, string> {
  const names = new Map<string, string>();
  const users = body && typeof body === "object" ? (body as { users?: unknown }).users : null;
  if (!Array.isArray(users)) return names;
  for (const entry of users) {
    const e = entry as { principalId?: unknown; user?: { id?: unknown; name?: unknown; email?: unknown } | null };
    const id = typeof e?.principalId === "string" ? e.principalId : typeof e?.user?.id === "string" ? e.user.id : null;
    const name = typeof e?.user?.name === "string" && e.user.name.trim() ? e.user.name.trim() : typeof e?.user?.email === "string" ? e.user.email : null;
    if (id && name) names.set(id, name);
  }
  return names;
}

/** The "Made by" text. A person not in the directory (left the company, or the list didn't load) is "A person". */
export function makerLabel(made: MadeBy, names: Map<string, string>): string {
  if (made?.agentId) return `Agent ${made.agentId.slice(0, 8)}`;
  if (made?.userId) return names.get(made.userId) ?? "A person";
  return "Unknown";
}

const directories = new Map<string, Promise<Map<string, string>>>();

/** Read once per company per page load; a failed read gives an empty map (labels fall back to "A person"). */
export function loadDirectory(companyId: string): Promise<Map<string, string>> {
  let pending = directories.get(companyId);
  if (!pending) {
    pending = fetch(`/api/companies/${encodeURIComponent(companyId)}/user-directory`, { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then(parseDirectory)
      .catch(() => new Map<string, string>());
    directories.set(companyId, pending);
  }
  return pending;
}
