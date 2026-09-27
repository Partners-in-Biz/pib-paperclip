import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DataTable,
  useHostLocation,
  useHostNavigation,
  usePluginAction,
  type PluginPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  BarChart,
  Button,
  CircleCheckBig,
  ClientWorkspaceBar,
  CompactRows,
  EmptyState,
  Field,
  Input,
  KpiCard,
  LayoutDashboard,
  Modal,
  Page,
  PageFrame,
  PageMessage,
  Pill,
  Select,
  Send,
  Sheet,
  Tabs,
  TextArea,
  Toolbar,
  TriangleAlert,
  errorText,
  fluidColumns,
  tokens,
  tone,
  useIsNarrow,
} from "@partnersinbiz/pib-plugin-ui";
import { GetStarted, useGroupedNav, usePluginSetupStatus, useUrlTab } from "@partnersinbiz/pib-plugin-ui";
import { clientScopeFromSearch, formatClientParam, type ClientKind, type ClientScope } from "@partnersinbiz/pib-plugin-kit/client-ref";
import { resolvePluginUiBase } from "@partnersinbiz/pib-plugin-kit/oauth-client";
import { ModuleOffBanner, useModuleEnabled } from "./module-switch.js";
import type { CampaignSeries } from "../series.js";
import { approvalState, DELIVERY_LABEL, deliveryLabel } from "../detail.js";
import { CampaignsOverview, STATUS_LABEL, StatusPill, awaitingApproval, percent } from "./overview.js";
import { CampaignDetail, audienceText, type CampaignDetailData } from "./detail.js";

const PLUGIN_ID = "partnersinbiz.campaigns";
const MAILBOX_ID = "partnersinbiz.mailbox";

type AudienceMode = "tags" | "client_contacts" | "client_contact";

interface Campaign {
  id: string;
  name: string;
  description: string;
  status: string;
  fromName: string;
  fromLocal: string;
  audienceTags: string[];
  audienceMode?: AudienceMode;
  client?: { kind: ClientKind; id: string; name: string | null } | null;
  steps: Array<{ position: number; delayDays: number; subject: string; body: string; variant?: "a" | "b" }>;
  stats: { enrolled: number; running: number; done: number };
  approvalIssueId: string | null;
  approvalStatus: string | null;
  delivery?: "issue" | "email";
  winnerVariant?: "a" | "b" | null;
  launchedAt?: string | null;
  /** Why the last launch on approval failed (the approval went back to the approver). */
  launchError?: string | null;
}

interface AbSuggestion {
  verdict: string;
  suggestion: "a" | "b" | null;
  sends: { a: number; b: number };
  replies: { a: number; b: number };
  replyRate: { a: number | null; b: number | null };
  reason: string;
  winnerVariant?: "a" | "b" | null;
}

interface WorkspaceClient {
  kind: ClientKind;
  id: string;
  name: string | null;
  detail: string | null;
  found: boolean;
  contactCount: number | null;
}

interface Snapshot { campaigns: Campaign[]; settingsSaved?: boolean; client?: WorkspaceClient | null; series?: CampaignSeries; suppressed?: number }
type TabId = "overview" | "campaigns";
type CreateKind = "campaign" | "step" | "ab" | null;

function defaultAudience(scope: ClientScope): AudienceMode {
  if (!scope) return "tags";
  return scope.kind === "company" ? "client_contacts" : "client_contact";
}

/** `search` with `key` set, or removed when `value` is null. Returns "" or "?…". */
function withParam(search: string, key: string, value: string | null): string {
  const params = new URLSearchParams(search);
  if (value) params.set(key, value);
  else params.delete(key);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** Page layout for a client workspace: the shared client bar replaces the page header. */
function WorkspacePage({ header, message, children }: { header: ReactNode; message?: string; children: ReactNode }) {
  return (
    <PageFrame accent="campaigns">
      {header}
      <PageMessage message={message} />
      {children}
    </PageFrame>
  );
}

/** One line above the tabs: what cannot work yet, and the link that fixes it. */
function Banner({ text, link, linkProps }: { text: string; link: { label: string; href: string }; linkProps: (href: string) => Record<string, unknown> }) {
  const colors = tone("warn");
  return (
    <div role="status" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 13, lineHeight: 1.4, padding: "8px 12px", borderRadius: 10, border: `1px solid ${colors.border}`, background: `linear-gradient(90deg, ${colors.soft}, transparent 80%), ${tokens.card}`, minWidth: 0 }}>
      <TriangleAlert size={15} aria-hidden="true" style={{ color: colors.solid, flexShrink: 0 }} />
      <span style={{ flex: "1 1 200px", minWidth: 0 }}>{text}</span>
      <a {...linkProps(link.href)} style={{ fontWeight: 600, color: tokens.primary, whiteSpace: "nowrap" }}>{link.label} →</a>
    </div>
  );
}

