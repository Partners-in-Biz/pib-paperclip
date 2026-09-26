/**
 * Browser helper used by plugin UIs before sending the user to an OAuth
 * provider. The provider redirects to the plugin's static callback page
 * (`/_plugins/<pluginId>/ui/oauth-callback.html`), which reads this entry to
 * know which company and completion route to use. No company id travels in
 * the callback URL.
 */
export interface PendingOAuth {
  companyId: string;
  /** Same-origin API route that finishes the connection (POST JSON). */
  completeUrl: string;
  /** Where to send the user if the completion route gives no redirect. */
  returnTo: string;
  label?: string;
  createdAt: number;
}

const PREFIX = "pib-oauth:";
const MAX_AGE_MS = 60 * 60 * 1000;

export function rememberOAuthStart(state: string, pending: Omit<PendingOAuth, "createdAt">): void {
  try {
    pruneOAuthStarts();
    window.localStorage.setItem(`${PREFIX}${state}`, JSON.stringify({ ...pending, createdAt: Date.now() }));
  } catch {
    // Storage blocked: the callback page will explain and send the user back.
  }
}

export function pruneOAuthStarts(): void {
  try {
    const now = Date.now();
    for (let i = window.localStorage.length - 1; i >= 0; i -= 1) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(PREFIX)) continue;
      const raw = window.localStorage.getItem(key);
      const createdAt = raw ? Number((JSON.parse(raw) as { createdAt?: number }).createdAt ?? 0) : 0;
      if (!createdAt || now - createdAt > MAX_AGE_MS) window.localStorage.removeItem(key);
    }
  } catch {
    // ignore
  }
}

export function readOAuthStart(state: string): PendingOAuth | null {
  try {
    const raw = window.localStorage.getItem(`${PREFIX}${state}`);
    return raw ? (JSON.parse(raw) as PendingOAuth) : null;
  } catch {
    return null;
  }
}

export function forgetOAuthStart(state: string): void {
  try {
    window.localStorage.removeItem(`${PREFIX}${state}`);
  } catch {
    // ignore
  }
}

/**
 * The host serves a plugin's UI files at `/_plugins/<installation uuid>/ui/`.
 * Only the uuid form works for static files (the key form 500s), and the
 * worker cannot learn its own uuid, so the page reports it. Pass
 * `import.meta.url` from the plugin's UI module.
 */
export function pluginUiBaseFromModule(moduleUrl: string): string | null {
  try {
    const path = new URL(moduleUrl).pathname;
    const match = /^\/_plugins\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/ui\//i.exec(path);
    return match ? `/_plugins/${match[1]!.toLowerCase()}/ui/` : null;
  } catch {
    return null;
  }
}

const uiBaseMemo = new Map<string, Promise<string | null>>();

/**
 * The plugin's `/_plugins/<installation uuid>/ui/` base, as seen from its page.
 * The host imports plugin bundles from blob: URLs, so `import.meta.url` usually
 * does not carry the uuid; this asks the host for the plugin record instead
 * (same-origin, board session). Memoised per page load.
 */
export function resolvePluginUiBase(pluginKey: string, moduleUrl?: string): Promise<string | null> {
  const fromModule = moduleUrl ? pluginUiBaseFromModule(moduleUrl) : null;
  if (fromModule) return Promise.resolve(fromModule);
  const cached = uiBaseMemo.get(pluginKey);
  if (cached) return cached;
  const run = (async () => {
    try {
      const res = await fetch(`/api/plugins/${encodeURIComponent(pluginKey)}`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { id?: unknown };
      const id = typeof data.id === "string" ? data.id.toLowerCase() : "";
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ? `/_plugins/${id}/ui/` : null;
    } catch {
      return null;
    }
  })();
  uiBaseMemo.set(pluginKey, run);
  run.then((value) => {
    if (!value) uiBaseMemo.delete(pluginKey);
  });
  return run;
}
