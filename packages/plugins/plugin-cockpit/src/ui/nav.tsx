/**
 * Sidebar groups drawn by the Cockpit: Clients (CRM, Mailbox, Partners),
 * Marketing (Social, SEO, Campaigns) and Finance (Billing, Accounting,
 * Payroll). Each member plugin hides its own row while its group is here.
 */
import { useEffect, useRef, useState } from "react";
import { useHostLocation, useHostNavigation, type PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { fetchModules } from "@partnersinbiz/pib-plugin-kit/setup-client";
import {
  NAV_GROUPS,
  NavCount,
  SidebarRowGroup,
  SidebarRowLink,
  isActivePath,
  memberIcon,
  readGroupOpen,
  useUiContributions,
  visibleMembers,
  tone,
  writeGroupOpen,
  type NavGroupKey,
} from "@partnersinbiz/pib-plugin-ui";
import type { CockpitView } from "../view.js";
import { useSidebarView } from "./data.js";

type Modules = Partial<Record<string, boolean>> | null;

/** The company's module switches; `undefined` while loading, `null` when Setup is not reachable. */
function useModules(companyId: string | null | undefined): Modules | undefined {
  const [modules, setModules] = useState<Modules | undefined>(undefined);
  useEffect(() => {
    if (!companyId) {
      setModules(null);
      return;
    }
    let live = true;
    fetchModules(companyId)
      .then((m) => {
        if (live) setModules(m);
      })
      .catch(() => {
        if (live) setModules(null);
      });
    return () => {
      live = false;
    };
  }, [companyId]);
  return modules;
}

export interface GroupAttention {
  /** Items waiting on the owner from the group's plugins. */
  total: number;
  /** Any of them is about money or legal. */
  urgent: boolean;
  /** Worst health among the group's plugins. */
  health: "ok" | "warn" | "bad";
  byPlugin: Record<string, { count: number; urgent: boolean }>;
}

/** What needs a person in a group: the Cockpit's waiting items and plugin health for these plugins only. */
export function groupAttention(view: Pick<CockpitView, "waiting" | "snapshots"> | null, pluginKeys: string[]): GroupAttention {
  const out: GroupAttention = { total: 0, urgent: false, health: "ok", byPlugin: {} };
  if (!view) return out;
  const keys = new Set(pluginKeys);
  for (const item of view.waiting) {
    if (!keys.has(item.source)) continue;
    const urgent = item.kind === "money" || item.kind === "legal";
    const entry = (out.byPlugin[item.source] ??= { count: 0, urgent: false });
    entry.count += 1;
    entry.urgent ||= urgent;
    out.total += 1;
    out.urgent ||= urgent;
  }
  for (const snapshot of view.snapshots) {
    if (!keys.has(snapshot.plugin)) continue;
    for (const check of snapshot.health) {
      if (check.status === "bad") out.health = "bad";
      else if (check.status === "warn" && out.health === "ok") out.health = "warn";
    }
  }
  return out;
}

/** Open state: remembered per browser; opens by itself when you land on one of its pages. */
export function nextOpenState(input: { stored: boolean | null; current: boolean | null; activeNow: boolean; activeBefore: boolean }): boolean {
  if (input.activeNow && !input.activeBefore) return true;
  if (input.current !== null) return input.current;
  if (input.stored !== null) return input.stored;
  return input.activeNow;
}

function NavGroupSidebar({ groupKey, companyId }: { groupKey: NavGroupKey; companyId: string | null | undefined }) {
  const navigation = useHostNavigation();
  const location = useHostLocation();
  const contributions = useUiContributions();
  const modules = useModules(companyId);
  const group = NAV_GROUPS[groupKey];
  const loading = contributions === undefined || modules === undefined;
  const members = loading ? [] : visibleMembers(group, contributions ?? null, modules ?? null);
  const active = members.map((m) => isActivePath(navigation.resolveHref(m.route), location.pathname));
  const anyActive = active.some(Boolean);
  const view = useSidebarView(companyId, location.pathname);
  const attention = groupAttention(view, members.map((m) => m.pluginKey));

  const [open, setOpen] = useState<boolean | null>(null);
  const wasActive = useRef(false);
  useEffect(() => {
    // Read the previous value now: the updater below runs later, after the ref has moved on.
    const activeBefore = wasActive.current;
    wasActive.current = anyActive;
    const stored = readGroupOpen(groupKey);
    setOpen((current) => nextOpenState({ stored, current, activeNow: anyActive, activeBefore }));
  }, [anyActive, groupKey]);

  if (loading || members.length === 0) return null;
  const countFor = (pluginKey: string) => {
    const entry = attention.byPlugin[pluginKey];
    return entry ? <NavCount count={entry.count} urgent={entry.urgent} /> : null;
  };
  if (members.length === 1) {
    const only = members[0]!;
    return <SidebarRowLink linkProps={navigation.linkProps(only.route) as unknown as Record<string, unknown>} label={only.label} icon={memberIcon(only)} active={active[0]!} trailing={countFor(only.pluginKey)} />;
  }
  const isOpen = open ?? anyActive;
  const waitingWords = attention.total ? `${attention.total} waiting on you${attention.urgent ? " (money or legal)" : ""}` : undefined;
  return (
    <SidebarRowGroup
      group={group}
      open={isOpen}
      active={anyActive}
      // The total shows on the closed group; when open, each page shows its own count.
      badge={isOpen ? null : <NavCount count={attention.total} urgent={attention.urgent} label={waitingWords} />}
      dot={attention.health === "bad" ? tone("bad").solid : null}
      description={[waitingWords, attention.health === "bad" ? "a problem needs attention" : null].filter(Boolean).join(", ") || undefined}
      onToggle={() => {
        const next = !isOpen;
        setOpen(next);
        writeGroupOpen(groupKey, next);
      }}
    >
      {members.map((m, i) => (
        <SidebarRowLink key={m.pluginKey} linkProps={navigation.linkProps(m.route) as unknown as Record<string, unknown>} label={m.label} icon={memberIcon(m)} active={active[i]!} nested trailing={countFor(m.pluginKey)} />
      ))}
    </SidebarRowGroup>
  );
}

export function ClientsNav({ context }: PluginSidebarProps) {
  return <NavGroupSidebar groupKey="clients" companyId={context.companyId} />;
}

export function MarketingNav({ context }: PluginSidebarProps) {
  return <NavGroupSidebar groupKey="marketing" companyId={context.companyId} />;
}

export function FinanceNav({ context }: PluginSidebarProps) {
  return <NavGroupSidebar groupKey="finance" companyId={context.companyId} />;
}
