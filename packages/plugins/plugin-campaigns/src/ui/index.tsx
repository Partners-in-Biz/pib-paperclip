import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DataTable,
  MetricCard,
  StatusBadge,
  useHostLocation,
  useHostNavigation,
  usePluginAction,
  type PluginPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  Button,
  ClientWorkspaceBar,
  EmptyState,
  Field,
  Input,
  Modal,
  Page,
  Select,
  StatRow,
  Tabs,
  TextArea,
  Toolbar,
  errorText,
  tokens,
} from "@partnersinbiz/pib-plugin-ui";
import { clientScopeFromSearch, formatClientParam, type ClientKind, type ClientScope } from "@partnersinbiz/pib-plugin-kit/client-ref";
import { resolvePluginUiBase } from "@partnersinbiz/pib-plugin-kit/oauth-client";
import { ModuleOffBanner, useModuleEnabled } from "./module-switch.js";

const PLUGIN_ID = "partnersinbiz.campaigns";

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

interface Snapshot { campaigns: Campaign[]; settingsSaved?: boolean; client?: WorkspaceClient | null }
type TabId = "overview" | "campaigns";
type CreateKind = "campaign" | "step" | "ab" | null;

const FONT = `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

function defaultAudience(scope: ClientScope): AudienceMode {
  if (!scope) return "tags";
  return scope.kind === "company" ? "client_contacts" : "client_contact";
}

function audienceLabel(campaign: Campaign): string {
  const tags = campaign.audienceTags.join(", ");
  if (campaign.audienceMode === "client_contacts") return tags ? `Company contacts tagged ${tags}` : "Contacts at the company";
  if (campaign.audienceMode === "client_contact") return "The client contact";
  return tags ? `Tagged ${tags}` : "Every CRM contact";
}

/** Page layout for a client workspace: the shared client bar replaces the page header. */
function WorkspacePage({ header, message, children }: { header: ReactNode; message?: string; children: ReactNode }) {
  return (
    <main style={{ fontFamily: FONT, color: tokens.fg, padding: 28, maxWidth: 1160, display: "grid", gap: 22 }}>
      {header}
      {message ? (
        <p
          role="status"
          style={{
            margin: 0,
            fontSize: 13,
            padding: "10px 14px",
            borderRadius: 10,
            border: `1px solid ${tokens.border}`,
            background: tokens.secondary,
            color: tokens.secondaryFg,
            lineHeight: 1.45,
          }}
        >
          {message}
        </p>
      ) : null}
      {children}
    </main>
  );
}

export function CampaignsPage({ context }: PluginPageProps) {
  const location = useHostLocation();
  const navigation = useHostNavigation();
  const scope = useMemo(() => clientScopeFromSearch(location.search), [location.search]);
  const scopeKey = scope ? formatClientParam(scope) : "own";
  const load = usePluginAction("campaigns.load");
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
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<TabId>("overview");
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

  useEffect(() => {
    if (!context.companyId) return;
    setSnapshot(null);
    setMessage("");
    refresh().catch((error: unknown) => setMessage(errorText(error)));
  }, [context.companyId, scopeKey]);

  async function run(work: () => Promise<unknown>, success: string) {
    setMessage("");
    try {
      await work();
      await refresh();
      setMessage(success);
      setCreate(null);
    } catch (error) {
      setMessage(errorText(error));
    }
  }

  function openNewCampaign() {
    setAudienceMode(defaultAudience(scope));
    setDelivery("issue");
    setCreate("campaign");
  }

  function openAb(campaignId: string) {
    setSelectedCampaignId(campaignId);
    setAb(null);
    setCreate("ab");
    abSuggestion({ campaignId })
      .then((result) => setAb(result as AbSuggestion))
      .catch((error: unknown) => setMessage(errorText(error)));
  }

  const client = scope ? snapshot?.client ?? null : null;
  const clientName = client?.name ?? "this client";
  const barName = client?.name ?? (snapshot ? "Unknown client" : "Loading…");
  const q = search.trim().toLowerCase();
  const campaigns = useMemo(() => (snapshot?.campaigns ?? []).filter((c) => !q || c.name.toLowerCase().includes(q) || c.status.includes(q)), [snapshot, q]);
  const totalEnrolled = (snapshot?.campaigns ?? []).reduce((sum, c) => sum + c.stats.enrolled, 0);
  const activeCount = (snapshot?.campaigns ?? []).filter((c) => c.status === "active").length;
  const newCampaignButton = <Button type="button" onClick={openNewCampaign}>+ New campaign</Button>;
  const pageMessage = message
    || (scope && client && !client.found
      ? `${client.name ?? "This client"} is not in the Campaigns client list yet. Run the CRM "resync" action, then reload this page.`
      : undefined)
    || (snapshot && snapshot.settingsSaved === false
      ? "Campaign settings are not saved for this company yet. Open Settings → Plugins → Campaigns and click Save once, or due-step issues will not open."
      : undefined);
  const showTags = audienceMode !== "client_contact";

  const body = (
    <>
      <ModuleOffBanner companyId={context.companyId} pluginKey={PLUGIN_ID} />
      <Tabs
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "campaigns", label: `Campaigns (${snapshot?.campaigns.length ?? 0})` },
        ]}
        active={tab}
        onChange={(id) => { setTab(id as TabId); setSearch(""); }}
      />

      {tab === "overview" ? (
        <div style={{ display: "grid", gap: 16 }}>
          <StatRow>
            <MetricCard label="Campaigns" value={snapshot?.campaigns.length ?? 0} />
            <MetricCard label="Active" value={activeCount} />
            <MetricCard label="Contacts enrolled" value={totalEnrolled} />
          </StatRow>
        </div>
      ) : null}

      {tab === "campaigns" ? (
        <div style={{ display: "grid", gap: 12 }}>
          <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search campaigns…">
            {newCampaignButton}
          </Toolbar>
          {campaigns.length === 0 ? (
            <EmptyState
              title={scope ? `No campaigns for ${clientName} yet` : "No campaigns yet"}
              description={scope
                ? "Create a campaign for this client, add email steps, then launch it to enroll its contacts."
                : "Create a campaign, add email steps, then launch it to enroll matching contacts."}
              action={newCampaignButton}
            />
          ) : (
            <DataTable
              columns={[
                { key: "name", header: "Campaign" },
                { key: "status", header: "Status", render: (value) => <StatusBadge label={String(value)} status={value === "active" ? "ok" : value === "draft" ? "pending" : "info"} /> },
                { key: "audience", header: "Audience" },
                { key: "deliveryLabel", header: "Sends by" },
                { key: "enrolled", header: "Enrolled" },
                { key: "steps", header: "Steps" },
                {
                  key: "id",
                  header: "Actions",
                  width: "320px",
                  render: (_value, row) => {
                    const campaign = row as unknown as Campaign;
                    return (
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <Button type="button" variant="secondary" style={{ height: 28, fontSize: 12 }} onClick={() => { setSelectedCampaignId(campaign.id); setCreate("step"); }}>Add step</Button>
                        {campaign.steps.some((step) => step.variant === "b") && (campaign.status === "active" || campaign.status === "paused") ? (
                          <Button type="button" variant="secondary" style={{ height: 28, fontSize: 12 }} onClick={() => openAb(campaign.id)}>
                            {campaign.winnerVariant ? `A/B: ${campaign.winnerVariant.toUpperCase()} won` : "A/B results"}
                          </Button>
                        ) : null}
                        {campaign.status === "draft" && !campaign.approvalIssueId ? (
                          <Button type="button" style={{ height: 28, fontSize: 12 }} onClick={() => void run(() => requestApproval({ campaignId: campaign.id }), "Approval requested — mark the approval issue done to approve")}>Request approval</Button>
                        ) : null}
                        {campaign.status === "draft" && campaign.approvalIssueId && campaign.approvalStatus !== "done" ? (
                          <StatusBadge label="Awaiting approval" status="pending" />
                        ) : null}
                        {(campaign.status === "draft" && campaign.approvalStatus === "done") || campaign.status === "paused" ? (
                          <Button type="button" style={{ height: 28, fontSize: 12 }} onClick={() => void run(() => launch({ campaignId: campaign.id }), "Campaign launched")}>Launch</Button>
                        ) : null}
                        {campaign.status === "active" || campaign.status === "scheduled" ? (
                          <Button type="button" variant="secondary" style={{ height: 28, fontSize: 12 }} onClick={() => void run(() => pause({ campaignId: campaign.id }), "Campaign paused")}>Pause</Button>
                        ) : null}
                        {campaign.status === "paused" ? (
                          <Button type="button" variant="secondary" style={{ height: 28, fontSize: 12 }} onClick={() => void run(() => resume({ campaignId: campaign.id }), "Campaign resumed")}>Resume</Button>
                        ) : null}
                        {campaign.status === "active" || campaign.status === "paused" ? (
                          <Button type="button" variant="secondary" style={{ height: 28, fontSize: 12 }} onClick={() => void run(() => complete({ campaignId: campaign.id }), "Campaign completed")}>Complete</Button>
                        ) : null}
                      </div>
                    );
                  },
                },
              ]}
              rows={campaigns.map((c) => ({ ...c, audience: audienceLabel(c), deliveryLabel: c.delivery === "email" ? "Email" : "Issue", enrolled: c.stats.enrolled, steps: c.steps.length }))}
              emptyMessage="No campaigns match."
            />
          )}
        </div>
      ) : null}

      <Modal
        open={create === "campaign"}
        title={scope ? `New campaign for ${clientName}` : "New campaign"}
        onClose={() => setCreate(null)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
            <Button type="button" onClick={() => void run(async () => {
              await createCampaign({
                name,
                description,
                audienceTags: showTags ? audienceTags.split(",").map((tag) => tag.trim()).filter(Boolean) : [],
                delivery,
                ...(scope ? { client: scope, audienceMode } : {}),
              });
              setName("");
              setDescription("");
              setAudienceTags("");
            }, "Campaign created")}>Create</Button>
          </>
        )}
      >
        <Field label="Name"><Input value={name} onChange={(event) => setName(event.target.value)} required /></Field>
        <Field label="Description"><TextArea value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
        <Field label="Due steps">
          <Select value={delivery} onChange={(event) => setDelivery(event.target.value === "email" ? "email" : "issue")}>
            <option value="issue">Open an issue; a person sends the email</option>
            <option value="email">Send from the Mailbox after approval</option>
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
      </Modal>

      <Modal open={create === "step"} title="Add campaign step" onClose={() => setCreate(null)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
          <Button type="button" onClick={() => void run(() => addStep({
            campaignId: selectedCampaignId,
            subject: stepSubject,
            body: stepBody,
            delayDays: Number(stepDelay || 0),
          }), "Step added")}>Add step</Button>
        </>
      )}>
        <Field label="Subject"><Input value={stepSubject} onChange={(event) => setStepSubject(event.target.value)} required /></Field>
        <Field label="Body"><TextArea value={stepBody} onChange={(event) => setStepBody(event.target.value)} /></Field>
        <Field label="Delay (days)"><Input value={stepDelay} onChange={(event) => setStepDelay(event.target.value)} /></Field>
      </Modal>

      <Modal open={create === "ab"} title="A/B results" onClose={() => setCreate(null)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Close</Button>
          <Button type="button" variant={ab?.suggestion === "a" ? "primary" : "secondary"} disabled={!ab} onClick={() => void run(() => declareWinner({ campaignId: selectedCampaignId, winner: "a" }), "A declared the winner")}>Declare A</Button>
          <Button type="button" variant={ab?.suggestion === "b" ? "primary" : "secondary"} disabled={!ab} onClick={() => void run(() => declareWinner({ campaignId: selectedCampaignId, winner: "b" }), "B declared the winner")}>Declare B</Button>
        </>
      )}>
        {ab ? (
          <div style={{ display: "grid", gap: 10, fontSize: 13 }}>
            <StatRow>
              <MetricCard label="A replies" value={`${ab.replies.a}/${ab.sends.a}`} />
              <MetricCard label="B replies" value={`${ab.replies.b}/${ab.sends.b}`} />
            </StatRow>
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
            ownLabel="PiB campaigns"
            actions={newCampaignButton}
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
      description="PiB's own email programs. A client's campaigns live in that client's workspace — open the client from the CRM."
      message={pageMessage}
      actions={newCampaignButton}
    >
      {body}
    </Page>
  );
}

export function CampaignsSidebar({ context }: PluginSidebarProps) {
  // Hidden when the company switched Campaigns off in Setup; shown while loading.
  const enabled = useModuleEnabled(context.companyId, PLUGIN_ID);
  if (enabled === false) return null;
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
