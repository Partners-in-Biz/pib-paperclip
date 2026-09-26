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
  BarChart,
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  Page,
  Select,
  StatRow,
  Tabs,
  Toolbar,
  errorText,
} from "@partnersinbiz/pib-plugin-ui";

interface LinkRow { id: string; company_a_id: string; company_b_id: string; status: string }
interface GrantRow { id: string; record_type: string; record_id: string; status: string; grantee_company_id: string }
interface ShareResult {
  share: { plugin: "crm"; recordType: string; recordId: string; granteeCompanyId: string } | { plugin: "billing"; invoiceId: string; granteeCompanyId: string };
}
type TabId = "overview" | "links" | "grants";
type CreateKind = "link" | null;

export function PartnersPage({ context }: PluginPageProps) {
  const load = usePluginAction("partners.load");
  const proposeLink = usePluginAction("partners.propose-link");
  const acceptLink = usePluginAction("partners.accept-link");
  const acceptGrant = usePluginAction("partners.accept-grant");
  const revokeGrant = usePluginAction("partners.revoke-grant");
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<TabId>("overview");
  const [search, setSearch] = useState("");
  const [create, setCreate] = useState<CreateKind>(null);
  const [otherCompanyId, setOtherCompanyId] = useState("");

  async function refresh() {
    const snapshot = (await load({})) as { links: LinkRow[]; grants: GrantRow[] };
    setLinks(snapshot.links);
    setGrants(snapshot.grants);
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
  const linkRows = useMemo(() => links.filter((row) => !q || `${row.status} ${row.company_a_id} ${row.company_b_id}`.toLowerCase().includes(q)), [links, q]);
  const grantRows = useMemo(() => grants.filter((row) => !q || `${row.status} ${row.record_type} ${row.record_id}`.toLowerCase().includes(q)), [grants, q]);
  const pendingLinks = links.filter((row) => row.status === "pending" || row.status === "proposed").length;
  const openGrants = grants.filter((row) => row.status === "proposed").length;

  return (
    <Page
      title="Partners"
      description="Both companies accept a link. A grant names one record. The record stays where it is."
      message={message}
      actions={<Button type="button" onClick={() => setCreate("link")}>+ Propose link</Button>}
    >
      <Tabs
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "links", label: `Links (${links.length})` },
          { id: "grants", label: `Grants (${grants.length})` },
        ]}
        active={tab}
        onChange={(id) => { setTab(id as TabId); setSearch(""); }}
      />

      {tab === "overview" ? (
        <div style={{ display: "grid", gap: 16 }}>
          <StatRow>
            <MetricCard label="Links" value={links.length} />
            <MetricCard label="Pending links" value={pendingLinks} />
            <MetricCard label="Grants" value={grants.length} />
            <MetricCard label="Open grants" value={openGrants} />
          </StatRow>
          <BarChart
            title="Link status"
            items={Object.entries(links.reduce<Record<string, number>>((acc, row) => {
              acc[row.status] = (acc[row.status] ?? 0) + 1;
              return acc;
            }, {})).map(([label, value]) => ({ label, value }))}
          />
        </div>
      ) : null}

      {tab === "links" ? (
        <div style={{ display: "grid", gap: 12 }}>
          <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search links…">
            <Button type="button" onClick={() => setCreate("link")}>+ Propose link</Button>
          </Toolbar>
          {linkRows.length === 0 ? (
            <EmptyState title="No partner links yet" description="Propose a link with another Paperclip company." action={<Button type="button" onClick={() => setCreate("link")}>+ Propose link</Button>} />
          ) : (
            <DataTable
              columns={[
                { key: "company_a_id", header: "Company A" },
                { key: "company_b_id", header: "Company B" },
                { key: "status", header: "Status", render: (value) => <StatusBadge label={String(value)} status={value === "active" || value === "accepted" ? "ok" : "pending"} /> },
                {
                  key: "id",
                  header: "",
                  width: "110px",
                  render: (_value, row) => (
                    <Button type="button" style={{ height: 28, fontSize: 12 }} onClick={() => void run(() => acceptLink({ linkId: String(row.id) }), "Link acceptance saved")}>
                      Accept
                    </Button>
                  ),
                },
              ]}
              rows={linkRows as unknown as Record<string, unknown>[]}
              emptyMessage="No links match."
            />
          )}
        </div>
      ) : null}

      {tab === "grants" ? (
        <div style={{ display: "grid", gap: 12 }}>
          <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search grants…" />
          {grantRows.length === 0 ? (
            <EmptyState title="No grants yet" description="Grants appear when a partner proposes a named record share." />
          ) : (
            <DataTable
              columns={[
                { key: "record_type", header: "Type" },
                { key: "record_id", header: "Record" },
                { key: "status", header: "Status", render: (value) => <StatusBadge label={String(value)} status={value === "active" || value === "accepted" ? "ok" : value === "revoked" ? "info" : "pending"} /> },
                {
                  key: "id",
                  header: "",
                  width: "110px",
                  render: (_value, row) => row.status === "active" && row.source_company_id === context.companyId ? (
                    <Button
                      type="button"
                      variant="secondary"
                      style={{ height: 28, fontSize: 12 }}
                      onClick={() => void run(() => revokeGrant({ grantId: String(row.id) }), "Grant revoked")}
                    >
                      Revoke
                    </Button>
                  ) : row.status === "proposed" ? (
                    <Button
                      type="button"
                      style={{ height: 28, fontSize: 12 }}
                      onClick={() => void run(async () => {
                        const result = (await acceptGrant({ grantId: String(row.id) })) as ShareResult;
                        if (!context.companyId) throw new Error("Company is required");
                        await publishShare(result, context.companyId);
                      }, "Grant accepted")}
                    >
                      Accept
                    </Button>
                  ) : null,
                },
              ]}
              rows={grantRows as unknown as Record<string, unknown>[]}
              emptyMessage="No grants match."
            />
          )}
        </div>
      ) : null}

      <Modal open={create === "link"} title="Propose partner link" onClose={() => setCreate(null)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
          <Button type="button" onClick={() => void run(async () => {
            await proposeLink({ otherCompanyId });
            setOtherCompanyId("");
          }, "Link proposed")}>Propose</Button>
        </>
      )}>
        <Field label="Other Paperclip company id">
          <Input value={otherCompanyId} onChange={(event) => setOtherCompanyId(event.target.value)} required />
        </Field>
      </Modal>
    </Page>
  );
}

async function publishShare(result: ShareResult, companyId: string): Promise<void> {
  const share = result.share;
  const path = share.plugin === "crm" ? "/api/plugins/partnersinbiz.crm/api/grants" : "/api/plugins/partnersinbiz.billing/api/grants";
  const body = share.plugin === "crm"
    ? { companyId, recordType: share.recordType, recordId: share.recordId, granteeCompanyId: share.granteeCompanyId }
    : { companyId, invoiceId: share.invoiceId, granteeCompanyId: share.granteeCompanyId };
  const response = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error ?? "The grant was accepted, and the record share did not land");
  }
}

export function PartnersSidebar(_props: PluginSidebarProps) {
  return (
    <SidebarNavLink to="/partners" label="Partners" icon={(
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 11h-6" />
        <path d="M19 8v6" />
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
