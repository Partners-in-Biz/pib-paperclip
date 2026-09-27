/**
 * Grouped sidebar navigation for the PiB plugins.
 *
 * Every plugin page adds one sidebar row, which made the sidebar long. The
 * Cockpit draws three collapsible groups instead (Clients, Marketing,
 * Finance). Each member plugin keeps its own sidebar slot as a fallback but
 * hides it while the Cockpit's group for it is installed, so the sidebar is
 * never missing a page. Groups list only installed plugins whose module the
 * company switched on, open by themselves on their pages, and remember
 * whether you opened or closed them.
 *
 * The host only styles class names it uses itself, so rows reuse the host's
 * sidebar link classes and add inline styles for anything new.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Briefcase, ChevronRight, Landmark, Megaphone } from "lucide-react";
import { MODULE_ICONS } from "./icons.js";
import { tone, type ModuleKey } from "./tokens.js";

export type NavGroupKey = "clients" | "marketing" | "finance";

export interface NavMember {
  module: ModuleKey;
  pluginKey: string;
  label: string;
  /** Plugin page route (no company prefix), e.g. `/billing`. */
  route: string;
}

export interface NavGroup {
  key: NavGroupKey;
  label: string;
  icon: LucideIcon;
  /** The Cockpit sidebar slot that draws this group. */
  slotId: string;
  members: NavMember[];
}

export const NAV_GROUP_PLUGIN = "partnersinbiz.cockpit";

export const NAV_GROUPS: Record<NavGroupKey, NavGroup> = {
  clients: {
    key: "clients",
    label: "Clients",
    icon: Briefcase,
    slotId: "pib-nav-clients",
    members: [
      { module: "crm", pluginKey: "partnersinbiz.crm", label: "CRM", route: "/crm" },
      { module: "mailbox", pluginKey: "partnersinbiz.mailbox", label: "Mailbox", route: "/mailbox" },
      { module: "partners", pluginKey: "partnersinbiz.partners", label: "Partners", route: "/partners" },
    ],
  },
  marketing: {
    key: "marketing",
    label: "Marketing",
    icon: Megaphone,
    slotId: "pib-nav-marketing",
    members: [
      { module: "social", pluginKey: "partnersinbiz.social", label: "Social", route: "/social" },
      { module: "seo", pluginKey: "partnersinbiz.seo", label: "SEO", route: "/seo" },
      { module: "campaigns", pluginKey: "partnersinbiz.campaigns", label: "Campaigns", route: "/campaigns" },
    ],
  },
  finance: {
    key: "finance",
    label: "Finance",
    icon: Landmark,
    slotId: "pib-nav-finance",
    members: [
      { module: "billing", pluginKey: "partnersinbiz.billing", label: "Billing", route: "/billing" },
      { module: "accounting", pluginKey: "partnersinbiz.accounting", label: "Accounting", route: "/accounting" },
      { module: "payroll", pluginKey: "partnersinbiz.payroll", label: "Payroll", route: "/payroll" },
    ],
  },
};

export const NAV_GROUP_KEYS = Object.keys(NAV_GROUPS) as NavGroupKey[];

/** The group a plugin's page belongs to, or null. */
export function navGroupOf(pluginKey: string): NavGroup | null {
  for (const key of NAV_GROUP_KEYS) if (NAV_GROUPS[key].members.some((m) => m.pluginKey === pluginKey)) return NAV_GROUPS[key];
  return null;
}

// ---------------------------------------------------------------------------
// Which plugins are ready (host `GET /api/plugins/ui-contributions`)
// ---------------------------------------------------------------------------

export interface UiContribution {
  pluginKey: string;
  slots?: Array<{ type?: string; id?: string; routePath?: string }>;
}

const CACHE_MS = 60_000;
type CacheEntry = { at: number; promise: Promise<UiContribution[] | null> };

/**
 * One shared request for every PiB plugin bundle on the page (each bundle has
 * its own copy of this module, so the cache lives on `window`).
 */
