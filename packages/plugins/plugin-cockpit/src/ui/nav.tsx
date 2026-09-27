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
  SidebarRowGroup,
  SidebarRowLink,
  isActivePath,
  memberIcon,
  readGroupOpen,
  useUiContributions,
  visibleMembers,
  writeGroupOpen,
  type NavGroupKey,
} from "@partnersinbiz/pib-plugin-ui";

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
  if (members.length === 1) {
    const only = members[0]!;
    return <SidebarRowLink linkProps={navigation.linkProps(only.route) as unknown as Record<string, unknown>} label={only.label} icon={memberIcon(only)} active={active[0]!} />;
  }
  const isOpen = open ?? anyActive;
  return (
    <SidebarRowGroup
      group={group}
      open={isOpen}
      active={anyActive}
      onToggle={() => {
        const next = !isOpen;
        setOpen(next);
        writeGroupOpen(groupKey, next);
      }}
    >
      {members.map((m, i) => (
        <SidebarRowLink key={m.pluginKey} linkProps={navigation.linkProps(m.route) as unknown as Record<string, unknown>} label={m.label} icon={memberIcon(m)} active={active[i]!} nested />
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
