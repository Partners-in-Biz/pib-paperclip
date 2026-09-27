import { resolvePluginUiBase } from "@partnersinbiz/pib-plugin-kit/oauth-client";
import { clientScopeFromSearch, formatClientParam, parseClientParam, withClientParam, type ClientScope } from "@partnersinbiz/pib-plugin-kit/client-ref";
import { PLUGIN_ID } from "../platforms.js";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  useHostLocation,
  useHostNavigation,
  usePluginAction,
  usePluginToast,
  type PluginActionFn,
  type PluginPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  Button,
  Calendar,
  ClientWorkspaceBar,
  EmptyState,
  FileText,
  GetStarted,
  Inbox,
  LayoutDashboard,
  Megaphone,
  Package,
  Page,
  PageFrame,
  PageMessage,
  Plug,
  Radio,
  Tabs,
  TrendingUp,
  errorText,
  tokens,
  usePluginSetupStatus,
} from "@partnersinbiz/pib-plugin-ui";
import { useGroupedNav } from "@partnersinbiz/pib-plugin-ui";
import { AccountsTab, PickerModal, SetupBanners } from "./accounts.js";
import { Composer } from "./composer.js";
import { platformLabel, Row } from "./parts.js";
import { CalendarView, PostDetail, PostsTab } from "./posts.js";
import { GrowthTab } from "./growth.js";
import { ModuleOffBanner, useModuleEnabled } from "./module.js";
import { RoutineSwitchOn, useWeeklyRoutine } from "./routine.js";
import { FeedsTab, InboxTab, MediaTab, OverviewTab, TemplatesTab } from "./tabs.js";
import type { Post, RunAction, Snapshot } from "./types.js";

const ACTION_KEYS = [
  "social.load",
  "social.clients",
  "social.create-post",
  "social.update-post",
  "social.get-post",
  "social.validate-post",
  "social.delete-post",
  "social.attach",
  "social.detach",
  "social.review",
  "social.back-to-draft",
  "social.approve",
  "social.schedule",
  "social.unschedule",
  "social.retry-post",
  "social.create-template",
  "social.oauth-start",
  "social.oauth-pending",
  "social.oauth-confirm",
  "social.connect-bluesky",
  "social.disconnect-account",
  "social.update-account",
  "social.refresh-account",
  "social.media-presign",
  "social.create-media-asset",
  "social.import-media",
  "social.create-rss-feed",
  "social.set-rss-active",
  "social.mark-inbox-read",
  "social.reply-inbox",
  "social.activate-agent",
  "social.correct-triage",
  "social.growth-load",
  "social.growth-update-program",
  "social.growth-save-playbook",
  "social.growth-approve-experiment",
  "social.growth-reject-experiment",
  "social.growth-abandon-experiment",
  "social.growth-decide-change",
  "social.growth-retire-question",
  "social.routine-report",
] as const;

/** Calls that do not change anything: no snapshot reload afterwards. */
const READ_ONLY = new Set(["social.load", "social.clients", "social.get-post", "social.validate-post", "social.oauth-start", "social.oauth-pending", "social.media-presign", "social.growth-load", "social.routine-report"]);

type TabId = "overview" | "posts" | "calendar" | "accounts" | "inbox" | "growth" | "media" | "feeds" | "templates";
const TAB_IDS: TabId[] = ["overview", "posts", "calendar", "accounts", "inbox", "growth", "media", "feeds", "templates"];

function useSocialActions(): Record<string, PluginActionFn> {
  const fns: Record<string, PluginActionFn> = {};
  // Fixed list, fixed order: the hooks run in the same order on every render.
  for (const key of ACTION_KEYS) fns[key] = usePluginAction(key);
  return fns;
}

function tabFrom(search: string): TabId {
  const value = new URLSearchParams(search).get("tab");
  return value && (TAB_IDS as string[]).includes(value) ? (value as TabId) : "overview";
}