function cacheSlot(): { entry?: CacheEntry } {
  const g = (typeof window !== "undefined" ? window : globalThis) as unknown as Record<string, unknown>;
  const key = "__pibUiContributions";
  if (!g[key]) g[key] = {};
  return g[key] as { entry?: CacheEntry };
}

export function parseContributions(body: unknown): UiContribution[] | null {
  const list = Array.isArray(body) ? body : body && typeof body === "object" ? ((body as Record<string, unknown>).contributions ?? (body as Record<string, unknown>).data) : null;
  if (!Array.isArray(list)) return null;
  return list
    .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === "object" && typeof (c as Record<string, unknown>).pluginKey === "string")
    .map((c) => ({ pluginKey: String(c.pluginKey), slots: Array.isArray(c.slots) ? (c.slots as UiContribution["slots"]) : [] }));
}

export function fetchUiContributions(fetchImpl: typeof fetch = fetch): Promise<UiContribution[] | null> {
  const slot = cacheSlot();
  if (slot.entry && Date.now() - slot.entry.at < CACHE_MS) return slot.entry.promise;
  const promise = fetchImpl("/api/plugins/ui-contributions", { credentials: "include" })
    .then(async (res) => (res.ok ? parseContributions(await res.json()) : null))
    .catch(() => null);
  slot.entry = { at: Date.now(), promise };
  return promise;
}

/** `undefined` while loading, `null` when it could not be read. */
export function useUiContributions(): UiContribution[] | null | undefined {
  const [value, setValue] = useState<UiContribution[] | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void fetchUiContributions().then((v) => {
      if (live) setValue(v);
    });
    return () => {
      live = false;
    };
  }, []);
  return value;
}

/** True when the Cockpit draws the group this plugin belongs to. */
export function groupedNavPresent(contributions: UiContribution[] | null | undefined, pluginKey: string): boolean {
  const group = navGroupOf(pluginKey);
  if (!group || !contributions) return false;
  return contributions.some((c) => c.pluginKey === NAV_GROUP_PLUGIN && (c.slots ?? []).some((s) => s.type === "sidebar" && s.id === group.slotId));
}

/**
 * For a member plugin's own sidebar row: `true` = the Cockpit group shows it
 * (hide your row), `false` = show your row, `null` = still checking (hide,
 * to avoid a flash).
 */
export function useGroupedNav(pluginKey: string): boolean | null {
  const contributions = useUiContributions();
  if (contributions === undefined) return null;
  return groupedNavPresent(contributions, pluginKey);
}

/** Members of a group that are installed (have a page) and switched on for the company. */
export function visibleMembers(group: NavGroup, contributions: UiContribution[] | null, modules: Partial<Record<string, boolean>> | null): NavMember[] {
  return group.members.filter((m) => {
    const installed = contributions === null ? true : contributions.some((c) => c.pluginKey === m.pluginKey && (c.slots ?? []).some((s) => s.type === "page"));
    return installed && modules?.[m.module] !== false;
  });
}

// ---------------------------------------------------------------------------
// Open / closed (per browser)
// ---------------------------------------------------------------------------

const OPEN_KEY = (group: NavGroupKey) => `pib-nav-open:${group}`;

export function readGroupOpen(group: NavGroupKey): boolean | null {
  try {
    const value = window.localStorage.getItem(OPEN_KEY(group));
    return value === "1" ? true : value === "0" ? false : null;
  } catch {
    return null;
  }
}

export function writeGroupOpen(group: NavGroupKey, open: boolean): void {
  try {
    window.localStorage.setItem(OPEN_KEY(group), open ? "1" : "0");
  } catch {
    // Private windows or blocked storage: the group still works, it just forgets.
  }
}

