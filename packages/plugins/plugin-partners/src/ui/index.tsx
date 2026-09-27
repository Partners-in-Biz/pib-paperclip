import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DataTable,
  useHostNavigation,
  usePluginAction,
  type PluginPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  Activity,
  BarChart,
  Button,
  Building2,
  EmptyState,
  Field,
  Handshake,
  Input,
  KeyRound,
  KpiCard,
  LayoutDashboard,
  Hourglass,
  Modal,
  Page,
  Pill,
  SectionCard,
  StackedBar,
  Timeline,
  Tabs,
  Toolbar,
  errorText,
  fluidColumns,
  tokens,
  type TimelineItem,
  type ToneInput,
} from "@partnersinbiz/pib-plugin-ui";
import { useGroupedNav } from "@partnersinbiz/pib-plugin-ui";
import { resolvePluginUiBase } from "@partnersinbiz/pib-plugin-kit/oauth-client";
import { ModuleOffBanner, useModuleEnabled } from "./module-switch.js";
import { acceptedByMe, partnerSummary, recordKind } from "../series.js";

const PLUGIN_ID = "partnersinbiz.partners";

interface LinkRow { id: string; company_a_id: string; company_b_id: string; status: string; accepted_a?: boolean; accepted_b?: boolean; created_at?: string | null }
interface GrantRow { id: string; record_type: string; record_id: string; status: string; source_company_id?: string; grantee_company_id: string; created_at?: string | null }

/** Active: done (green). Pending or proposed: waiting (amber). Revoked: gone (grey). */
const STATUS_TONE: Record<string, ToneInput> = { active: "ok", accepted: "ok", pending: "warn", proposed: "warn", revoked: "neutral" };
const STATUS_LABEL: Record<string, string> = { active: "Active", accepted: "Accepted", pending: "Pending", proposed: "Proposed", revoked: "Revoked" };
const KIND_LABEL: Record<string, string> = { company: "Companies", contact: "Contacts", deal: "Deals", invoice: "Invoices" };

function StatusPill({ status }: { status: string }) {
  return <Pill tone={STATUS_TONE[status] ?? "neutral"} dot>{STATUS_LABEL[status] ?? status}</Pill>;
}

