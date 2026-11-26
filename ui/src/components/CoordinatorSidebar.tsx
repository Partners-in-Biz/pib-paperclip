import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Inbox, Boxes, ChevronRight, CircleCheck, FolderOpen, History, LayoutDashboard, MessageCircle, MoreHorizontal, Network, Pin, PinOff, Plus, Repeat, Search, Settings, SquarePen, Unplug, type LucideIcon } from "lucide-react";
import type { Agent, Project } from "@paperclipai/shared";
import { useCoordinatorAttentionCount } from "@/hooks/useCoordinatorAttentionCount";
import { issuesApi } from "@/api/issues";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { projectsApi } from "@/api/projects";
import { useAgentChatNavigation } from "@/hooks/useAgentChatNavigation";
import { useRecentTasks } from "@/hooks/useRecentTasks";
import { usePinnedNavigation } from "@/hooks/usePinnedNavigation";
import { sidebarAppKey, useHiddenSidebarApps } from "@/hooks/useHiddenSidebarApps";
import { useDialogActions } from "@/context/DialogContext";
import { useCompany } from "@/context/CompanyContext";
import { useMemberRestriction } from "@/context/MemberRestrictionContext";
import { RESTRICTED_MEMBER_LANDING_PATH } from "@/lib/member-restriction";
import { PluginSlotMount, PluginSlotOutlet, usePluginSlots } from "@/plugins/slots";
import { PluginLauncherOutlet, usePluginLaunchers } from "@/plugins/launchers";
import { useSidebar } from "@/context/SidebarContext";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useLocation } from "@/lib/router";
import { agentRouteRef, cn, projectRouteRef, SIDEBAR_RAIL_HIDDEN_LABEL } from "@/lib/utils";
import { SidebarCompanyMenu } from "./SidebarCompanyMenu";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarNotesDropdown } from "./SidebarNotesDropdown";
import { SidebarSection } from "./SidebarSection";
import { TruncatedTextMarqueeProvider } from "./TruncatedText";
import { useScrollbarWhileScrolling } from "./side-panel/use-scrollbar-while-scrolling";
import { Flyout, FlyoutContent, FlyoutTrigger, FlyoutAppearanceProvider } from "./ui/flyout";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { StatusIcon } from "./StatusIcon";
import { taskStatusIconProps } from "@/lib/task-status-presentation";
import { AgentAvatar } from "./AgentAvatar";
import { agentChatPinKey } from "./AgentChatPin";
import { PinnedNavigationList, type PinnedNavigationItem } from "./PinnedNavigationList";

const moreDestinations = [
  { label: "Search", to: "/search", icon: Search },
  { label: "Dashboard", to: "/dashboard", icon: LayoutDashboard },
  { label: "Projects", to: "/projects", icon: FolderOpen },
  { label: "Routines", to: "/routines", icon: Repeat },
  { label: "Artifacts", to: "/artifacts", icon: Boxes },
  { label: "Agents", to: "/agents/all", icon: Network },
  { label: "Skills", to: "/skills", icon: Boxes },
  { label: "Connectors", to: "/apps", icon: Unplug },
  { label: "Audit", to: "/activity", icon: History },
  { label: "Settings", to: "/settings", icon: Settings },
] as const;

export function buildPinnedNavigationItems(pins: readonly string[], agents: readonly Agent[], destinations: readonly { to: string; label: string; icon: LucideIcon }[]): PinnedNavigationItem[] {
  const keys = new Set(pins);
  const items = new Map<string, PinnedNavigationItem>(destinations.map(item => [item.to, { key: item.to, to: item.to, label: item.label, icon: <item.icon className="size-4" /> }]));
  for (const agent of agents) {
    const key = agentChatPinKey(agent.companyId, agent.id);
    if (keys.has(key)) items.set(key, { key, to: `/chats/${encodeURIComponent(agentRouteRef(agent))}`, label: agent.name, icon: <AgentAvatar agent={agent} size={20} /> });
  }
  return pins.flatMap(key => {
    const item = items.get(key);
    return item ? [item] : [];
  });
}

