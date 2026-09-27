import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useHostLocation,
  DataTable,
  useHostNavigation,
  usePluginAction,
  type PluginPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  Select,
  Activity,
  BarChart,
  Button,
  Building2,
  CompactRows,
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
  formatDate,
  formatShortDate,
  tokens,
  useIsNarrow,
  type TimelineItem,
  type ToneInput,
} from "@partnersinbiz/pib-plugin-ui";
import { GetStarted, useGroupedNav, usePluginSetupStatus, useUrlTab } from "@partnersinbiz/pib-plugin-ui";
import { resolvePluginUiBase } from "@partnersinbiz/pib-plugin-kit/oauth-client";
import { ModuleOffBanner, useModuleEnabled } from "./module-switch.js";
import { acceptedByMe, linkState, otherCompany, partnerSummary } from "../series.js";
import { crmDirectory, emptyDirectory, invoiceName, lookupsFor, recordLabel, type RecordDirectory, type RecordLabel } from "../records.js";

const PLUGIN_ID = "partnersinbiz.partners";

interface LinkRow { id: string; company_a_id: string; company_b_id: string; status: string; accepted_a?: boolean; accepted_b?: boolean; created_at?: string | null }
interface GrantRow { id: string; record_type: string; record_id: string; status: string; source_company_id?: string; grantee_company_id: string; created_at?: string | null }
interface CompanyLite { id: string; name: string; prefix: string | null }

const LINK_STATE: Record<ReturnType<typeof linkState>, { label: string; tone: ToneInput }> = {
  active: { label: "Active", tone: "ok" },
  "waiting-for-you": { label: "Waiting for you", tone: "warn" },
  "waiting-for-partner": { label: "Waiting for partner", tone: "neutral" },
};
const KIND_LABEL: Record<string, string> = { company: "Companies", contact: "Contacts", deal: "Deals", invoice: "Invoices" };

/** A grant's state from this company's side. */
function grantState(grant: GrantRow, me: string | null | undefined): { label: string; tone: ToneInput } {
  if (grant.status === "revoked") return { label: "Stopped", tone: "neutral" };
  if (grant.status === "active") return { label: "Shared", tone: "ok" };
  return grant.source_company_id === me ? { label: "Needs your yes", tone: "warn" } : { label: "Waiting for them", tone: "neutral" };
}

/** Companies the signed-in person can see (host `GET /api/companies`), shared by the whole page. */
let companiesPromise: Promise<CompanyLite[]> | null = null;
function fetchCompanies(): Promise<CompanyLite[]> {
  companiesPromise ??= fetch("/api/companies", { credentials: "include" })
    .then(async (res) => (res.ok ? await res.json() : []))
    .then((body: unknown) => {
      const list = Array.isArray(body) ? body : ((body as { companies?: unknown[]; data?: unknown[] })?.companies ?? (body as { data?: unknown[] })?.data ?? []);
      return (list as Array<Record<string, unknown>>)
        .filter((c) => typeof c.id === "string" && typeof c.name === "string")
        .map((c) => ({ id: String(c.id), name: String(c.name), prefix: typeof c.issuePrefix === "string" ? c.issuePrefix : null }));
    })
    .catch(() => []);
  return companiesPromise;
}

function useCompanies(): CompanyLite[] {
  const [companies, setCompanies] = useState<CompanyLite[]>([]);
  useEffect(() => {
    let live = true;
    void fetchCompanies().then((list) => {
      if (live) setCompanies(list);
    });
    return () => {
      live = false;
    };
  }, []);
  return companies;
}

