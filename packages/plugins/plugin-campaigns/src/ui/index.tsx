import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DataTable,
  MetricCard,
  StatusBadge,
  useHostNavigation,
  usePluginAction,
  type PluginPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  Button,
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
} from "@partnersinbiz/pib-plugin-ui";

interface Campaign {
  id: string;
  name: string;
  description: string;
  status: string;
  fromName: string;
  fromLocal: string;
  audienceTags: string[];
  steps: Array<{ position: number; delayDays: number; subject: string; body: string }>;
  stats: { enrolled: number; running: number; done: number };
}

interface Snapshot { campaigns: Campaign[] }
type TabId = "overview" | "campaigns";
type CreateKind = "campaign" | "step" | null;

export function CampaignsPage({ context }: PluginPageProps) {
  const load = usePluginAction("campaigns.load");
  const createCampaign = usePluginAction("campaigns.create-campaign");
  const addStep = usePluginAction("campaigns.add-step");
  const launch = usePluginAction("campaigns.launch");
  const pause = usePluginAction("campaigns.pause");
  const resume = usePluginAction("campaigns.resume");
  const complete = usePluginAction("campaigns.complete");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<TabId>("overview");
  const [search, setSearch] = useState("");
  const [create, setCreate] = useState<CreateKind>(null);
  const [selectedCampaignId, setSelectedCampaignId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [audienceTags, setAudienceTags] = useState("");
  const [stepSubject, setStepSubject] = useState("");
  const [stepBody, setStepBody] = useState("");
  const [stepDelay, setStepDelay] = useState("0");

  async function refresh() {
    setSnapshot((await load({})) as Snapshot);
  }

  useEffect(() => {
    if (!context.companyId) return;
    refresh().catch((error: unknown) => setMessage(errorText(error)));
  }, [context.companyId]);

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

  const q = search.trim().toLowerCase();
  const campaigns = useMemo(() => (snapshot?.campaigns ?? []).filter((c) => !q || c.name.toLowerCase().includes(q) || c.status.includes(q)), [snapshot, q]);
  const totalEnrolled = (snapshot?.campaigns ?? []).reduce((sum, c) => sum + c.stats.enrolled, 0);
  const activeCount = (snapshot?.campaigns ?? []).filter((c) => c.status === "active").length;

  return (
    <Page
      title="Campaigns"
      description="Themed email programs that enroll contacts and open Paperclip issues for each due step."
      message={message}
      actions={<Button type="button" onClick={() => setCreate("campaign")}>+ New campaign</Button>}
    >
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
            <Button type="button" onClick={() => setCreate("campaign")}>+ New campaign</Button>
          </Toolbar>
          {campaigns.length === 0 ? (
            <EmptyState title="No campaigns yet" description="Create a campaign, add email steps, then launch it to enroll matching contacts." action={<Button type="button" onClick={() => setCreate("campaign")}>+ New campaign</Button>} />
          ) : (
            <DataTable
              columns={[
                { key: "name", header: "Campaign" },
                { key: "status", header: "Status", render: (value) => <StatusBadge label={String(value)} status={value === "active" ? "ok" : value === "draft" ? "pending" : "info"} /> },
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
                        {campaign.status === "draft" || campaign.status === "paused" ? (
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
              rows={campaigns.map((c) => ({ ...c, enrolled: c.stats.enrolled, steps: c.steps.length }))}
              emptyMessage="No campaigns match."
            />
          )}
        </div>
      ) : null}

      <Modal open={create === "campaign"} title="New campaign" onClose={() => setCreate(null)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
          <Button type="button" onClick={() => void run(async () => {
            await createCampaign({
              name,
              description,
              audienceTags: audienceTags.split(",").map((tag) => tag.trim()).filter(Boolean),
            });
            setName("");
            setDescription("");
            setAudienceTags("");
          }, "Campaign created")}>Create</Button>
        </>
      )}>
        <Field label="Name"><Input value={name} onChange={(event) => setName(event.target.value)} required /></Field>
        <Field label="Description"><TextArea value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
        <Field label="Audience tags (comma separated)"><Input value={audienceTags} onChange={(event) => setAudienceTags(event.target.value)} placeholder="hot, prospect" /></Field>
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
    </Page>
  );
}

export function CampaignsSidebar(_props: PluginSidebarProps) {
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