function ProjectRecent({ project }: { project: Project }) {
  const [expanded, setExpanded] = useState(false);
  const { data: tasks, isPending, error } = useQuery({
    queryKey: [...queryKeys.issues.listByProject(project.companyId, project.id), "coordinator-recents"],
    queryFn: () => issuesApi.listCompact(project.companyId, { projection: "rows", projectId: project.id, limit: 12, sortField: "updated", sortDir: "desc" }),
    enabled: expanded,
  });
  return <div>
    <div className="group/coordinator-recent relative">
      <SidebarNavItem to={`/projects/${projectRouteRef(project)}`} label={project.name} icon={FolderOpen} className="design-sidebar-item pr-9" />
      <button type="button" aria-label={`${expanded ? "Collapse" : "Expand"} ${project.name}`} aria-expanded={expanded}
        className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setExpanded(!expanded)}>
        <ChevronRight className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
      </button>
    </div>
    {expanded && <div className="ml-5 border-l border-border pl-1">
      {isPending ? <p className="px-3 py-2 text-xs text-muted-foreground" role="status">Loading tasks…</p> : error ? <p className="px-3 py-2 text-xs text-muted-foreground">Couldn’t load tasks.</p> : tasks?.length ? tasks.map(task =>
        <SidebarNavItem className="design-sidebar-item" key={task.id} to={`/issues/${task.identifier ?? task.id}`} label={task.title} iconNode={<StatusIcon {...taskStatusIconProps(task)} />} />)
        : <p className="px-3 py-2 text-xs text-muted-foreground">No tasks yet.</p>}
    </div>}
  </div>;
}

/** Plugin pages (CRM, Studio, Cockpit…) — the Coordinator layout had no
 * outlet for them, so installed plugins vanished from navigation. Shown only
 * when at least one plugin contributes a sidebar link or launcher. */
function PluginNavigation({ companyId, rail, hidden }: { companyId: string | null; rail: boolean; hidden: ReadonlySet<string> }) {
  const { selectedCompany } = useCompany();
  const context = { companyId, companyPrefix: selectedCompany?.issuePrefix ?? null };
  const { slots } = usePluginSlots({ slotTypes: ["sidebar"], companyId });
  const { launchers } = usePluginLaunchers({ placementZones: ["sidebar"], companyId });
  const [open, setOpen] = useState(true);
  const visibleSlot = useCallback((slot: { pluginKey: string; id: string }) => !hidden.has(sidebarAppKey(slot)), [hidden]);
  const visibleCount = slots.filter(visibleSlot).length;
  if (rail || !companyId || (visibleCount === 0 && launchers.length === 0)) return null;
  return <div className="design-sidebar-apps"><SidebarSection label="Apps" collapsible={{ open, onOpenChange: setOpen }}>
    <PluginSlotOutlet slotTypes={["sidebar"]} context={context} className="flex flex-col gap-0.5" itemClassName="text-(length:--text-compact) font-medium" missingBehavior="placeholder" filter={visibleSlot} />
    <PluginLauncherOutlet placementZones={["sidebar"]} context={context} className="flex flex-col gap-0.5" itemClassName="text-(length:--text-compact) font-medium" />
  </SidebarSection></div>;
}

/** Every installed app in the More pop-out, each with a pin toggle. Rows whose
 * plugin renders nothing, and the group when none is left, are hidden by CSS
 * (`:empty`), so PluginSlotMount gets NO className: that keeps the mount div empty. */
