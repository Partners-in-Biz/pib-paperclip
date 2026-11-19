/**
 * The whole-plugin page gate (access stage A, spec PAR-12578 section 4.6), built like `useModuleState`.
 * The plugin passes its `access.me` action in (this package has no sdk dependency), usually
 * `usePluginAction("access.me")`. The page gate only shapes the screen; the worker's guard is the gate.
 * So it fails open: an error, a timeout or an answer it cannot read keeps the page open, in every mode.
 * Two answers close it: `open: false`, and a 403 from core (a viewer member never reaches `access.me`).
 */
import { useEffect, useState, type ReactNode } from "react";
import { Lock } from "lucide-react";
import { breakAnywhere, font, oneColumn, usePibBaseStyles } from "./base.js";
import { IconBadge } from "./icons.js";
import { tokens } from "./tokens.js";
import { isRefusal } from "./refusal.js";

export type AccessState = "open" | "closed";
/** The plugin's `access.me` action; called with `{ companyId }`. `usePluginAction("access.me")` fits as is. */
export type AccessLoader = (params: { companyId: string | null | undefined }) => Promise<unknown>;

/** How long the page waits for `access.me` before it stays open. */
export const ACCESS_TIMEOUT_MS = 8000;

/**
 * Messages core sends with its 403 on a plugin action (`server/src/routes/authz.ts`, `assertCompanyAccess`).
 * The bridge hands the page `{ code: "UNKNOWN", message }` without the status, so the message is all there is.
 * `tests/access.spec.tsx` checks each one still appears in that file.
 */
export const CORE_FORBIDDEN_MESSAGES = [
  "Viewer access is read-only",
  "User does not have active company access",
  "User does not have access to this company",
] as const;

/** True for core's 403: a numeric status of 403 (a raw fetch or API error) or one of core's 403 messages. */
export function isAccessForbidden(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { status?: unknown; statusCode?: unknown; message?: unknown };
  if (e.status === 403 || e.statusCode === 403) return true;
  return typeof e.message === "string" && (CORE_FORBIDDEN_MESSAGES as readonly string[]).includes(e.message);
}

/** Reads an `access.me` answer: closed only for `open: false` or a refusal answer; anything else is open. */
export function accessStateOf(answer: unknown): AccessState {
  if (isRefusal(answer)) return "closed";
  if (answer && typeof answer === "object" && (answer as { open?: unknown }).open === false) return "closed";
  return "open";
}

/** One check, never rejects: the answer's state, `closed` on a 403, `open` on any other error or after the timeout. */
export function checkAccess(load: AccessLoader, companyId: string | null | undefined, timeoutMs: number = ACCESS_TIMEOUT_MS): Promise<AccessState> {
  return new Promise<AccessState>((resolve) => {
    const timer = setTimeout(() => resolve("open"), timeoutMs);
    const settle = (state: AccessState) => {
      clearTimeout(timer);
      resolve(state);
    };
    let call: Promise<unknown>;
    try {
      call = Promise.resolve(load({ companyId }));
    } catch (error) {
      call = Promise.reject(error);
    }
    call.then(
      (answer) => settle(accessStateOf(answer)),
      (error: unknown) => settle(isAccessForbidden(error) ? "closed" : "open"),
    );
  });
}

/**
 * Null while loading, then `open` or `closed`. Pass a stable loader (`usePluginAction` already is one);
 * a new function on every render starts a new check every render.
 */
export function useAccess(load: AccessLoader, companyId: string | null | undefined, options: { timeoutMs?: number } = {}): AccessState | null {
  const timeoutMs = options.timeoutMs ?? ACCESS_TIMEOUT_MS;
  const [state, setState] = useState<AccessState | null>(null);
  useEffect(() => {
    let live = true;
    setState(null);
    void checkAccess(load, companyId, timeoutMs).then((value) => {
      if (live) setState(value);
    });
    return () => {
      live = false;
    };
  }, [load, companyId, timeoutMs]);
  return state;
}

/** What the "no access" page says. Exported so tests and docs read the same words. */
export const NO_ACCESS_TEXT = {
  title: "You do not have access to this module",
  body: "Your access in this company does not include this module. An owner or admin can open it for you in Setup, under People.",
} as const;

/** The page a closed plugin shows instead of its own. It names no record and offers no link a limited person cannot use. */
export function NoAccess({ moduleName, action }: { moduleName?: string; action?: ReactNode }) {
  usePibBaseStyles();
  const title = moduleName ? `You do not have access to ${moduleName}` : NO_ACCESS_TEXT.title;
  return (
    <main className="pib-ui" data-access-state="closed" style={{ fontFamily: font, color: tokens.fg, width: "100%", minWidth: 0, display: "grid", gridTemplateColumns: oneColumn, padding: "24px 0" }}>
      <section
        role="status"
        aria-live="polite"
        style={{
          display: "grid",
          gridTemplateColumns: oneColumn,
          gap: 12,
          justifyItems: "center",
          textAlign: "center",
          width: "100%",
          maxWidth: 520,
          justifySelf: "center",
          boxSizing: "border-box",
          padding: "40px 20px",
          borderRadius: 14,
          border: `1px solid ${tokens.border}`,
          background: tokens.card,
        }}
      >
        <IconBadge icon={Lock} tone="neutral" size="lg" />
        <h1 style={{ margin: 0, fontSize: 17, fontWeight: 600, lineHeight: 1.35, ...breakAnywhere }}>{title}</h1>
        <p style={{ margin: 0, fontSize: 13, color: tokens.muted, lineHeight: 1.5, maxWidth: 400, ...breakAnywhere }}>{NO_ACCESS_TEXT.body}</p>
        {action}
      </section>
    </main>
  );
}

/**
 * Shows `children` when open. While loading: nothing (a sidebar entry must not flash). When closed: the
 * `NoAccess` page for `kind: "page"`, nothing for a sidebar entry or a widget.
 */
export function AccessGate({ state, kind, moduleName, children }: { state: AccessState | null; kind: "page" | "sidebar" | "widget"; moduleName?: string; children: ReactNode }) {
  if (state === null) return null;
  if (state === "closed") return kind === "page" ? <NoAccess moduleName={moduleName} /> : null;
  return <>{children}</>;
}
