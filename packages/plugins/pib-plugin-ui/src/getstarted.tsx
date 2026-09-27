/**
 * "Get started": the first thing a module's overview shows while its setup
 * is not finished. It reads the plugin's own setup checklist (the same one
 * the Setup page shows, from `GET /api/plugins/<key>/api/setup-status`) and
 * lists what is still missing, required items first, each with a direct
 * link, the exact steps and what the agent does once it is done. When
 * everything required is done it disappears, so pages are not a wall of
 * empty charts on day one and are clean afterwards.
 */
import { useEffect, useState, type CSSProperties } from "react";
import { ArrowRight, ChevronDown, CircleCheck, ListChecks } from "lucide-react";
import { useIsNarrow } from "./base.js";
import { ProgressBar } from "./charts.js";
import { Pill, SectionCard } from "./display.js";
import { tokens, tone } from "./tokens.js";
import { InlineText } from "./richtext.js";

export type GetStartedItemStatus = "done" | "missing" | "optional" | "blocked" | "unknown";

export interface GetStartedItem {
  key: string;
  title: string;
  status: GetStartedItemStatus;
  required: boolean;
  detail?: string;
  href?: string | null;
  hrefLabel?: string | null;
  steps?: string[];
  agentNext?: string | null;
}

export interface GetStartedStatus {
  plugin: string;
  title?: string;
  items: GetStartedItem[];
}

const STATUSES: GetStartedItemStatus[] = ["done", "missing", "optional", "blocked", "unknown"];

/** A setup status from the plugin's route body (plain or wrapped in `{ data }`), or null. */
export function parseGetStarted(body: unknown, pluginKey: string): GetStartedStatus | null {
  let root = body;
  if (root && typeof root === "object" && !Array.isArray((root as { items?: unknown }).items)) root = (root as { data?: unknown }).data ?? root;
  if (!root || typeof root !== "object" || !Array.isArray((root as { items?: unknown }).items)) return null;
  const items = ((root as { items: unknown[] }).items)
    .filter((i): i is Record<string, unknown> => Boolean(i) && typeof i === "object" && typeof (i as Record<string, unknown>).key === "string" && typeof (i as Record<string, unknown>).title === "string")
    .map((i) => ({
      key: String(i.key),
      title: String(i.title),
      status: (STATUSES.includes(i.status as GetStartedItemStatus) ? i.status : "unknown") as GetStartedItemStatus,
      required: i.required === true,
      detail: typeof i.detail === "string" ? i.detail : undefined,
      href: typeof i.href === "string" ? i.href : null,
      hrefLabel: typeof i.hrefLabel === "string" ? i.hrefLabel : null,
      steps: Array.isArray(i.steps) ? i.steps.filter((s): s is string => typeof s === "string") : undefined,
      agentNext: typeof i.agentNext === "string" ? i.agentNext : null,
    }));
  const title = typeof (root as { title?: unknown }).title === "string" ? String((root as { title: string }).title) : undefined;
  return { plugin: pluginKey, title, items };
}

/** What still needs doing: required items that are not done, then (only if nothing required is left) nothing. */
export function missingRequired(status: GetStartedStatus | null): GetStartedItem[] {
  return (status?.items ?? []).filter((i) => i.required && i.status !== "done");
}

type StatusEntry = { at: number; promise: Promise<GetStartedStatus | null> };

/** Shared across every PiB plugin bundle on the page: one request per plugin and company every 30 seconds. */
function statusCache(): Map<string, StatusEntry> {
  const scope = globalThis as { __pibSetupStatusCache?: Map<string, StatusEntry> };
  if (!scope.__pibSetupStatusCache) scope.__pibSetupStatusCache = new Map();
  return scope.__pibSetupStatusCache;
}

/** A module's setup checklist, shared by every caller on the page (`fresh` skips the cache). */
export function fetchPluginSetupStatus(pluginKey: string, companyId: string, fresh = false): Promise<GetStartedStatus | null> {
  const key = `${pluginKey}|${companyId}`;
  const cache = statusCache();
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < 30_000) return hit.promise;
  const promise = fetch(`/api/plugins/${encodeURIComponent(pluginKey)}/api/setup-status?companyId=${encodeURIComponent(companyId)}`, { credentials: "include" })
    .then(async (res) => (res.ok ? parseGetStarted(await res.json(), pluginKey) : null))
    .catch(() => null);
  cache.set(key, { at: Date.now(), promise });
  return promise;
}

/** The module's own setup checklist; `undefined` while loading, `null` when it cannot be read. */
export function usePluginSetupStatus(pluginKey: string, companyId: string | null | undefined, refreshKey = 0): GetStartedStatus | null | undefined {
  const [status, setStatus] = useState<GetStartedStatus | null | undefined>(undefined);
  useEffect(() => {
    if (!companyId) {
      setStatus(null);
      return;
    }
    let live = true;
    fetchPluginSetupStatus(pluginKey, companyId, refreshKey > 0)
      .then((next) => {
        if (live) setStatus(next);
      });
    return () => {
      live = false;
    };
  }, [pluginKey, companyId, refreshKey]);
  return status;
}

const linkStyle: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, height: 30, padding: "0 12px", borderRadius: 8, fontSize: 12.5, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" };

/**
 * The card. `linkFor` turns a Paperclip path into anchor props (the host's
 * `useHostNavigation().linkProps`). Renders nothing while loading, when the
 * checklist cannot be read, or when nothing required is missing.
 *
 * It starts as one line ("3 steps left · Continue") on a phone, and once the
 * module already has data (`hasData`), so the page's own content stays above
 * the fold; the full card opens on tap.
 */
