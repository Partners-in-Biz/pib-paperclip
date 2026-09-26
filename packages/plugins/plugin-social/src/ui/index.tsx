import { resolvePluginUiBase } from "@partnersinbiz/pib-plugin-kit/oauth-client";
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
import { Button, Page, Tabs, errorText } from "@partnersinbiz/pib-plugin-ui";
import { AccountsTab, PickerModal, SetupBanners } from "./accounts.js";
import { Composer } from "./composer.js";
import { ClientSelect, platformLabel, Row } from "./parts.js";
import { CalendarView, PostDetail, PostsTab } from "./posts.js";
import { FeedsTab, InboxTab, MediaTab, OverviewTab, TemplatesTab } from "./tabs.js";
import type { Post, RunAction, Snapshot } from "./types.js";

const ACTION_KEYS = [
  "social.load",
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
] as const;

/** Calls that do not change anything: no snapshot reload afterwards. */
const READ_ONLY = new Set(["social.load", "social.get-post", "social.validate-post", "social.oauth-start", "social.oauth-pending", "social.media-presign"]);

type TabId = "overview" | "posts" | "calendar" | "accounts" | "inbox" | "media" | "feeds" | "templates";
const TAB_IDS: TabId[] = ["overview", "posts", "calendar", "accounts", "inbox", "media", "feeds", "templates"];

function useSocialActions(): Record<string, PluginActionFn> {
  const fns: Record<string, PluginActionFn> = {};
  // Fixed list, fixed order: the hooks run in the same order on every render.
  for (const key of ACTION_KEYS) fns[key] = usePluginAction(key);
  return fns;
}

export function SocialPage({ context }: PluginPageProps) {
  const fns = useSocialActions();
  const fnsRef = useRef(fns);
  fnsRef.current = fns;
  const toast = usePluginToast();
  const location = useHostLocation();
  const navigation = useHostNavigation();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<TabId>("overview");
  const [clientFilter, setClientFilter] = useState("");
  const [composer, setComposer] = useState<{ post: Post | null } | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [pickerId, setPickerId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const data = (await fnsRef.current["social.load"]!({ uiBase: await resolvePluginUiBase(PLUGIN_ID, import.meta.url) })) as Snapshot;
    setSnapshot(data);
  }, []);

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

  useEffect(() => {
    if (!context.companyId) return;
    refresh().catch((error: unknown) => setMessage(errorText(error)));
  }, [context.companyId, refresh]);

  // Returning from the OAuth bridge: ?tab=accounts&connected=facebook or &picker=<id>.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const nextTab = params.get("tab");
    if (nextTab && (TAB_IDS as string[]).includes(nextTab)) setTab(nextTab as TabId);
    const connected = params.get("connected");
    const picker = params.get("picker");
    if (connected) notify(`${platformLabel(connected)} connected`, "success");
    if (picker) setPickerId(picker);
    if (connected || picker) navigation.navigate(`/social?tab=${nextTab ?? "accounts"}`, { replace: true });
  }, [location.search]);

  const posts = useMemo(() => (snapshot?.posts ?? []).filter((p) =>
    !clientFilter || (clientFilter === "__none" ? !p.clientRef : p.clientRef === clientFilter)), [snapshot, clientFilter]);
  const detail = detailId ? snapshot?.posts.find((p) => p.id === detailId) ?? null : null;
  const newItems = snapshot?.inbox.filter((i) => i.status === "new").length ?? 0;
  const problems = (snapshot?.accounts ?? []).filter((a) => a.status === "needs_reconnect").length;

  if (!context.companyId) return <Page title="Social" description="Pick a company first.">{null}</Page>;

  return (
    <Page
      title="Social"
      description="Connect client accounts, draft posts with media and per-platform copy, get them approved, and publish on schedule."
      message={message}
      actions={(
        <Row>
          {snapshot ? <ClientSelect clients={snapshot.clients} value={clientFilter} onChange={setClientFilter} includeNone /> : null}
          <Button type="button" disabled={!snapshot} onClick={() => setComposer({ post: null })}>+ New post</Button>
        </Row>
      )}
    >
      {!snapshot ? <p style={{ margin: 0, fontSize: 13 }}>Loading…</p> : (
        <>
          {tab !== "accounts" ? <SetupBanners snapshot={snapshot} /> : null}
          <Tabs
            tabs={[
              { id: "overview", label: "Overview" },
              { id: "posts", label: `Posts (${posts.length})` },
              { id: "calendar", label: "Calendar" },
              { id: "accounts", label: `Accounts (${snapshot.accounts.length})${problems ? ` · ${problems} to fix` : ""}` },
              { id: "inbox", label: `Inbox${newItems ? ` (${newItems})` : ""}` },
              { id: "media", label: "Media" },
              { id: "feeds", label: "Feeds" },
              { id: "templates", label: "Templates" },
            ]}
            active={tab}
            onChange={(id) => setTab(id as TabId)}
          />
          {tab === "overview" ? <OverviewTab snapshot={snapshot} posts={posts} run={run} onOpenPicker={setPickerId} /> : null}
          {tab === "posts" ? <PostsTab posts={posts} snapshot={snapshot} onOpen={(p) => setDetailId(p.id)} onNew={() => setComposer({ post: null })} /> : null}
          {tab === "calendar" ? <CalendarView posts={posts} snapshot={snapshot} onOpen={(p) => setDetailId(p.id)} /> : null}
          {tab === "accounts" ? <AccountsTab snapshot={snapshot} companyId={context.companyId} run={run} clientFilter={clientFilter} /> : null}
          {tab === "inbox" ? <InboxTab snapshot={snapshot} run={run} /> : null}
          {tab === "media" ? <MediaTab snapshot={snapshot} run={run} clientFilter={clientFilter} /> : null}
          {tab === "feeds" ? <FeedsTab snapshot={snapshot} run={run} /> : null}
          {tab === "templates" ? <TemplatesTab snapshot={snapshot} run={run} /> : null}

          {composer ? (
            <Composer snapshot={snapshot} post={composer.post} run={run} defaultClient={clientFilter} onClose={() => setComposer(null)} />
          ) : null}
          {detail && !composer ? (
            <PostDetail post={detail} snapshot={snapshot} run={run} onClose={() => setDetailId(null)} onEdit={(p) => setComposer({ post: p })} />
          ) : null}
          {pickerId ? (
            <PickerModal
              pickerId={pickerId}
              snapshot={snapshot}
              run={run}
              onClose={() => setPickerId(null)}
              onDone={(n) => {
                setPickerId(null);
                notify(`${n} account${n === 1 ? "" : "s"} connected`, "success");
                refresh().catch(() => undefined);
              }}
            />
          ) : null}
        </>
      )}
    </Page>
  );
}

export function SocialSidebar(_props: PluginSidebarProps) {
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