function MoreApps({ companyId, hiddenApps, onNavigate }: { companyId: string | null; hiddenApps: ReturnType<typeof useHiddenSidebarApps>; onNavigate: () => void }) {
  const { selectedCompany } = useCompany();
  const context = useMemo(() => ({ companyId, companyPrefix: selectedCompany?.issuePrefix ?? null }), [companyId, selectedCompany?.issuePrefix]);
  const { slots } = usePluginSlots({ slotTypes: ["sidebar"], companyId });
  if (!companyId || slots.length === 0) return null;
  return <div className="design-sidebar-more-apps">
    <div role="separator" className="my-1 border-t border-border" />
    <p className="px-2 pt-1 pb-0.5 text-xs text-muted-foreground">Apps</p>
    {slots.map(slot => {
      const appKey = sidebarAppKey(slot);
      const visible = !hiddenApps.hidden.has(appKey);
      const PinIcon = visible ? PinOff : Pin;
      const label = `${visible ? "Unpin" : "Pin"} ${slot.displayName}`;
      return <div key={appKey} className="design-sidebar-more-app flex items-center gap-1">
        <div className="design-sidebar-more-app-mount min-w-0 flex-1" onClickCapture={event => { if ((event.target as Element).closest("a[href]")) onNavigate(); }}>
          <PluginSlotMount slot={slot} context={context} missingBehavior="hidden" />
        </div>
        <button type="button" aria-label={`${visible ? "Unpin" : "Pin"} ${slot.displayName} ${visible ? "from" : "to"} sidebar`} aria-pressed={visible} title={label} disabled={!hiddenApps.canToggle} onClick={() => hiddenApps.toggle(appKey)}
          className={cn("flex size-8 shrink-0 items-center justify-center rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50", visible ? "text-foreground" : "text-muted-foreground")}>
          <PinIcon className="size-3.5" />
        </button>
      </div>;
    })}
  </div>;
}

function RecentNavigationList({ children }: { children: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const handleScroll = useScrollbarWhileScrolling();
  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const measure = () => {
      viewport.dataset.overflowTop = String(viewport.scrollTop > 1);
      viewport.dataset.overflowBottom = String(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 1);
    };
    measure();
    viewport.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(viewport);
    if (contentRef.current) observer?.observe(contentRef.current);
    return () => { viewport.removeEventListener("scroll", measure); observer?.disconnect(); };
  }, []);
  return <div ref={scrollRef} className="design-sidebar-recent-list scrollbar-while-scrolling" onScroll={handleScroll} role="region" aria-label="Recents" tabIndex={0}>
    <div ref={contentRef} className="design-sidebar-recent-content">{children}</div>
  </div>;
}

/** The navigation is a view of the existing records; it never creates a chat
 * or task just because someone visits or switches agents. */