/** The page frame for a client workspace: the shared workspace bar replaces the page title. */
function WorkspaceFrame({ bar, message, children }: { bar: ReactNode; message?: string; children: ReactNode }) {
  return (
    <PageFrame accent="social">
      {bar}
      <PageMessage message={message} />
      {children}
    </PageFrame>
  );
}

export function SocialPage({ context }: PluginPageProps) {
  const fns = useSocialActions();
  const fnsRef = useRef(fns);
  fnsRef.current = fns;
  const toast = usePluginToast();
  const location = useHostLocation();
  const navigation = useHostNavigation();
  // ?client=company:<id> or contact:<id> is a client's workspace; none is PiB's own work.
  const scopeKey = useMemo(() => {
    const scope = clientScopeFromSearch(location.search);
    return scope ? formatClientParam(scope) : null;
  }, [location.search]);
  const scope: ClientScope = useMemo(() => parseClientParam(scopeKey), [scopeKey]);
  const tab = tabFrom(location.search);
  // Setup's "Switch it on" link for the weekly routine (own page only).
  const wantsRoutineOn = !scopeKey && new URLSearchParams(location.search).get("routine") === "on";
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [setupKey, setSetupKey] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [message, setMessage] = useState("");
  const [composer, setComposer] = useState<{ post: Post | null } | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [pickerId, setPickerId] = useState<string | null>(null);
  const loadSeq = useRef(0);
  // Switched off in Setup: show the banner instead of loading (null = still checking, load as usual).
  const enabled = useModuleEnabled(context.companyId);
  const off = enabled === false;

  /** A path on this page that keeps the current scope. */
  const pagePath = useCallback((query: string) => withClientParam(`/social${query ? `?${query}` : ""}`, scope), [scope]);

  const refresh = useCallback(async () => {
    const seq = ++loadSeq.current;
    const data = (await fnsRef.current["social.load"]!({
      uiBase: await resolvePluginUiBase(PLUGIN_ID, import.meta.url),
      client: scopeKey,
    })) as Snapshot;
    // Ignore a slow answer for a scope the page has already left.
    if (seq !== loadSeq.current) return;
    setSnapshot(data);
    setLoadError("");
  }, [scopeKey]);

  const notify = useCallback((title: string, tone: "success" | "error" | "info", body?: string) => {
    const id = toast({ title, body, tone, ttlMs: tone === "error" ? 9000 : 4000 });
    if (!id) setMessage(body ? `${title}: ${body}` : title);
  }, [toast]);

  const run: RunAction = useCallback(async (key, params, success) => {
    const fn = fnsRef.current[key];
    if (!fn) throw new Error(`Unknown action ${key}`);
    try {
      const result = await fn(params);
      if (success) notify(success, "success");
      if (!READ_ONLY.has(key)) await refresh();
      return result;
    } catch (error) {
      notify("That did not work", "error", errorText(error));
      throw error;
    }
  }, [notify, refresh]);

  // A new scope is a different workspace: drop what the old one showed.
  useEffect(() => {
    setSnapshot(null);
    setLoadError("");
    setComposer(null);
    setDetailId(null);
  }, [scopeKey]);

  useEffect(() => {
    if (!context.companyId || off) return;
    refresh().catch((error: unknown) => setLoadError(errorText(error)));
  }, [context.companyId, refresh, off]);

  // Returning from the OAuth bridge: ?tab=accounts&connected=facebook or &picker=<id> (plus ?client= for a client workspace).
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const connected = params.get("connected");
    const picker = params.get("picker");
    if (connected) notify(`${platformLabel(connected)} connected`, "success");
    if (picker) setPickerId(picker);
    if (connected || picker) navigation.navigate(pagePath(`tab=${params.get("tab") ?? "accounts"}`), { replace: true });
  }, [location.search]);

  const setTab = (id: TabId) => navigation.navigate(pagePath(id === "overview" ? "" : `tab=${id}`), { replace: true });

  // Own page: "finish setting up" (the same checklist Setup shows) and the weekly routine's real state.
  const setup = usePluginSetupStatus(PLUGIN_ID, !scopeKey && !off ? context.companyId : null, setupKey);
  const routineRef = !scopeKey ? snapshot?.routine ?? null : null;
  const weekly = useWeeklyRoutine({
    routine: routineRef,
    report: (params) => fnsRef.current["social.routine-report"]!(params),
    onReported: () => setSetupKey((k) => k + 1),
  });
  const closeRoutinePrompt = () => navigation.navigate("/social", { replace: true });

  const posts = snapshot?.posts ?? [];
  const detail = detailId ? posts.find((p) => p.id === detailId) ?? null : null;
  const newItems = snapshot?.inbox.filter((i) => i.status === "new").length ?? 0;
  const problems = (snapshot?.accounts ?? []).filter((a) => a.status === "needs_reconnect").length;
  const failedPosts = posts.filter((p) => p.status === "failed" || p.status === "partially_published").length;
  const inReview = posts.filter((p) => p.status === "review").length;
  const tabLink = (id: string) => navigation.linkProps(pagePath(id === "overview" ? "" : `tab=${id}`));

  if (!context.companyId) return <Page title="Social" description="Pick a company first." accent="social">{null}</Page>;

  const newPost = <Button type="button" disabled={!snapshot} onClick={() => setComposer({ post: null })}>+ New post</Button>;
  const client = snapshot?.client ?? null;

  const body = off ? <ModuleOffBanner /> : loadError ? (
    <EmptyState
      tone="bad"
      title={scope ? "This client's workspace could not open" : "Social could not load"}
      description={loadError}
      action={scope ? <a {...navigation.linkProps("/social")} style={{ fontSize: 13, color: tokens.fg }}>Go to own work</a> : undefined}
    />
  ) : !snapshot ? <p style={{ margin: 0, fontSize: 13 }}>Loading…</p> : (
    <>
      {/* The overview shows the setup checklist (it covers the settings); other tabs keep the short banners. */}
      {tab === "overview" && !scope ? <GetStarted status={setup} linkFor={(href) => ({ ...navigation.linkProps(href) })} moduleName="Social" /> : null}
      {tab !== "accounts" && (tab !== "overview" || scope || !setup) ? <SetupBanners snapshot={snapshot} /> : null}
      <Tabs
        tabs={[
          { id: "overview", label: "Overview", icon: LayoutDashboard },
          { id: "posts", label: "Posts", icon: Megaphone, count: posts.length, countTone: failedPosts ? "bad" : inReview ? "warn" : undefined },
          { id: "calendar", label: "Calendar", icon: Calendar },
          { id: "accounts", label: "Accounts", icon: Plug, count: snapshot.accounts.length, countTone: problems ? "bad" : undefined },
          { id: "inbox", label: "Inbox", icon: Inbox, count: newItems || null, countTone: newItems ? "warn" : undefined },
          { id: "growth", label: "Growth", icon: TrendingUp },
          { id: "media", label: "Media", icon: Package, count: snapshot.media.length || null },
          { id: "feeds", label: "Feeds", icon: Radio, count: snapshot.feeds.length || null, countTone: snapshot.feeds.some((f) => f.lastError) ? "bad" : undefined },
          { id: "templates", label: "Templates", icon: FileText, count: snapshot.templates.length || null },
        ]}
        active={tab}
        onChange={(id) => setTab(id as TabId)}
      />
      {tab === "overview" ? <OverviewTab snapshot={snapshot} posts={posts} run={run} onOpenPicker={setPickerId} onOpenPost={(p) => setDetailId(p.id)} tabLink={tabLink} /> : null}
      {tab === "posts" ? <PostsTab posts={posts} snapshot={snapshot} onOpen={(p) => setDetailId(p.id)} onNew={() => setComposer({ post: null })} /> : null}
      {tab === "calendar" ? <CalendarView posts={posts} snapshot={snapshot} onOpen={(p) => setDetailId(p.id)} /> : null}
      {tab === "accounts" ? <AccountsTab snapshot={snapshot} companyId={context.companyId} run={run} /> : null}
      {tab === "inbox" ? <InboxTab snapshot={snapshot} run={run} /> : null}
      {tab === "growth" ? <GrowthTab snapshot={snapshot} run={run} /> : null}
      {tab === "media" ? <MediaTab snapshot={snapshot} run={run} /> : null}
      {tab === "feeds" ? <FeedsTab snapshot={snapshot} run={run} /> : null}
      {tab === "templates" ? <TemplatesTab snapshot={snapshot} run={run} /> : null}

      {composer ? (
        <Composer snapshot={snapshot} post={composer.post} run={run} onClose={() => setComposer(null)} />
      ) : null}
      {detail && !composer ? (
        <PostDetail post={detail} snapshot={snapshot} run={run} onClose={() => setDetailId(null)} onEdit={(p) => setComposer({ post: p })} />
      ) : null}
      {wantsRoutineOn ? (
        <RoutineSwitchOn
          routine={routineRef}
          info={weekly.info}
          report={(params) => fnsRef.current["social.routine-report"]!(params)}
          onClose={closeRoutinePrompt}
          onSwitched={(info) => {
            weekly.setInfo(info);
            setSetupKey((k) => k + 1);
            notify("Weekly plan switched on", "success", "Every Monday at 07:00 the Social agent drafts next week's posts for approval.");
            closeRoutinePrompt();
            refresh().catch(() => undefined);
          }}
        />
      ) : null}
      {pickerId ? (
        <PickerModal
          pickerId={pickerId}
          run={run}
          onClose={() => setPickerId(null)}
          onDone={(n, belongsTo) => {
            setPickerId(null);
            notify(`${n} account${n === 1 ? "" : "s"} connected`, "success", belongsTo ? `They belong to ${belongsTo}.` : undefined);
            refresh().catch(() => undefined);
          }}
        />
      ) : null}
    </>
  );

  if (scope) {
    return (
      <WorkspaceFrame
        message={message}
        bar={(
          <ClientWorkspaceBar
            client={{
              kind: scope.kind,
              id: scope.id,
              name: client?.name ?? (loadError ? "Unknown client" : off ? "Client" : "Loading…"),
              detail: client ? client.domain ?? client.email ?? null : null,
            }}
            active="social"
            linkProps={navigation.linkProps}
            ownPath="/social"
            ownLabel="Own social"
            actions={off ? undefined : <Row>{newPost}</Row>}
          />
        )}
      >
        {body}
      </WorkspaceFrame>
    );
  }

  return (
    <Page
      title="Social"
      description="Partners in Biz's own social accounts and posts. Client social work lives in each client's workspace (open it from the CRM)."
      message={message}
      accent="social"
      actions={off ? undefined : <Row>{newPost}</Row>}
    >
      {body}
    </Page>
  );
}

export function SocialSidebar({ context }: PluginSidebarProps) {
  // Nothing when the company switched Social off; shown while the check runs.
  const enabled = useModuleEnabled(context.companyId);
  // The Cockpit's Clients / Marketing / Finance group shows this page instead (pib-plugin-ui NAV_GROUPS).
  const grouped = useGroupedNav("partnersinbiz.social");
  if (enabled === false || grouped !== false) return null;
  return (
    <SidebarNavLink to="/social" label="Social" icon={(
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
        <polyline points="16 6 12 2 8 6" />
        <line x1="12" y1="2" x2="12" y2="15" />
      </svg>
    )} />
  );
}

function SidebarNavLink({ to, label, icon }: { to: string; label: string; icon: ReactNode }) {
  const hostNavigation = useHostNavigation();
  const location = useHostLocation();
  const href = hostNavigation.resolveHref(to);
  const isActive = location.pathname === href;
  return (
    <a
      {...hostNavigation.linkProps(to)}
      aria-current={isActive ? "page" : undefined}
      className={[
        "flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 text-(length:--text-compact) font-medium transition-colors",
        isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      ].join(" ")}
      style={{ textDecoration: "none" }}
    >
      <span aria-hidden="true" className="relative shrink-0">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
    </a>
  );
}