export function CampaignsPage({ context }: PluginPageProps) {
  const location = useHostLocation();
  const navigation = useHostNavigation();
  const narrow = useIsNarrow();
  const scope = useMemo(() => clientScopeFromSearch(location.search), [location.search]);
  const scopeKey = scope ? formatClientParam(scope) : "own";
  const load = usePluginAction("campaigns.load");
  const loadDetail = usePluginAction("campaigns.detail");
  const createCampaign = usePluginAction("campaigns.create-campaign");
  const addStep = usePluginAction("campaigns.add-step");
  const launch = usePluginAction("campaigns.launch");
  const requestApproval = usePluginAction("campaigns.request-approval");
  const pause = usePluginAction("campaigns.pause");
  const resume = usePluginAction("campaigns.resume");
  const complete = usePluginAction("campaigns.complete");
  const abSuggestion = usePluginAction("campaigns.ab-suggestion");
  const declareWinner = usePluginAction("campaigns.declare-winner");
  const [ab, setAb] = useState<AbSuggestion | null>(null);
  const [delivery, setDelivery] = useState<"issue" | "email">("issue");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [detail, setDetail] = useState<CampaignDetailData | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  // `?tab=` opens a tab and switching tabs updates the address, so links can point at a tab.
  const [tab, setTab] = useUrlTab<TabId>(["overview", "campaigns"], "overview", { path: "/campaigns", search: location.search, navigate: navigation.navigate });
  // `?campaign=<id>` opens that campaign's detail, so an approval can link straight to what goes out.
  const openId = new URLSearchParams(location.search).get("campaign");
  // "Finish setting up Campaigns" on the overview until its required setup is done.
  const setupStatus = usePluginSetupStatus(PLUGIN_ID, context.companyId);
  // Emails go out through the Mailbox's Gmail; its own checklist says whether Gmail is connected.
  const mailboxStatus = usePluginSetupStatus(MAILBOX_ID, context.companyId);
  const [search, setSearch] = useState("");
  const [create, setCreate] = useState<CreateKind>(null);
  const [selectedCampaignId, setSelectedCampaignId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [audienceTags, setAudienceTags] = useState("");
  const [audienceMode, setAudienceMode] = useState<AudienceMode>(defaultAudience(scope));
  const [stepSubject, setStepSubject] = useState("");
  const [stepBody, setStepBody] = useState("");
  const [stepDelay, setStepDelay] = useState("0");

  async function refresh() {
    setSnapshot((await load({ client: scope, uiBase: await resolvePluginUiBase(PLUGIN_ID, import.meta.url) })) as Snapshot);
  }
  async function refreshDetail(id: string | null = openId) {
    setDetail(id ? ((await loadDetail({ campaignId: id })) as CampaignDetailData) : null);
  }

  useEffect(() => {
    if (!context.companyId) return;
    setSnapshot(null);
    setMessage("");
    refresh().catch((error: unknown) => setMessage(errorText(error)));
  }, [context.companyId, scopeKey]);

  useEffect(() => {
    if (!context.companyId || !openId) {
      setDetail(null);
      return;
    }
    let live = true;
    setDetail(null);
    loadDetail({ campaignId: openId })
      .then((result) => {
        if (live) setDetail(result as CampaignDetailData);
      })
      .catch((error: unknown) => {
        if (live) setMessage(errorText(error));
      });
    return () => {
      live = false;
    };
  }, [context.companyId, openId]);

  async function run(work: () => Promise<unknown>, success: string) {
    setMessage("");
    setBusy(true);
    try {
      await work();
      await refresh();
      if (openId) await refreshDetail(openId);
      setMessage(success);
      setCreate(null);
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  function openCampaign(id: string) {
    navigation.navigate(`/campaigns${withParam(location.search, "campaign", id)}`);
  }
  function closeCampaign() {
    navigation.navigate(`/campaigns${withParam(location.search, "campaign", null)}`, { replace: true });
  }

  function openNewCampaign() {
    setAudienceMode(defaultAudience(scope));
    setDelivery("issue");
    setCreate("campaign");
  }

  function openAddStep(campaignId: string) {
    setSelectedCampaignId(campaignId);
    setCreate("step");
  }

  function openAb(campaignId: string) {
    setSelectedCampaignId(campaignId);
    setAb(null);
    setCreate("ab");
    abSuggestion({ campaignId })
      .then((result) => setAb(result as AbSuggestion))
      .catch((error: unknown) => setMessage(errorText(error)));
  }

  const approvalRequested = "Approval requested. It launches by itself once a person approves it.";
  const client = scope ? snapshot?.client ?? null : null;
  const clientName = client?.name ?? "this client";
  const barName = client?.name ?? (snapshot ? "Unknown client" : "Loading…");
  const q = search.trim().toLowerCase();
  const all = snapshot?.campaigns ?? [];
  const campaigns = useMemo(() => all.filter((c) => !q || c.name.toLowerCase().includes(q) || (STATUS_LABEL[c.status] ?? c.status).toLowerCase().includes(q)), [snapshot, q]);
  const waitingCount = all.filter(awaitingApproval).length;
  const byCampaign = snapshot?.series?.byCampaign ?? {};
  const newCampaignButton = <Button type="button" onClick={openNewCampaign}>+ New campaign</Button>;
  // One "+ New campaign": in the header once there are campaigns, else in the empty state.
  const headerAction = snapshot && all.length > 0 ? newCampaignButton : undefined;
  const pageMessage = message
    || (scope && client && !client.found
      ? `${client.name ?? "This client"} is not in the Campaigns client list yet. Run the CRM "resync" action, then reload this page.`
      : undefined);
  const gmail = mailboxStatus?.items.find((item) => item.key === "gmail") ?? null;
  const settingsItem = setupStatus?.items.find((item) => item.key === "settings") ?? null;
  const linkProps = (href: string) => navigation.linkProps(href) as unknown as Record<string, unknown>;
  const showTags = audienceMode !== "client_contact";

  /** The one next step for a campaign in the list; everything else is in its detail. */
  function rowAction(campaign: Campaign): ReactNode {
    if (campaign.status !== "draft") return null;
    const state = approvalState(campaign);
    const small = { height: 30, fontSize: 12.5 };
    if (campaign.steps.length === 0) return <Button type="button" variant="secondary" style={small} onClick={() => openAddStep(campaign.id)}>Add the first email</Button>;
    if (state.key === "not-requested") return <Button type="button" style={small} disabled={busy} onClick={() => void run(() => requestApproval({ campaignId: campaign.id }), approvalRequested)}>Request approval</Button>;
    if (state.key === "approved") return <Button type="button" style={small} disabled={busy} onClick={() => void run(() => launch({ campaignId: campaign.id }), "Campaign launched")}>Launch now</Button>;
    if (state.key === "could-not-launch") return <span title={campaign.launchError ?? undefined}><Pill tone="bad" dot>Could not launch</Pill></span>;
    return <Pill tone="warn" dot>Waiting for approval</Pill>;
  }

  /** A needs-you marker for a phone row. */
  function rowFlag(campaign: Campaign): ReactNode {
    const state = approvalState(campaign);
    if (campaign.status !== "draft") return null;
    if (state.key === "could-not-launch") return <Pill tone="bad" dot>Could not launch</Pill>;
    if (state.key === "waiting") return <Pill tone="warn" dot>Awaiting approval</Pill>;
    if (state.key === "not-requested") return <Pill tone="info" dot>Draft</Pill>;
    return null;
  }

  const body = (
    <>
      <ModuleOffBanner companyId={context.companyId} pluginKey={PLUGIN_ID} />
      {gmail && gmail.status !== "done" ? (
        <Banner text="Emails can't go out: Gmail isn't connected." link={{ label: "Connect Gmail", href: "/mailbox?tab=mailboxes&connect=gmail" }} linkProps={linkProps} />
      ) : null}
      {snapshot && snapshot.settingsSaved === false ? (
        <Banner text="Due emails won't go out until the Campaigns settings are saved once." link={{ label: "Open settings", href: settingsItem?.href ?? "/company/settings/instance/plugins" }} linkProps={linkProps} />
      ) : null}
      <Tabs
        tabs={[
          { id: "overview", label: "Overview", icon: LayoutDashboard },
          { id: "campaigns", label: "Campaigns", icon: Send, count: waitingCount || null, countTone: "warn" },
        ]}
        active={tab}
        onChange={(id) => { setTab(id as TabId); setSearch(""); }}
      />

      {tab === "overview" ? <GetStarted status={setupStatus} hasData={all.length > 0} moduleName="Campaigns" linkFor={linkProps} /> : null}
      {tab === "overview" ? (
        snapshot ? (
          <CampaignsOverview
            campaigns={snapshot.campaigns}
            series={snapshot.series}
            suppressed={snapshot.suppressed ?? 0}
            onNew={newCampaignButton}
            onList={() => { setTab("campaigns"); setSearch(""); }}
            onAb={openAb}
            onOpen={openCampaign}
          />
        ) : <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>{message ? "Campaigns could not load." : "Loading campaigns…"}</p>
      ) : null}

      {tab === "campaigns" ? (
        <div style={{ display: "grid", gap: 12 }}>
          {all.length > 5 ? <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search campaigns…" /> : null}
          {!snapshot ? <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>Loading campaigns…</p> : all.length === 0 ? (
            <EmptyState
              title={scope ? `No campaigns for ${clientName} yet` : "No campaigns yet"}
              icon={Send}
              description={scope
                ? "Create a campaign for this client and add its emails, then request approval. It launches by itself once a person approves."
                : "Create a campaign and add its emails, then request approval. It launches by itself once a person approves."}
              action={newCampaignButton}
            />
          ) : narrow ? (
            <CompactRows
              label="Campaigns"
              rows={campaigns}
              title={(c) => c.name}
              meta={(c) => `${STATUS_LABEL[c.status] ?? c.status} · ${deliveryLabel(c.delivery)} · ${c.stats.enrolled} enrolled`}
              trailing={rowFlag}
              onOpen={(c) => openCampaign(c.id)}
              empty="No campaigns match."
            />
          ) : (
            <DataTable
              columns={[
                { key: "name", header: "Campaign", render: (value, row) => {
                  const campaign = row as unknown as Campaign;
                  return (
                    <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
                      <button
                        type="button"
                        onClick={() => openCampaign(campaign.id)}
                        title="See every email, who gets it and when"
                        style={{ appearance: "none", border: "none", background: "transparent", padding: 0, textAlign: "left", font: "inherit", fontWeight: 600, color: tokens.fg, cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 3, textDecorationColor: tokens.border, overflowWrap: "anywhere" }}
                      >
                        {String(value)}
                      </button>
                      {campaign.launchError && campaign.status === "draft" ? <span style={{ fontSize: 12, color: tokens.muted, overflowWrap: "anywhere" }}>Could not launch: {campaign.launchError}</span> : null}
                    </div>
                  );
                } },
                { key: "status", header: "Status", render: (value) => <StatusPill status={String(value)} /> },
                { key: "deliveryLabel", header: "Delivery" },
                { key: "audience", header: "Audience" },
                { key: "stepCount", header: "Emails", width: "70px" },
                { key: "enrolled", header: "Enrolled", width: "80px" },
                { key: "replyRate", header: "Replies", render: (_value, row) => {
                  const counts = byCampaign[String(row.id)];
                  return counts?.sent ? <span style={{ fontVariantNumeric: "tabular-nums" }}>{percent(counts.replies / counts.sent)} <span style={{ color: tokens.muted }}>of {counts.sent}</span></span> : <span style={{ color: tokens.muted }}>—</span>;
                } },
                { key: "id", header: "Next step", width: "180px", render: (_value, row) => rowAction(row as unknown as Campaign) },
              ]}
              rows={campaigns.map((c) => ({ ...c, audience: audienceText(c), deliveryLabel: deliveryLabel(c.delivery), enrolled: c.stats.enrolled, stepCount: new Set(c.steps.map((s) => s.position)).size }))}
              emptyMessage="No campaigns match."
            />
          )}
        </div>
      ) : null}

      <Sheet open={Boolean(openId)} title={detail?.campaign.name ?? "Campaign"} onClose={closeCampaign}>
        {detail ? (
          <CampaignDetail
            data={detail}
            linkFor={linkProps}
            actions={{
              busy,
              onRequestApproval: () => void run(() => requestApproval({ campaignId: detail.campaign.id }), approvalRequested),
              onLaunch: () => void run(() => launch({ campaignId: detail.campaign.id }), "Campaign launched"),
              onAddStep: () => openAddStep(detail.campaign.id),
              onPause: () => void run(() => pause({ campaignId: detail.campaign.id }), "Campaign paused"),
              onResume: () => void run(() => resume({ campaignId: detail.campaign.id }), "Campaign resumed"),
              onEnrollNew: () => void run(() => launch({ campaignId: detail.campaign.id }), "New audience contacts enrolled and the campaign is running"),
              onComplete: () => {
                if (window.confirm(`Complete ${detail.campaign.name}? Nobody gets its later emails after this.`)) void run(() => complete({ campaignId: detail.campaign.id }), "Campaign completed");
              },
              onAb: () => openAb(detail.campaign.id),
            }}
          />
        ) : <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>Loading the campaign…</p>}
      </Sheet>

      <Modal
        open={create === "campaign"}
        title={scope ? `New campaign for ${clientName}` : "New campaign"}
        description="Next you add its emails, then request approval."
        onClose={() => setCreate(null)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
            <Button type="button" disabled={busy} onClick={() => void run(async () => {
              const created = (await createCampaign({
                name,
                description,
                audienceTags: showTags ? audienceTags.split(",").map((tag) => tag.trim()).filter(Boolean) : [],
                delivery,
                ...(scope ? { client: scope, audienceMode } : {}),
              })) as { id?: string };
              setName("");
              setDescription("");
              setAudienceTags("");
              if (created?.id) openCampaign(created.id);
            }, "Campaign created. Add its first email.")}>Create</Button>
          </>
        )}
      >
        <Field label="Name"><Input value={name} onChange={(event) => setName(event.target.value)} required /></Field>
        <Field label="Description"><TextArea value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
        <Field label="Delivery">
          <Select value={delivery} onChange={(event) => setDelivery(event.target.value === "email" ? "email" : "issue")}>
            <option value="issue">{DELIVERY_LABEL.issue}: the agent sends each email</option>
            <option value="email">{DELIVERY_LABEL.email}: sent automatically</option>
          </Select>
        </Field>
        {scope ? (
          <Field label="Audience">
            <Select value={audienceMode} onChange={(event) => setAudienceMode(event.target.value as AudienceMode)}>
              {scope.kind === "company" ? (
                <option value="client_contacts">
                  Contacts at this company{client?.contactCount != null ? ` (${client.contactCount})` : ""}
                </option>
              ) : (
                <option value="client_contact">{client?.name ? `${client.name} only` : "This contact only"}</option>
              )}
              <option value="tags">Tagged contacts (whole CRM)</option>
            </Select>
          </Field>
        ) : null}
        {showTags ? (
          <Field label={audienceMode === "client_contacts" ? "Only contacts with these tags (optional, comma separated)" : "Audience tags (comma separated)"}>
            <Input value={audienceTags} onChange={(event) => setAudienceTags(event.target.value)} placeholder="hot, prospect" />
          </Field>
        ) : null}
        {showTags && audienceMode === "tags" && !audienceTags.trim() ? (
          <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted, lineHeight: 1.45 }}>
            No tags means all CRM contacts. The approval will say "All contacts" with the count, and unsubscribed or bounced addresses are always left out.
          </p>
        ) : null}
      </Modal>

      <Modal open={create === "step"} title="Add an email" description="It goes out after the campaign's last email. Adding one to a campaign waiting for approval cancels that request." onClose={() => setCreate(null)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
          <Button type="button" disabled={busy} onClick={() => void run(async () => {
            await addStep({
              campaignId: selectedCampaignId,
              subject: stepSubject,
              body: stepBody,
              delayDays: Number(stepDelay || 0),
            });
            setStepSubject("");
            setStepBody("");
            setStepDelay("0");
          }, "Email added")}>Add email</Button>
        </>
      )}>
        <Field label="Subject"><Input value={stepSubject} onChange={(event) => setStepSubject(event.target.value)} required /></Field>
        <Field label="Email text"><TextArea value={stepBody} onChange={(event) => setStepBody(event.target.value)} rows={6} placeholder={"Hi {{first_name|there}},\n\n…\n\nReply STOP and we will not email you again."} /></Field>
        <Field label="Days to wait after the previous email (or after launch for the first)"><Input type="number" min={0} value={stepDelay} onChange={(event) => setStepDelay(event.target.value)} /></Field>
      </Modal>

      <Modal open={create === "ab"} title="A/B results" onClose={() => setCreate(null)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Close</Button>
          <Button type="button" variant={ab?.suggestion === "a" ? "primary" : "secondary"} disabled={!ab || busy} onClick={() => void run(() => declareWinner({ campaignId: selectedCampaignId, winner: "a" }), "A declared the winner")}>Declare A</Button>
          <Button type="button" variant={ab?.suggestion === "b" ? "primary" : "secondary"} disabled={!ab || busy} onClick={() => void run(() => declareWinner({ campaignId: selectedCampaignId, winner: "b" }), "B declared the winner")}>Declare B</Button>
        </>
      )}>
        {ab ? (
          <div style={{ display: "grid", gap: 10, fontSize: 13 }}>
            <div style={{ display: "grid", gridTemplateColumns: fluidColumns(130), gap: 10 }}>
              {(["a", "b"] as const).map((variant) => (
                <KpiCard
                  key={variant}
                  size="sm"
                  label={`Version ${variant.toUpperCase()}`}
                  value={percent(ab.replyRate[variant])}
                  tone={(ab.winnerVariant ?? ab.suggestion) === variant ? "ok" : "neutral"}
                  hint={`${ab.replies[variant]} of ${ab.sends[variant]} replied`}
                  icon={(ab.winnerVariant ?? ab.suggestion) === variant ? CircleCheckBig : undefined}
                />
              ))}
            </div>
            <BarChart
              bare
              title="Reply rate"
              items={(["a", "b"] as const).map((variant) => ({ label: `Version ${variant.toUpperCase()}`, value: (ab.replyRate[variant] ?? 0) * 100, tone: (ab.winnerVariant ?? ab.suggestion) === variant ? "ok" as const : "neutral" as const }))}
              formatValue={(v) => `${v.toFixed(1).replace(/\.0$/, "")}%`}
            />
            <p style={{ margin: 0 }}>{ab.reason}</p>
            <p style={{ margin: 0, color: tokens.muted }}>
              {ab.suggestion ? `Suggested winner: ${ab.suggestion.toUpperCase()}. You decide.` : "No winner suggested yet."}
              {ab.winnerVariant ? ` Current winner: ${ab.winnerVariant.toUpperCase()}.` : ""}
            </p>
          </div>
        ) : (
          <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>Loading…</p>
        )}
      </Modal>
    </>
  );

  if (scope) {
    return (
      <WorkspacePage
        header={(
          <ClientWorkspaceBar
            client={{ kind: scope.kind, id: scope.id, name: barName, detail: client?.detail ?? null }}
            active="campaigns"
            linkProps={navigation.linkProps}
            ownPath="/campaigns"
            actions={headerAction}
          />
        )}
        message={pageMessage}
      >
        {body}
      </WorkspacePage>
    );
  }

  return (
    <Page
      title="Campaigns"
      accent="campaigns"
      description="PiB's own email campaigns. A client's campaigns live in that client's workspace, opened from the CRM."
      message={pageMessage}
      actions={headerAction}
    >
      {body}
    </Page>
  );
}

export function CampaignsSidebar({ context }: PluginSidebarProps) {
  // Hidden when the company switched Campaigns off in Setup; shown while loading.
  const enabled = useModuleEnabled(context.companyId, PLUGIN_ID);
  // The Cockpit's Clients / Marketing / Finance group shows this page instead (pib-plugin-ui NAV_GROUPS).
  const grouped = useGroupedNav("partnersinbiz.campaigns");
  if (enabled === false || grouped !== false) return null;
  return (
    <SidebarNavLink to="/campaigns" label="Campaigns" icon={(
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2Z" />
        <path d="M18 9h2a2 2 0 0 1 2 2v8l-4-4h-4a2 2 0 0 1-2-2" />
      </svg>
    )} />
  );
}

function SidebarNavLink({ to, label, icon }: { to: string; label: string; icon: ReactNode }) {
  const hostNavigation = useHostNavigation();
  const href = hostNavigation.resolveHref(to);
  const isActive = typeof window !== "undefined" && window.location.pathname === href;
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