/** True when `pathname` is the page at `href` (query string ignored) or below it. */
export function isActivePath(href: string, pathname: string = typeof window !== "undefined" ? window.location.pathname : ""): boolean {
  const base = href.split("?")[0]!.replace(/\/+$/, "");
  const path = pathname.replace(/\/+$/, "");
  return Boolean(base) && (path === base || path.startsWith(`${base}/`));
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const ROW = "flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 text-(length:--text-compact) font-medium transition-colors";
const ROW_ACTIVE = "bg-sidebar-accent text-sidebar-accent-foreground";
const ROW_IDLE = "text-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground";

export interface SidebarRowLinkProps {
  /** From the host: `useHostNavigation().linkProps(route)`. */
  linkProps: Record<string, unknown>;
  label: string;
  icon: LucideIcon;
  active: boolean;
  /** Nested under a group. */
  nested?: boolean;
  trailing?: ReactNode;
}

export function SidebarRowLink({ linkProps, label, icon: Glyph, active, nested, trailing }: SidebarRowLinkProps) {
  return (
    <a
      {...linkProps}
      aria-current={active ? "page" : undefined}
      className={`${ROW} ${active ? ROW_ACTIVE : ROW_IDLE}`}
      style={{ textDecoration: "none", ...(nested ? { marginLeft: 22 } : {}) }}
    >
      <Glyph aria-hidden="true" size={16} strokeWidth={1.9} style={{ flexShrink: 0 }} />
      <span className="flex-1 truncate">{label}</span>
      {trailing}
    </a>
  );
}

/** A small count pill for a sidebar row: red when money or legal items wait, amber otherwise. */
export function NavCount({ count, urgent, label }: { count: number; urgent?: boolean; label?: string }) {
  if (!count) return null;
  const t = tone(urgent ? "bad" : "warn");
  return (
    <span
      aria-label={label ?? `${count} waiting on you`}
      title={label ?? `${count} waiting on you`}
      style={{ minWidth: 18, height: 18, padding: "0 5px", borderRadius: 999, fontSize: 11, fontWeight: 650, display: "inline-grid", placeItems: "center", background: t.soft, color: t.fg, flexShrink: 0 }}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

export interface SidebarRowGroupProps {
  group: NavGroup;
  open: boolean;
  /** A page inside the group is open (the row is highlighted while closed). */
  active: boolean;
  onToggle: () => void;
  /** Shown on the group row (e.g. a NavCount), before the chevron. */
  badge?: ReactNode;
  /** A colour for a small status dot on the group icon (e.g. a failing job in one of its plugins). */
  dot?: string | null;
  /** Extra words for screen readers, e.g. "2 waiting on you". */
  description?: string;
  children: ReactNode;
}

export function SidebarRowGroup({ group, open, active, onToggle, badge, dot, description, children }: SidebarRowGroupProps) {
  const Glyph = group.icon;
  const listId = `pib-nav-${group.key}-items`;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={listId}
        aria-label={description ? `${group.label}, ${description}` : undefined}
        className={`${ROW} ${active && !open ? ROW_ACTIVE : ROW_IDLE}`}
        style={{ background: active && !open ? undefined : "transparent", border: 0, cursor: "pointer", textAlign: "left", font: "inherit", width: "calc(100% - 16px)" }}
      >
        <span aria-hidden="true" style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
          <Glyph size={16} strokeWidth={1.9} />
          {dot ? <span style={{ position: "absolute", top: -2, right: -2, width: 7, height: 7, borderRadius: 999, background: dot }} /> : null}
        </span>
        <span className="flex-1 truncate">{group.label}</span>
        {badge}
        <ChevronRight
          aria-hidden="true"
          size={14}
          strokeWidth={2}
          style={{ flexShrink: 0, opacity: 0.6, transition: "transform 150ms ease", transform: open ? "rotate(90deg)" : "none" }}
        />
      </button>
      <div id={listId} role="group" aria-label={group.label} hidden={!open} style={{ display: open ? "flex" : "none", flexDirection: "column", gap: 2 }}>
        {children}
      </div>
    </div>
  );
}

/** Module icon for a member row. */
export function memberIcon(member: NavMember): LucideIcon {
  return MODULE_ICONS[member.module];
}