/** Runs another PiB plugin's page action with the signed-in person's access (the same call the Setup page uses). */
async function pluginAction(pluginKey: string, actionKey: string, companyId: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const res = await fetch(`/api/plugins/${encodeURIComponent(pluginKey)}/actions/${encodeURIComponent(actionKey)}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ companyId, params }),
  });
  const body = await res.json().catch(() => null) as { data?: unknown } | null;
  if (!res.ok) throw new Error(`${pluginKey} ${actionKey} failed (${res.status})`);
  return body && typeof body === "object" && "data" in body ? body.data : body;
}

/**
 * Names for the shared records: the CRM once (companies, contacts, deals) and
 * Billing per invoice. Null while loading; a module that is missing or fails
 * leaves its records unnamed ("A company (name not available)").
 */
function useRecordDirectory(companyId: string | null | undefined, grants: GrantRow[]): RecordDirectory | null {
  const [directory, setDirectory] = useState<RecordDirectory | null>(null);
  const key = grants.map((grant) => `${grant.record_type}:${grant.record_id}`).sort().join(",");
  useEffect(() => {
    if (!companyId || grants.length === 0) {
      setDirectory(emptyDirectory());
      return;
    }
    let live = true;
    const { crm, invoiceIds } = lookupsFor(grants);
    void (async () => {
      const found = emptyDirectory();
      if (crm) {
        try {
          Object.assign(found, crmDirectory(await pluginAction("partnersinbiz.crm", "crm.load", companyId)));
        } catch {
          // CRM not installed or not reachable: names stay unknown
        }
      }
      for (const invoiceId of invoiceIds) {
        try {
          const name = invoiceName(await pluginAction("partnersinbiz.billing", "billing.invoice-detail", companyId, { invoiceId }));
          if (name) found.invoices.set(invoiceId, name);
        } catch {
          // not visible here (or Billing is off)
        }
      }
      if (live) setDirectory(found);
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, key]);
  return directory;
}

interface ShareResult {
  share: { plugin: "crm"; recordType: string; recordId: string; granteeCompanyId: string } | { plugin: "billing"; invoiceId: string; granteeCompanyId: string };
}
type TabId = "overview" | "links" | "grants";
const OTHER_ID = "__other__";
type Open = { kind: "link"; id: string } | { kind: "grant"; id: string } | null;

export function PartnersPage({ context }: PluginPageProps) {
  const load = usePluginAction("partners.load");
  const proposeLink = usePluginAction("partners.propose-link");
  const acceptLink = usePluginAction("partners.accept-link");
  const acceptGrant = usePluginAction("partners.accept-grant");
  const revokeGrant = usePluginAction("partners.revoke-grant");
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [known, setKnown] = useState<CompanyLite[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const hostLocation = useHostLocation();
  const hostNavigation = useHostNavigation();
  const narrow = useIsNarrow();
  // `?tab=` opens a tab and switching tabs updates the address, so links can point at a tab.
  const [tab, setTab] = useUrlTab<TabId>(["overview", "links", "grants"], "overview", { path: "/partners", search: hostLocation.search, navigate: hostNavigation.navigate });
  // "Finish setting up Partners" on the overview until its required setup is done.
  const setupStatus = usePluginSetupStatus(PLUGIN_ID, context.companyId);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  const [otherCompanyId, setOtherCompanyId] = useState("");
  const [pickOther, setPickOther] = useState("");
  const companies = useCompanies();
  const directory = useRecordDirectory(context.companyId, grants);
  const me = context.companyId;

  // Names from the worker first (it knows partners this person is not a member of), then the person's own list.
  const names = useMemo(() => {
    const map = new Map<string, CompanyLite>();
    for (const c of companies) map.set(c.id, c);
    for (const c of known) map.set(c.id, c);
    return map;
  }, [companies, known]);
  const nameOf = (id: string | null | undefined) => (id ? names.get(id)?.name : undefined) ?? (id === me ? "Your company" : "Partner company");

  async function refresh() {
    const snapshot = (await load({ uiBase: await resolvePluginUiBase(PLUGIN_ID, import.meta.url) })) as { links: LinkRow[]; grants: GrantRow[]; companies?: CompanyLite[] };
    setLinks(snapshot.links);
    setGrants(snapshot.grants);
    setKnown(snapshot.companies ?? []);
    setLoaded(true);
  }

  useEffect(() => {
    if (!context.companyId) return;
    refresh().catch((error: unknown) => {
      setMessage(errorText(error));
      setLoaded(true);
    });
  }, [context.companyId]);

  async function run(work: () => Promise<unknown>, success: string) {
    setMessage("");
    setBusy(true);
    try {
      await work();
      await refresh();
      setMessage(success);
      setCreating(false);
      setOpen(null);
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  const labelOf = (grant: GrantRow): RecordLabel | null => (directory ? recordLabel(grant, directory) : null);
  const q = search.trim().toLowerCase();
  const linkRows = useMemo(
    () => links.filter((row) => !q || `${nameOf(otherCompany(row, me))} ${LINK_STATE[linkState(row, me)].label}`.toLowerCase().includes(q)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [links, q, names, me],
  );
  const grantRows = useMemo(
    () => grants.filter((row) => {
      if (!q) return true;
      const partner = nameOf(row.source_company_id === me ? row.grantee_company_id : row.source_company_id);
      return `${labelOf(row)?.text ?? row.record_type} ${partner} ${grantState(row, me).label}`.toLowerCase().includes(q);
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [grants, q, names, me, directory],
  );
  const summary = useMemo(() => partnerSummary(links, grants, me), [links, grants, me]);
  const hasData = links.length + grants.length > 0;

  function grantTitle(grant: GrantRow): string {
    const label = labelOf(grant);
    const what = label ? (label.found ? label.text : `A ${label.kindWord}`) : "A record";
    return grant.source_company_id === me
      ? `${what} shared with ${nameOf(grant.grantee_company_id)}`
      : `${nameOf(grant.source_company_id)} shared ${what} with you`;
  }
  const recent: TimelineItem[] = [
    ...links.map((row) => ({
      id: `l:${row.id}`,
      at: row.created_at ?? null,
      title: `Link with ${nameOf(otherCompany(row, me))}`,
      meta: <StatePill {...LINK_STATE[linkState(row, me)]} />,
      tone: LINK_STATE[linkState(row, me)].tone,
      icon: Handshake,
    })),
    ...grants.map((row) => {
      const label = labelOf(row);
      return {
        id: `g:${row.id}`,
        at: row.created_at ?? null,
        title: grantTitle(row),
        meta: <StatePill {...grantState(row, me)} />,
        tone: grantState(row, me).tone,
        icon: KeyRound,
        link: label?.found && label.href ? (hostNavigation.linkProps(label.href) as unknown as TimelineItem["link"]) : null,
      };
    }),
  ].sort((a, b) => (Date.parse(String(b.at ?? "")) || 0) - (Date.parse(String(a.at ?? "")) || 0));

  const proposeButton = <Button type="button" onClick={() => setCreating(true)}>+ Propose link</Button>;
  // One main action: in the header while there are links (not on the shared records tab), else in the empty state.
  const headerAction = loaded && links.length > 0 && tab !== "grants" ? proposeButton : undefined;
  const openLink = open?.kind === "link" ? links.find((row) => row.id === open.id) ?? null : null;
  const openGrant = open?.kind === "grant" ? grants.find((row) => row.id === open.id) ?? null : null;
  const tabLink = (id: TabId) => hostNavigation.linkProps(`/partners?tab=${id}`) as unknown as { href: string; onClick: (event: ReactMouseEvent<HTMLAnchorElement>) => void };

  function acceptGrantNow(grant: GrantRow) {
    void run(async () => {
      const result = (await acceptGrant({ grantId: grant.id })) as ShareResult;
      if (!context.companyId) throw new Error("Company is required");
      await publishShare(result, context.companyId);
    }, `Shared: ${nameOf(grant.grantee_company_id)} can see ${labelOf(grant)?.name ?? "this record"} now.`);
  }
  function revokeGrantNow(grant: GrantRow) {
    const what = labelOf(grant)?.name ?? "this record";
    if (!window.confirm(`Stop sharing ${what} with ${nameOf(grant.grantee_company_id)}? They lose access at once.`)) return;
    void run(() => revokeGrant({ grantId: grant.id }), `Stopped sharing ${what}.`);
  }
  function acceptLinkNow(link: LinkRow) {
    void run(() => acceptLink({ linkId: link.id }), `Accepted. ${linkState({ ...link, ...(link.company_a_id === me ? { accepted_a: true } : { accepted_b: true }) }, me) === "active" ? "The link is active." : `Now waiting for ${nameOf(otherCompany(link, me))}.`}`);
  }

  function recordCell(grant: GrantRow): ReactNode {
    const label = labelOf(grant);
    if (!label) return <span style={{ color: tokens.muted }}>Loading…</span>;
    return <RecordName label={label} id={grant.record_id} linkFor={(href) => hostNavigation.linkProps(href) as unknown as Record<string, unknown>} />;
  }

  return (
    <Page
      title="Partners"
      accent="partners"
      description="Share chosen records with partner companies. Nothing is copied, and you can stop sharing at any time."
      message={message}
      actions={headerAction}
    >
      <ModuleOffBanner companyId={context.companyId} pluginKey={PLUGIN_ID} />
      <Tabs
        tabs={[
          { id: "overview", label: "Overview", icon: LayoutDashboard },
          { id: "links", label: "Partner links", icon: Handshake, count: summary.linksToAccept || null, countTone: "warn" },
          { id: "grants", label: "Shared records", icon: KeyRound, count: summary.grantsToAccept || null, countTone: "warn" },
        ]}
        active={tab}
        onChange={(id) => { setTab(id as TabId); setSearch(""); }}
      />

      {tab === "overview" ? <GetStarted status={setupStatus} hasData={hasData} moduleName="Partners" linkFor={(href) => hostNavigation.linkProps(href) as unknown as Record<string, unknown>} /> : null}
      {tab === "overview" ? (
        !loaded ? <Muted>Loading partners…</Muted> : !hasData ? (
          <EmptyState
            title="No partners yet"
            description="Propose a link with another Paperclip company. Once both of you accept, you can share chosen records with them."
            action={proposeButton}
          />
        ) : (
          <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
            <div style={{ display: "grid", gridTemplateColumns: fluidColumns(150), gap: 10 }}>
              <KpiCard label="Active links" value={summary.activeLinks} tone={summary.activeLinks ? "ok" : "neutral"} hint={summary.pendingLinks ? `${summary.pendingLinks} waiting` : "None waiting"} icon={Handshake} link={tabLink("links")} />
              <KpiCard label="Links to accept" value={summary.linksToAccept} tone={summary.linksToAccept ? "warn" : "neutral"} hint={summary.linksToAccept ? "Waiting for your yes" : "Nothing to accept"} icon={Hourglass} link={tabLink("links")} />
              <KpiCard label="Records shared" value={summary.activeGrants} hint={summary.revokedGrants ? `${summary.revokedGrants} stopped` : "Shared right now"} icon={KeyRound} link={tabLink("grants")} />
              <KpiCard label="Shares to accept" value={summary.grantsToAccept} tone={summary.grantsToAccept ? "warn" : "neutral"} hint={summary.grantsToAccept ? "Our records waiting for your yes" : summary.grantsIncoming ? `${summary.grantsIncoming} from partners, waiting for them` : "Nothing waiting"} icon={KeyRound} link={tabLink("grants")} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: fluidColumns(300), gap: 16, alignItems: "start" }}>
              <SectionCard title="Shared records" icon={KeyRound} subtitle="What is shared, by kind and by partner.">
                <StackedBar
                  title="Shares by state"
                  segments={[
                    { key: "active", label: "Shared", value: summary.activeGrants, tone: "ok" },
                    { key: "proposed", label: "Waiting for a yes", value: grants.filter((g) => g.status === "proposed").length, tone: "warn" },
                    { key: "revoked", label: "Stopped", value: summary.revokedGrants, tone: "neutral" },
                  ]}
                />
                {summary.byType.length === 0 ? <Muted>No record is shared yet.</Muted> : (
                  <>
                    <BarChart bare title="By kind" items={summary.byType.map((row) => ({ label: KIND_LABEL[row.type] ?? row.type, value: row.count }))} />
                    <BarChart bare title="By partner" items={summary.byPartner.slice(0, 8).map((row) => ({ label: nameOf(row.companyId), value: row.count, tone: "accent" as const }))} />
                  </>
                )}
              </SectionCard>
              <SectionCard title="Recent" icon={Activity} subtitle="Links and shares, newest first.">
                <Timeline items={recent} limit={8} empty="Nothing yet." />
              </SectionCard>
            </div>
          </div>
        )
      ) : null}

      {tab === "links" ? (
        <div style={{ display: "grid", gap: 12 }}>
          {links.length > 3 ? <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search partners…" /> : null}
          {!loaded ? <Muted>Loading partner links…</Muted> : links.length === 0 ? (
            <EmptyState title="No partner links yet" icon={Handshake} description="Propose a link with another Paperclip company. It becomes active once both of you accept." action={proposeButton} />
          ) : narrow ? (
            <CompactRows
              label="Partner links"
              rows={linkRows}
              title={(row) => nameOf(otherCompany(row, me))}
              meta={(row) => `Since ${formatShortDate(row.created_at)}`}
              trailing={(row) => <StatePill {...LINK_STATE[linkState(row, me)]} />}
              onOpen={(row) => setOpen({ kind: "link", id: row.id })}
              empty="No links match."
            />
          ) : (
            <DataTable
              columns={[
                { key: "partner", header: "Partner", render: (_value, row) => {
                  const link = row as unknown as LinkRow;
                  return <CompanyName name={nameOf(otherCompany(link, me))} detail={`Since ${formatShortDate(link.created_at)}`} />;
                } },
                { key: "status", header: "Status", render: (_value, row) => <StatePill {...LINK_STATE[linkState(row as unknown as LinkRow, me)]} /> },
                { key: "id", header: "Your company", width: "170px", render: (_value, row) => {
                  const link = row as unknown as LinkRow;
                  return acceptedByMe(link, me)
                    ? <span style={{ fontSize: 13, color: tokens.muted }}>Accepted</span>
                    : <Button type="button" disabled={busy} style={{ height: 30, fontSize: 12.5 }} onClick={() => acceptLinkNow(link)}>Accept</Button>;
                } },
              ]}
              rows={linkRows.map((row) => ({ ...row, partner: nameOf(otherCompany(row, me)) })) as unknown as Record<string, unknown>[]}
              emptyMessage="No links match."
            />
          )}
        </div>
      ) : null}

      {tab === "grants" ? (
        <div style={{ display: "grid", gap: 12 }}>
          {grants.length > 3 ? <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search shared records…" /> : null}
          {!loaded ? <Muted>Loading shared records…</Muted> : grants.length === 0 ? (
            <EmptyState
              title="Nothing shared yet"
              icon={KeyRound}
              description={summary.activeLinks
                ? "An agent proposes a record to share with a partner. It shows up here for your yes; only then does the partner see it."
                : "Link with a partner first. Then an agent can propose records to share, and you say yes here."}
              action={summary.activeLinks ? undefined : <a {...tabLink("links")} style={{ fontSize: 13, fontWeight: 600, color: tokens.primary }}>Go to partner links</a>}
            />
          ) : narrow ? (
            <CompactRows
              label="Shared records"
              rows={grantRows}
              title={(row) => labelOf(row)?.text ?? "Loading…"}
              meta={(row) => `${row.source_company_id === me ? "With" : "From"} ${nameOf(row.source_company_id === me ? row.grantee_company_id : row.source_company_id)} · ${formatShortDate(row.created_at)}`}
              trailing={(row) => <StatePill {...grantState(row, me)} />}
              onOpen={(row) => setOpen({ kind: "grant", id: row.id })}
              empty="No shared records match."
            />
          ) : (
            <DataTable
              columns={[
                { key: "what", header: "What is shared", render: (_value, row) => recordCell(row as unknown as GrantRow) },
                { key: "partner", header: "Partner", render: (_value, row) => {
                  const grant = row as unknown as GrantRow;
                  const ours = grant.source_company_id === me;
                  return <span style={{ overflowWrap: "anywhere" }}>{ours ? `Shared with ${nameOf(grant.grantee_company_id)}` : `Shared by ${nameOf(grant.source_company_id)}`}</span>;
                } },
                { key: "since", header: "Since", width: "90px" },
                { key: "status", header: "Status", render: (_value, row) => <StatePill {...grantState(row as unknown as GrantRow, me)} /> },
                {
                  key: "id",
                  header: "",
                  width: "130px",
                  render: (_value, row) => {
                    const grant = row as unknown as GrantRow;
                    if (grant.source_company_id !== me) return null;
                    if (grant.status === "proposed") return <Button type="button" disabled={busy} style={{ height: 30, fontSize: 12.5 }} onClick={() => acceptGrantNow(grant)}>Accept</Button>;
                    if (grant.status === "active") return <Button type="button" variant="secondary" disabled={busy} style={{ height: 30, fontSize: 12.5 }} onClick={() => revokeGrantNow(grant)}>Stop sharing</Button>;
                    return null;
                  },
                },
              ]}
              rows={grantRows.map((row) => ({ ...row, since: formatShortDate(row.created_at) })) as unknown as Record<string, unknown>[]}
              emptyMessage="No shared records match."
            />
          )}
        </div>
      ) : null}

      <Modal
        open={Boolean(openLink)}
        title={openLink ? `Link with ${nameOf(otherCompany(openLink, me))}` : "Partner link"}
        onClose={() => setOpen(null)}
        footer={openLink ? (
          <>
            <Button type="button" variant="secondary" onClick={() => setOpen(null)}>Close</Button>
            {!acceptedByMe(openLink, me) ? <Button type="button" disabled={busy} onClick={() => acceptLinkNow(openLink)}>Accept</Button> : null}
          </>
        ) : undefined}
      >
        {openLink ? (
          <Facts
            rows={[
              ["Status", <StatePill key="s" {...LINK_STATE[linkState(openLink, me)]} />],
              [nameOf(me), acceptedByMe(openLink, me) ? "Accepted" : "Not yet"],
              [nameOf(otherCompany(openLink, me)), (openLink.company_a_id === me ? openLink.accepted_b : openLink.accepted_a) ? "Accepted" : "Not yet"],
              ["Proposed", formatDate(openLink.created_at)],
            ]}
          />
        ) : null}
      </Modal>

      <Modal
        open={Boolean(openGrant)}
        title={openGrant ? labelOf(openGrant)?.text ?? "Shared record" : "Shared record"}
        onClose={() => setOpen(null)}
        footer={openGrant ? (
          <>
            <Button type="button" variant="secondary" onClick={() => setOpen(null)}>Close</Button>
            {openGrant.source_company_id === me && openGrant.status === "active" ? <Button type="button" variant="secondary" disabled={busy} onClick={() => revokeGrantNow(openGrant)}>Stop sharing</Button> : null}
            {openGrant.source_company_id === me && openGrant.status === "proposed" ? <Button type="button" disabled={busy} onClick={() => acceptGrantNow(openGrant)}>Accept</Button> : null}
          </>
        ) : undefined}
      >
        {openGrant ? (
          <>
            <Facts
              rows={[
                ["What", recordCell(openGrant)],
                [openGrant.source_company_id === me ? "Shared with" : "Shared by", nameOf(openGrant.source_company_id === me ? openGrant.grantee_company_id : openGrant.source_company_id)],
                ["Status", <StatePill key="s" {...grantState(openGrant, me)} />],
                ["Since", formatDate(openGrant.created_at)],
              ]}
            />
            {openGrant.status === "proposed" && openGrant.source_company_id === me ? (
              <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted, lineHeight: 1.45 }}>The partner sees this record only after you accept. Nothing is copied.</p>
            ) : null}
          </>
        ) : null}
      </Modal>

      <Modal open={creating} title="Propose partner link" description="The link becomes active once both companies accept it." onClose={() => setCreating(false)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setCreating(false)}>Cancel</Button>
          <Button type="button" disabled={busy} onClick={() => void run(async () => {
            if (!otherCompanyId) throw new Error("Choose the partner company first.");
            await proposeLink({ otherCompanyId });
            setOtherCompanyId("");
            setPickOther("");
          }, "Link proposed. It becomes active once the partner accepts it.")}>Propose</Button>
        </>
      )}>
        <Field label="Partner company">
          <Select
            value={pickOther}
            onChange={(event) => {
              setPickOther(event.target.value);
              setOtherCompanyId(event.target.value === OTHER_ID ? "" : event.target.value);
            }}
          >
            <option value="">Choose a company…</option>
            {companies.filter((c) => c.id !== me).map((c) => <option key={c.id} value={c.id}>{c.name}{c.prefix ? ` (${c.prefix})` : ""}</option>)}
            <option value={OTHER_ID}>A company I can't see here</option>
          </Select>
        </Field>
        {pickOther === OTHER_ID ? (
          <Field label="The partner's Paperclip company id (ask them for it)">
            <Input value={otherCompanyId} onChange={(event) => setOtherCompanyId(event.target.value)} required placeholder="From their Paperclip company settings" />
          </Field>
        ) : null}
      </Modal>
    </Page>
  );
}

function StatePill({ label, tone }: { label: string; tone: ToneInput }) {
  return <Pill tone={tone} dot>{label}</Pill>;
}

function Muted({ children }: { children: ReactNode }) {
  return <p style={{ margin: 0, fontSize: 13, color: tokens.muted, lineHeight: 1.45 }}>{children}</p>;
}

function CompanyName({ name, detail }: { name: string; detail?: string }) {
  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "flex-start", minWidth: 0 }}>
      <Building2 size={14} color={tokens.muted} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
      <span style={{ display: "grid", gap: 1, minWidth: 0 }}>
        <strong style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{name}</strong>
        {detail ? <span style={{ fontSize: 12, color: tokens.muted }}>{detail}</span> : null}
      </span>
    </span>
  );
}

/** "Northwind (company)" linking to the CRM; an unknown record keeps its id behind Details. */
function RecordName({ label, id, linkFor }: { label: RecordLabel; id: string; linkFor: (href: string) => Record<string, unknown> }) {
  if (!label.found) {
    return (
      <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
        <span>{label.text}</span>
        <details style={{ fontSize: 12, color: tokens.muted }}>
          <summary style={{ cursor: "pointer" }}>Details</summary>
          <span style={{ overflowWrap: "anywhere" }}>The {label.where} could not name this {label.kindWord} (id {id}). It may have been deleted, or it is not visible to you.</span>
        </details>
      </span>
    );
  }
  return (
    <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
      {label.href ? <a {...linkFor(label.href)} title={`Open in the ${label.where}`} style={{ color: tokens.primary, fontWeight: 600, textDecoration: "underline", textUnderlineOffset: 3, textDecorationColor: tokens.border }}>{label.name}</a> : <strong>{label.name}</strong>}
      <span style={{ color: tokens.muted }}> ({label.kindWord})</span>
    </span>
  );
}

function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "minmax(90px, auto) minmax(0, 1fr)", gap: "8px 14px", fontSize: 13 }}>
      {rows.map(([term, value]) => (
        <div key={term} style={{ display: "contents" }}>
          <dt style={{ color: tokens.muted }}>{term}</dt>
          <dd style={{ margin: 0, minWidth: 0, overflowWrap: "anywhere" }}>{value}</dd>
        </div>
      ))}
    </dl>
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
    throw new Error(payload.error ?? "The share was accepted here, but the partner cannot see the record yet. Try Accept again.");
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