export function CoordinatorSidebar({ children }: { children?: ReactNode }) {
  const { companyId, userId, agents, chats, session } = useAgentChatNavigation();
  const unreadChatCount = chats.data?.filter(chat => chat.isUnreadForMe).length ?? 0;
  const pinnedNavigation = usePinnedNavigation(userId);
  const hiddenApps = useHiddenSidebarApps(userId);
  const { data: experimental } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  // PAR-12608 4.6: no "More" or pinned entry for a page closed to a restricted member.
  const { enforced: memberRestricted, isPageHidden } = useMemberRestriction();
  const destinations = useMemo(() => (experimental?.enableCases
    ? [...moreDestinations, { label: "Cases", to: "/cases", icon: Boxes }]
    : [...moreDestinations]).filter((item) => !isPageHidden(item.to)), [experimental?.enableCases, isPageHidden]);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreContentRef = useRef<HTMLDivElement>(null);
  const orderedPins = useMemo(() => buildPinnedNavigationItems(pinnedNavigation.pins, agents.data ?? [], destinations), [pinnedNavigation.pins, agents.data, destinations]);
  const { entries: recentTasks } = useRecentTasks({ companyId, userId });
  const { collapsed, peeking, isMobile, setSidebarOpen } = useSidebar();
  const rail = collapsed && !peeking;
  const { openNewIssue } = useDialogActions();
  const location = useLocation();
  const attentionCount = useCoordinatorAttentionCount(companyId);
  const { data: projects } = useQuery({ queryKey: queryKeys.projects.list(companyId!), queryFn: () => projectsApi.list(companyId!), enabled: !!companyId });
  // Only project IDs and visit times are kept in memory. Labels and task lists
  // always come from the authorized API, scoped to the current person/company.
  const scope = `${companyId}:${userId}`;
  const [projectVisits, setProjectVisits] = useState<{ scope: string; entries: Record<string, number> }>({ scope, entries: {} });
  useEffect(() => {
    const ref = location.pathname.match(/\/projects\/([^/]+)/)?.[1];
    const project = projects?.find(item => item.id === ref || projectRouteRef(item) === ref);
    if (!project) return;
    setProjectVisits(previous => ({ scope, entries: { ...(previous.scope === scope ? previous.entries : {}), [project.id]: Date.now() } }));
  }, [location.pathname, projects, scope]);
  const recents = useMemo(() => {
    const roster = new Map((agents.data ?? []).map(agent => [agent.id, agent]));
    const taskRows = recentTasks.map(task => ({ kind: "task" as const, id: task.id, time: task.recordedAt, task }));
    const chatRows = (chats.data ?? []).flatMap(chat => {
      const agent = chat.conversationAgentId ? roster.get(chat.conversationAgentId) : null;
      return agent ? [{ kind: "chat" as const, id: chat.id, time: new Date(chat.updatedAt).getTime(), agent }] : [];
    });
    const projectRows = (projects ?? []).flatMap(project => projectVisits.scope === scope && projectVisits.entries[project.id]
      ? [{ kind: "project" as const, id: project.id, time: projectVisits.entries[project.id]!, project }] : []);
    return [...taskRows, ...chatRows, ...projectRows].sort((a, b) => b.time - a.time);
  }, [agents.data, chats.data, recentTasks, projects, projectVisits, scope]);
  const newTaskButton = <Button type="button" variant="ghost" className="design-sidebar-new-task rounded-lg" aria-label="New task" onClick={() => openNewIssue()}>
    <SquarePen aria-hidden />
    <span className={rail ? SIDEBAR_RAIL_HIDDEN_LABEL : "truncate"}>New task</span>
  </Button>;
  return <FlyoutAppearanceProvider><TruncatedTextMarqueeProvider><aside className="coordinator-sidebar design-sidebar w-full">
    <div className="design-sidebar-brand" data-collapsed={rail || undefined}>
      <SidebarCompanyMenu showChevron={false} />
      <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" className="design-sidebar-search" aria-label="Global search" onClick={() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }))}><Search aria-hidden /></Button></TooltipTrigger><TooltipContent side="right">Search tasks, agents, projects</TooltipContent></Tooltip>
    </div>
    <nav className="design-sidebar-navigation" aria-label="Workspace navigation">
      <div className="design-sidebar-primary">
        {rail ? <Tooltip><TooltipTrigger asChild>{newTaskButton}</TooltipTrigger><TooltipContent side="right">New task</TooltipContent></Tooltip> : newTaskButton}
        <div className="design-sidebar-primary my-2">
          <SidebarNavItem className="design-sidebar-item" to="/chats" label="Chat" icon={MessageCircle} badge={unreadChatCount} badgeLabel="unread chats" />
          <div className="group/coordinator-new relative">
            <SidebarNavItem to="/issues" label="Tasks" icon={CircleCheck} className={cn("design-sidebar-item", !rail && "pr-9")} />
            {!rail && <button type="button" aria-label="New task" title="New task" onClick={() => openNewIssue()}
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity group-hover/coordinator-new:opacity-100 group-focus-within/coordinator-new:opacity-100 pointer-coarse:opacity-100 hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring"><Plus className="size-4" /></button>}
          </div>
          {/* The decision queue is closed to a restricted member; his Inbox is the task inbox (PAR-12608 4.6). */}
          {memberRestricted
            ? <SidebarNavItem className="design-sidebar-item" to={RESTRICTED_MEMBER_LANDING_PATH} label="Inbox" icon={Inbox} />
            : <SidebarNavItem className="design-sidebar-item" to="/decisions" label="Inbox" icon={Inbox} badge={attentionCount} badgeLabel="decisions" />}
          <SidebarNotesDropdown coordinator />
        </div>
        <Flyout open={moreOpen} onOpenChange={setMoreOpen}>
          <FlyoutTrigger asChild><button type="button" aria-label="More workspace pages" className="design-sidebar-item flex w-auto items-center gap-2.5 rounded-lg py-1.5 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring"><MoreHorizontal className="size-4 shrink-0" /><span className={rail ? SIDEBAR_RAIL_HIDDEN_LABEL : undefined}>More</span></button></FlyoutTrigger>
          <FlyoutContent ref={moreContentRef} tabIndex={-1} onOpenAutoFocus={(event) => { event.preventDefault(); moreContentRef.current?.focus(); }} side={isMobile ? "bottom" : "right"} align="start" className="w-64 max-h-(--radix-popover-content-available-height) overflow-y-auto p-1" aria-label="More workspace pages">
            {destinations.map(({ label, to, icon: Icon }, index) => {
              const pinned = pinnedNavigation.pins.includes(to);
              const PinIcon = pinned ? PinOff : Pin;
              return <div key={to}>
                {index === 6 || index === 10 ? <div role="separator" className="my-1 border-t border-border" /> : null}
                <div className="group/coordinator-more relative flex items-center rounded-sm transition-colors hover:bg-accent">
                  <Link to={to} onClick={() => { setMoreOpen(false); if (isMobile) setSidebarOpen(false); }} className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1.5 pr-10 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <Icon className="size-4 shrink-0 text-muted-foreground" />{label}
                  </Link>
                  <button type="button" aria-label={`${pinned ? "Unpin" : "Pin"} ${label}`} aria-pressed={pinned} title={`${pinned ? "Unpin" : "Pin"} ${label}`} disabled={!pinnedNavigation.canPin} onClick={() => pinnedNavigation.toggle(to)} className={cn("absolute right-0.5 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-sm opacity-0 transition-opacity outline-none group-hover/coordinator-more:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring", pinned ? "text-foreground" : "text-muted-foreground")}>
                    <PinIcon className="size-3.5" />
                  </button>
                </div>
              </div>;
            })}
            <MoreApps companyId={companyId ?? null} hiddenApps={hiddenApps} onNavigate={() => { setMoreOpen(false); if (isMobile) setSidebarOpen(false); }} />
          </FlyoutContent>
        </Flyout>
      </div>
      {orderedPins.length > 0 && <div className="design-sidebar-pins"><SidebarSection label="Pinned">
        <PinnedNavigationList key={`${companyId}:${userId}`} items={orderedPins} rail={rail} onReorder={pinnedNavigation.reorder} onUnpin={pinnedNavigation.toggle} />
      </SidebarSection></div>}
      <PluginNavigation companyId={companyId ?? null} rail={rail} hidden={hiddenApps.hidden} />
      {(pinnedNavigation.error ?? hiddenApps.error) && <p role="alert" className="px-4 py-2 text-xs text-destructive">{pinnedNavigation.error ?? hiddenApps.error}</p>}
      {!rail && session.isSuccess && recents.length > 0 && <div className="design-sidebar-recents"><SidebarSection label="Recents">
        <RecentNavigationList>
        {recents.map(item => item.kind === "task"
          ? <SidebarNavItem className="design-sidebar-item" key={item.id} to={`/issues/${item.task.identifier ?? item.id}`} label={item.task.title} iconNode={<StatusIcon {...taskStatusIconProps(item.task)} />} />
          : item.kind === "chat"
            ? <SidebarNavItem className="design-sidebar-item" key={item.id} to={`/chats/${encodeURIComponent(agentRouteRef(item.agent))}`} label={item.agent.name} iconNode={<AgentAvatar agent={item.agent} size={20} />} />
            : <ProjectRecent key={item.id} project={item.project} />)}
        </RecentNavigationList>
      </SidebarSection></div>}
      {children}
    </nav>
  </aside></TruncatedTextMarqueeProvider></FlyoutAppearanceProvider>;
}
