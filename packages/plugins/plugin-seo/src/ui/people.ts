/**
 * Names for "decided by" on the Previews tab (PAR-14954), from the host's company user directory
 * (the same read the Studio and Payroll plugins use). No React here so tests can import it.
 */

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

const directories = new Map<string, Promise<Map<string, string>>>();

/** Read once per company per page load; a failed read gives an empty map (labels fall back to "a team member"). */
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