/** A company id as a short, readable label. */
function companyLabel(id: string, me: string | null | undefined): string {
  if (id === me) return "This company";
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}
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
    const snapshot = (await load({ uiBase: await resolvePluginUiBase(PLUGIN_ID, import.meta.url) })) as { links: LinkRow[]; grants: GrantRow[] };
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
  const summary = useMemo(() => partnerSummary(links, grants, context.companyId), [links, grants, context.companyId]);
  const me = context.companyId;
  const other = (row: LinkRow) => (row.company_a_id === me ? row.company_b_id : row.company_a_id);
  const recent: TimelineItem[] = [
    ...links.map((row) => ({
      id: `l:${row.id}`,
      at: row.created_at ?? null,
      title: `Link with ${companyLabel(other(row), me)}`,
      meta: <StatusPill status={row.status} />,
      tone: STATUS_TONE[row.status] ?? "neutral",
      icon: Handshake,
    })),
    ...grants.map((row) => ({
      id: `g:${row.id}`,
      at: row.created_at ?? null,
      title: `${row.grantee_company_id === me ? "Shared with you" : `Shared with ${companyLabel(row.grantee_company_id, me)}`}: ${recordKind(row.record_type)}`,
      meta: <StatusPill status={row.status} />,
      detail: <span title={row.record_id}>{companyLabel(row.record_id, null)}</span>,
      tone: STATUS_TONE[row.status] ?? "neutral",
      icon: KeyRound,
    })),
  ].sort((a, b) => (Date.parse(String(b.at ?? "")) || 0) - (Date.parse(String(a.at ?? "")) || 0));
  const toAccept = summary.linksToAccept + summary.grantsToAccept;

  return (
    <Page
      title="Partners"
      accent="partners"
      description="Both companies accept a link. A grant names one record. The record stays where it is."
      message={message}
      actions={<Button type="button" onClick={() => setCreate("link")}>+ Propose link</Button>}
    >
      <ModuleOffBanner companyId={context.companyId} pluginKey={PLUGIN_ID} />
      <Tabs
        tabs={[
          { id: "overview", label: "Overview", icon: LayoutDashboard, count: toAccept || null, countTone: "warn" },
          { id: "links", label: "Links", icon: Handshake, count: links.length, countTone: summary.linksToAccept ? "warn" : undefined },
          { id: "grants", label: "Grants", icon: KeyRound, count: grants.length, countTone: summary.grantsToAccept ? "warn" : undefined },
        ]}
        active={tab}
        onChange={(id) => { setTab(id as TabId); setSearch(""); }}
      />

      {tab === "overview" ? (
        links.length === 0 && grants.length === 0 ? (
          <EmptyState
            title="No partners yet"
            description="Propose a link with another Paperclip company. Once both accept, you can share named records."
            action={<Button type="button" onClick={() => setCreate("link")}>+ Propose link</Button>}
          />
        ) : (
          <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
            <div style={{ display: "grid", gridTemplateColumns: fluidColumns(150), gap: 10 }}>
              <KpiCard label="Active links" value={summary.activeLinks} tone={summary.activeLinks ? "ok" : "neutral"} hint={`${links.length} in total`} icon={Handshake} />
              <KpiCard label="Links to accept" value={summary.linksToAccept} tone={summary.linksToAccept ? "warn" : "neutral"} hint={summary.pendingLinks ? `${summary.pendingLinks} pending` : "None pending"} icon={Hourglass} />
              <KpiCard label="Records shared" value={summary.activeGrants} hint={summary.revokedGrants ? `${summary.revokedGrants} revoked` : "Active grants"} icon={KeyRound} />
              <KpiCard label="Grants to accept" value={summary.grantsToAccept} tone={summary.grantsToAccept ? "warn" : "neutral"} hint={summary.grantsToAccept ? "Shared with you" : "Nothing waiting"} icon={KeyRound} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: fluidColumns(300), gap: 16, alignItems: "start" }}>
              <SectionCard title="Shared records" icon={KeyRound} subtitle="Active grants by record type and by partner.">
                <StackedBar
                  title="Grants by status"
                  segments={[
                    { key: "active", label: "Active", value: summary.activeGrants, tone: "ok" },
                    { key: "proposed", label: "Proposed", value: grants.filter((g) => g.status === "proposed").length, tone: "warn" },
                    { key: "revoked", label: "Revoked", value: summary.revokedGrants, tone: "neutral" },
                  ]}
                />
                {summary.byType.length === 0 ? <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>No record is shared yet.</p> : (
                  <>
                    <BarChart bare title="By type" items={summary.byType.map((row) => ({ label: KIND_LABEL[row.type] ?? row.type, value: row.count }))} />
                    <BarChart bare title="By partner" items={summary.byPartner.slice(0, 8).map((row) => ({ label: companyLabel(row.companyId, me), value: row.count, tone: "accent" as const }))} />
                  </>
                )}
              </SectionCard>
              <SectionCard title="Recent" icon={Activity} subtitle="Links and grants, newest first.">
                <Timeline items={recent} limit={8} empty="Nothing yet." />
              </SectionCard>
            </div>
          </div>
        )
      ) : null}

      {tab === "links" ? (
        <div style={{ display: "grid", gap: 12 }}>
          <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search links…">
            <Button type="button" onClick={() => setCreate("link")}>+ Propose link</Button>
          </Toolbar>
          {linkRows.length === 0 ? (
            <EmptyState title="No partner links yet" icon={Handshake} description="Propose a link with another Paperclip company." action={<Button type="button" onClick={() => setCreate("link")}>+ Propose link</Button>} />
          ) : (
            <DataTable
              columns={[
                { key: "company_a_id", header: "Company A", render: (value) => <CompanyId id={String(value)} me={me} /> },
                { key: "company_b_id", header: "Company B", render: (value) => <CompanyId id={String(value)} me={me} /> },
                { key: "status", header: "Status", render: (value, row) => (
                  <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                    <StatusPill status={String(value)} />
                    {value !== "active" && acceptedByMe(row as unknown as LinkRow, me) ? <Pill size="sm">Waiting for partner</Pill> : null}
                  </span>
                ) },
                {
                  key: "id",
                  header: "",
                  width: "110px",
                  render: (_value, row) => row.status === "active" ? null : (
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
            <EmptyState title="No grants yet" icon={KeyRound} description="Grants appear when a partner proposes a named record share." />
          ) : (
            <DataTable
              columns={[
                { key: "record_type", header: "Type", render: (value) => <Pill tone="accent">{recordKind(String(value))}</Pill> },
                { key: "record_id", header: "Record", render: (value) => <span style={{ overflowWrap: "anywhere", fontVariantNumeric: "tabular-nums" }}>{String(value)}</span> },
                { key: "status", header: "Status", render: (value) => <StatusPill status={String(value)} /> },
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

function CompanyId({ id, me }: { id: string; me: string | null | undefined }) {
  return (
    <span title={id} style={{ display: "inline-flex", gap: 6, alignItems: "center", minWidth: 0, overflowWrap: "anywhere" }}>
      <Building2 size={13} color={tokens.muted} aria-hidden="true" style={{ flexShrink: 0 }} />
      {id === me ? <strong>This company</strong> : id}
    </span>
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

export function PartnersSidebar({ context }: PluginSidebarProps) {
  // Hidden when the company switched Partners off in Setup; shown while loading.
  const enabled = useModuleEnabled(context.companyId, PLUGIN_ID);
  // The Cockpit's Clients / Marketing / Finance group shows this page instead (pib-plugin-ui NAV_GROUPS).
  const grouped = useGroupedNav("partnersinbiz.partners");
  if (enabled === false || grouped !== false) return null;
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