export function GetStarted({ status, linkFor, moduleName, max = 3, hasData = false }: {
  status: GetStartedStatus | null | undefined;
  linkFor: (href: string) => Record<string, unknown>;
  /** e.g. "Mailbox"; defaults to the checklist's title. */
  moduleName?: string;
  /** How many open steps to show (the rest are one click away in Setup). */
  max?: number;
  /** The module already has real data: start collapsed to one line. */
  hasData?: boolean;
}) {
  const narrow = useIsNarrow();
  const [open, setOpen] = useState<boolean | null>(null);
  const missing = missingRequired(status ?? null);
  if (!status || missing.length === 0) return null;
  const required = status.items.filter((i) => i.required);
  const done = required.length - missing.length;
  const name = moduleName ?? status.title ?? "this module";
  const shown = missing.slice(0, max);
  const warn = tone("warn");
  const expanded = open ?? !(narrow || hasData);
  if (!expanded) {
    return (
      <div
        role="region"
        aria-label={`Finish setting up ${name}`}
        style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "10px 12px", borderRadius: 12, border: `1px solid ${warn.border}`, background: `linear-gradient(90deg, ${warn.soft}, transparent 80%), ${tokens.card}`, minWidth: 0 }}
      >
        <ListChecks size={16} aria-hidden="true" style={{ color: warn.fg, flexShrink: 0 }} />
        <span style={{ fontSize: 13, fontWeight: 600, flex: "1 1 160px", minWidth: 0 }}>
          Finish setting up {name}
          <span style={{ fontWeight: 500, color: tokens.muted }}> · {missing.length} {missing.length === 1 ? "step" : "steps"} left</span>
        </span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={false}
          style={{ ...linkStyle, border: `1px solid ${tokens.border}`, background: tokens.card, color: tokens.fg, cursor: "pointer", fontFamily: "inherit" }}
        >
          Continue <ChevronDown size={14} aria-hidden="true" />
        </button>
      </div>
    );
  }
  return (
    <SectionCard
      title={`Finish setting up ${name}`}
      subtitle={`${done} of ${required.length} required steps done. Until then its agent cannot do all of its work.`}
      icon={ListChecks}
      tone="warn"
      strip
      actions={
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {open ? <button type="button" onClick={() => setOpen(false)} style={{ ...linkStyle, border: "none", background: "transparent", color: tokens.muted, cursor: "pointer", fontFamily: "inherit" }}>Hide</button> : null}
          <a {...linkFor("/setup")} style={{ ...linkStyle, color: tokens.primary }}>All setup <ArrowRight size={14} aria-hidden="true" /></a>
        </span>
      }
    >
      <ProgressBar done={done} total={required.length} tone="warn" ariaLabel={`${done} of ${required.length} setup steps done`} />
      <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
        {shown.map((item, index) => (
          <li key={item.key} style={{ display: "grid", gap: 6, padding: 12, borderRadius: 10, border: `1px solid ${tokens.border}`, background: tokens.bg, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", minWidth: 0 }}>
              <span aria-hidden="true" style={{ width: 22, height: 22, borderRadius: 999, display: "inline-grid", placeItems: "center", fontSize: 12, fontWeight: 700, background: warn.soft, color: warn.fg, flexShrink: 0 }}>{done + index + 1}</span>
              <strong style={{ fontSize: 13.5, flex: "1 1 200px", minWidth: 0, overflowWrap: "anywhere" }}>{item.title}</strong>
              {item.status === "blocked" ? <Pill size="sm" tone="neutral">Waiting on an earlier step</Pill> : null}
              {item.href ? (
                <a {...linkFor(item.href)} style={{ ...linkStyle, background: tokens.primary, color: tokens.primaryFg }}>
                  {item.hrefLabel ?? "Open"} <ArrowRight size={14} aria-hidden="true" />
                </a>
              ) : null}
            </div>
            {item.detail ? <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted, lineHeight: 1.45, overflowWrap: "anywhere" }}><InlineText text={item.detail} linkFor={linkFor} /></p> : null}
            {item.steps?.length ? (
              <details>
                <summary style={{ cursor: "pointer", fontSize: 12.5, fontWeight: 600 }}>How</summary>
                <ol style={{ listStyle: "decimal", margin: "6px 0 0", paddingLeft: 20, display: "grid", gap: 3, fontSize: 12.5, lineHeight: 1.45 }}>
                  {item.steps.map((step, i) => <li key={i}><InlineText text={step} linkFor={linkFor} /></li>)}
                </ol>
              </details>
            ) : null}
            {item.agentNext ? (
              <p style={{ margin: 0, fontSize: 12, color: tokens.muted, display: "flex", gap: 6, alignItems: "flex-start", lineHeight: 1.45 }}>
                <CircleCheck size={13} aria-hidden="true" style={{ marginTop: 2, flexShrink: 0 }} /> Then: {item.agentNext}
              </p>
            ) : null}
          </li>
        ))}
      </ol>
      {missing.length > shown.length ? (
        <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted }}>
          {missing.length - shown.length} more {missing.length - shown.length === 1 ? "step" : "steps"} on the <a {...linkFor("/setup")} style={{ color: tokens.primary }}>Setup page</a>.
        </p>
      ) : null}
    </SectionCard>
  );
}
