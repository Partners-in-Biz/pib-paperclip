import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  DataTable,
  useHostLocation,
  useHostNavigation,
  usePluginAction,
  type PluginPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  Activity as ActivityIcon,
  Briefcase,
  Building2,
  Button,
  ClientWorkspaceBar,
  Clock,
  CompactRows,
  Contact as ContactIcon,
  EmptyState,
  Field,
  Form,
  Funnel,
  Input,
  KpiCard,
  LayoutDashboard,
  Modal,
  Package,
  Page,
  PageMessage,
  PipelineBoard,
  PipelineCard,
  Pill,
  SectionCard,
  Select,
  Tabs,
  Target,
  TextArea,
  Toolbar,
  PageFrame,
  UserRound,
  Users,
  Workflow,
  errorText,
  fluidColumns,
  formatDate,
  formatMoney,
  formatShortDate,
  moduleAccent,
  tokens,
  tone,
  useIsNarrow,
  useUiContributions,
  IconBadge,
} from "@partnersinbiz/pib-plugin-ui";
import { GetStarted, missingRequired, useGroupedNav, usePluginSetupStatus, useUrlTab } from "@partnersinbiz/pib-plugin-ui";
import { clientScopeFromSearch, withClientParam, type ClientRef } from "@partnersinbiz/pib-plugin-kit/client-ref";
import { resolvePluginUiBase } from "@partnersinbiz/pib-plugin-kit/oauth-client";
import { ModuleOffBanner, useModuleEnabled } from "./module-switch.js";
import { leadBand, type LeadScore } from "../lead-levels.js";
import type { CrmSeries } from "../series.js";
import { ActivityTimeline, BandPill, CrmOverview, LeadScoreCard, LIFECYCLE_LABEL, LifecyclePill, Muted, StagePill, type NeedsGroup } from "./overview.js";
import { AccountManagerBox, type HireView } from "./agent.js";
import { ProjectsCard, WebsitesCard, type ConnectResult, type ProjectView, type SiteView } from "./sites.js";
import { ClientLeadsCard, ClientProfileCard, DeleteCompanyDialog, EmailStatusControl, type ClientLeadView, type ClientProfileView, type EmailStatus } from "./client.js";
import { LeadFormsCard } from "./leads.js";
import { ClientAgreementsCard, type CreatedKey } from "./agreements.js";
import { agreementsVisible, type AgreementsView, type GrowthView } from "./agreements-view.js";
import { ClientCareCard } from "./care.js";
import { careVisible, type CareView } from "./care-view.js";
import type { CreatedLeadForm, LeadFormView } from "./leads-view.js";
import type { ChecklistResult } from "./checklist-view.js";
import { NewClientCard } from "./new-client.js";
import { crmTabBadges, dealClientLabel, dealsByStage, displayText, followUpDue, moduleInstalled, parseMoneyInput, toggleOwned, type CrmTab } from "./crm-view.js";
import { DealSheet, type DealView } from "./deal.js";
import { EmailText, FieldList, MoreMenu, whenText, type FieldRow } from "./parts.js";
import { DeliveryPill, GmailBanner, SequenceSheet, deliveryText, useGmailState, type SequenceView } from "./sequence.js";

interface Account {
  id: string;
  name: string;
  domain: string | null;
  lifecycle: string;
}

interface Contact {
  id: string;
  name: string;
  emails: string[];
  lifecycle: string;
  humanOwned: string[];
  nextActionKind?: string | null;
  nextActionDueAt?: string | null;
  leadScore?: LeadScore | null;
}

interface Deal {
  id: string;
  title: string;
  amountMinor: number;
  currency: string;
  stageId: string;
  contactId: string | null;
  accountId: string | null;
}

interface Link {
  contactId: string;
  accountId: string;
  roleLabel: string;
}

interface Product {
  id: string;
  name: string;
  description: string;
  unitAmountMinor: number;
  currency: string;
  isActive: boolean;
}

interface Activity {
  id: string;
  kind: string;
  body: string;
  issueId: string | null;
  createdAt: string;
  threadId?: string | null;
}

interface Stage {
  id: string;
  name: string;
  kind: string;
  position: number;
}

interface Summary {
  companyCount: number;
  contactCount: number;
  dealCount: number;
  sequenceCount: number;
  openDealCount: number;
  openPipelineByCurrency: Record<string, number>;
  byStage: Record<string, { count: number; amountMinor: number }>;
  accountLifecycle: Record<string, number>;
  contactLifecycle: Record<string, number>;
  unlinkedContactIds: string[];
  dealsWithoutAmountIds: string[];
}

interface Snapshot {
  settingsSaved?: boolean;
  hire?: HireView | null;
  heldLeads?: number;
  accounts: Account[];
  contacts: Contact[];
  deals: Deal[];
  links: Link[];
  sequences: SequenceView[];
  stages: Stage[];
  products: Product[];
  summary: Summary;
  series?: CrmSeries;
}

type CreateKind = "company" | "contact" | "deal" | "sequence" | "link" | "product" | null;
type Detail =
  | { kind: "deal"; id: string }
  | { kind: "sequence"; id: string }
  | null;

const PLUGIN_ID = "partnersinbiz.crm";
const BILLING_PLUGIN = "partnersinbiz.billing";
const TAB_IDS: CrmTab[] = ["overview", "companies", "contacts", "deals", "sequences", "products"];
const LIFECYCLE_OPTIONS = ["lead", "prospect", "customer", "churned"] as const;
const NEXT_ACTION_OPTIONS = ["call", "email", "meet"] as const;
const NEXT_ACTION_LABEL: Record<string, string> = { call: "Call", email: "Email", meet: "Meet" };

/** `/crm` is the CRM list; `/crm?client=company:<id>` (or `contact:<id>`) is that client's workspace. */
export function CrmPage(props: PluginPageProps) {
  const location = useHostLocation();
  const client = clientScopeFromSearch(location.search);
  if (client) {
    return <ClientWorkspace key={`${client.kind}:${client.id}`} companyId={props.context.companyId ?? null} client={client} />;
  }
  return <CrmList {...props} />;
}

function clientPath(kind: ClientRef["kind"], id: string): string {
  return withClientParam("/crm", { kind, id });
}

/** "Call · due 28 Sep". */
function nextActionText(kind: string | null | undefined, due: string | null | undefined): string {
  if (!kind) return "";
  const label = NEXT_ACTION_LABEL[kind] ?? kind;
  return due ? `${label} · due ${formatShortDate(due)}` : label;
}

function CrmList({ context }: PluginPageProps) {
  const navigation = useHostNavigation();
  const narrow = useIsNarrow();
  // Other modules' pages: "Draft a quote" needs Billing.
  const contributions = useUiContributions();
  const billingInstalled = moduleInstalled(contributions, BILLING_PLUGIN) === true;
  // "Finish setting up CRM" on the overview until its required setup is done.
  const setupStatus = usePluginSetupStatus(PLUGIN_ID, context.companyId);
  // The card below already asks for the Account Manager: the agent box would say it twice.
  const agentStepShown = missingRequired(setupStatus ?? null).slice(0, 3).some((item) => item.key === "agent");
  const load = usePluginAction("crm.load");
  const createCompany = usePluginAction("crm.create-company");
  const createContact = usePluginAction("crm.create-contact");
  const linkContact = usePluginAction("crm.link-contact");
  const createDeal = usePluginAction("crm.create-deal");
  const moveDeal = usePluginAction("crm.move-deal");
  const createSequence = usePluginAction("crm.create-sequence");
  const createProduct = usePluginAction("crm.create-product");

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [message, setMessage] = useState("");
  const hostLocation = useHostLocation();
  // `?tab=` opens a tab and switching tabs updates the address, so links can point at a tab.
  const [tab, setTab] = useUrlTab<CrmTab>(TAB_IDS, "overview", { path: "/crm", search: hostLocation.search, navigate: navigation.navigate });
  const [search, setSearch] = useState("");
  const [create, setCreate] = useState<CreateKind>(null);
  const [detail, setDetail] = useState<Detail>(null);
  // Email steps need Gmail: checked only where sequences are shown or made.
  const gmail = useGmailState(tab === "sequences" || create === "sequence" || detail?.kind === "sequence" ? context.companyId : null);

  const [companyName, setCompanyName] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [linkContactId, setLinkContactId] = useState("");
  const [linkAccountId, setLinkAccountId] = useState("");
  const [linkRole, setLinkRole] = useState("buyer");
  const [dealTitle, setDealTitle] = useState("");
  const [dealAmount, setDealAmount] = useState("");
  const [dealCurrency, setDealCurrency] = useState("ZAR");
  const [dealContactId, setDealContactId] = useState("");
  const [dealAccountId, setDealAccountId] = useState("");
  const [sequenceName, setSequenceName] = useState("");
  const [sequenceDelivery, setSequenceDeliveryChoice] = useState<"issue" | "email">("issue");
  const [productName, setProductName] = useState("");
  const [productAmount, setProductAmount] = useState("");
  const [productCurrency, setProductCurrency] = useState("ZAR");

  async function refresh() {
    setSnapshot((await load({ uiBase: await resolvePluginUiBase(PLUGIN_ID, import.meta.url) })) as Snapshot);
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

  function openCreate(kind: Exclude<CreateKind, null>) {
    if (kind === "sequence") setSequenceDeliveryChoice("issue");
    setCreate(kind);
  }

  const q = search.trim().toLowerCase();
  const accounts = useMemo(() => {
    const rows = snapshot?.accounts ?? [];
    if (!q) return rows;
    return rows.filter((row) => [row.name, row.domain ?? "", row.lifecycle].join(" ").toLowerCase().includes(q));
  }, [snapshot, q]);
  const contacts = useMemo(() => {
    const rows = snapshot?.contacts ?? [];
    if (!q) return rows;
    return rows.filter((row) => [row.name, row.emails.join(" "), row.lifecycle].join(" ").toLowerCase().includes(q));
  }, [snapshot, q]);
  const deals = useMemo(() => {
    const rows = snapshot?.deals ?? [];
    if (!q) return rows;
    return rows.filter((row) => row.title.toLowerCase().includes(q));
  }, [snapshot, q]);
  const sequences = useMemo(() => {
    const rows = snapshot?.sequences ?? [];
    if (!q) return rows;
    return rows.filter((row) => row.name.toLowerCase().includes(q));
  }, [snapshot, q]);
  const products = useMemo(() => {
    const rows = snapshot?.products ?? [];
    if (!q) return rows;
    return rows.filter((row) => [row.name, row.description].join(" ").toLowerCase().includes(q));
  }, [snapshot, q]);

  const stages = snapshot?.stages ?? [];
  const summary = snapshot?.summary;
  const now = Date.now();
  const followUps = (snapshot?.contacts ?? []).filter((row) => followUpDue(row, now));
  const awaitingApproval = (snapshot?.sequences ?? []).filter((row) => row.delivery === "email" && !row.emailApproved);
  const emailSequences = (snapshot?.sequences ?? []).filter((row) => row.delivery === "email").length;
  const badges = crmTabBadges({
    companies: snapshot?.accounts.length ?? 0,
    contacts: snapshot?.contacts.length ?? 0,
    deals: snapshot?.deals.length ?? 0,
    sequences: snapshot?.sequences.length ?? 0,
    products: snapshot?.products.length ?? 0,
    followUps: followUps.length,
    dealsWithoutValue: summary?.dealsWithoutAmountIds.length ?? 0,
    sequencesAwaitingApproval: awaitingApproval.length,
  });
  const hasData = Boolean(snapshot && (snapshot.accounts.length || snapshot.contacts.length || snapshot.deals.length));

  const accountNameOf = (id: string) => snapshot?.accounts.find((row) => row.id === id)?.name ?? null;
  const contactNameOf = (id: string) => snapshot?.contacts.find((row) => row.id === id)?.name ?? null;
  const clientOf = (deal: Deal) => dealClientLabel(deal, accountNameOf, contactNameOf);

  function rolesFor(contactId: string): string {
    return (snapshot?.links ?? [])
      .filter((link) => link.contactId === contactId)
      .map((link) => `${link.roleLabel} at ${accountNameOf(link.accountId) ?? "a company"}`)
      .join(", ");
  }
  const peopleAt = (accountId: string) => (snapshot?.links ?? []).filter((link) => link.accountId === accountId).length;

  const detailDeal = detail?.kind === "deal" ? snapshot?.deals.find((row) => row.id === detail.id) ?? null : null;
  const detailSequence = detail?.kind === "sequence" ? snapshot?.sequences.find((row) => row.id === detail.id) ?? null : null;

  // One main action per tab, in the header. An empty list shows it in its empty state instead.
  const total: Record<CrmTab, number> = {
    overview: 1,
    companies: snapshot?.accounts.length ?? 0,
    contacts: snapshot?.contacts.length ?? 0,
    deals: snapshot?.deals.length ?? 0,
    sequences: snapshot?.sequences.length ?? 0,
    products: snapshot?.products.length ?? 0,
  };
  const mainAction: Record<CrmTab, { label: string; kind: Exclude<CreateKind, null> }> = {
    overview: { label: "+ Deal", kind: "deal" },
    companies: { label: "+ Company", kind: "company" },
    contacts: { label: "+ Contact", kind: "contact" },
    deals: { label: "+ Deal", kind: "deal" },
    sequences: { label: "+ Sequence", kind: "sequence" },
    products: { label: "+ Product", kind: "product" },
  };
  const action = mainAction[tab];
  const headerAction = snapshot && total[tab] > 0
    ? <Button type="button" onClick={() => openCreate(action.kind)}>{action.label}</Button>
    : null;
  const emptyAction = (kind: Exclude<CreateKind, null>, label: string) => <Button type="button" onClick={() => openCreate(kind)}>{label}</Button>;

  const needs: NeedsGroup[] = [
    {
      key: "follow-ups",
      title: "Contacts to follow up",
      action: "Open",
      items: followUps.map((row) => ({
        id: row.id,
        label: row.name,
        detail: nextActionText(row.nextActionKind, row.nextActionDueAt),
        onClick: () => navigation.navigate(clientPath("contact", row.id)),
      })),
    },
    {
      key: "no-value",
      title: "Deals without a value",
      action: "Add value",
      items: (summary?.dealsWithoutAmountIds ?? []).flatMap((id) => {
        const deal = snapshot?.deals.find((row) => row.id === id);
        return deal ? [{ id, label: deal.title, detail: clientOf(deal) ?? "No client yet", onClick: () => setDetail({ kind: "deal", id }) }] : [];
      }),
    },
    {
      key: "approvals",
      title: "Email sequences waiting for approval",
      action: "Open",
      items: awaitingApproval.map((row) => ({
        id: row.id,
        label: row.name,
        detail: "A person approves the switch to email in its issue",
        onClick: () => (row.approvalIssueId ? navigation.navigate(`/issues/${row.approvalIssueId}`) : setDetail({ kind: "sequence", id: row.id })),
      })),
    },
  ];

  const settingsLine = snapshot?.settingsSaved === false
    ? `CRM settings aren't saved yet, so sequences and client sharing are on hold. Save them once in Settings → Plugins → CRM.${snapshot.heldLeads ? ` ${snapshot.heldLeads} ${snapshot.heldLeads === 1 ? "lead is" : "leads are"} waiting.` : ""}`
    : snapshot?.heldLeads
      ? `${snapshot.heldLeads} ${snapshot.heldLeads === 1 ? "lead is" : "leads are"} held while the CRM is switched off. Switch it on in Setup and they are added within 10 minutes.`
      : undefined;

  return (
    <Page
      title="CRM"
      accent="crm"
      description="People, the companies they work for, and the deals between them."
      messageTone={message ? undefined : "warn"}
      message={message || settingsLine}
      actions={headerAction}
    >
      <ModuleOffBanner companyId={context.companyId} pluginKey={PLUGIN_ID} />
      <Tabs
        tabs={[
          { id: "overview", label: "Overview", icon: LayoutDashboard, ...badges.overview },
          { id: "companies", label: "Companies", icon: Building2, ...badges.companies },
          { id: "contacts", label: "Contacts", icon: ContactIcon, ...badges.contacts },
          { id: "deals", label: "Deals", icon: Briefcase, ...badges.deals },
          { id: "sequences", label: "Sequences", icon: Workflow, ...badges.sequences },
          { id: "products", label: "Products", icon: Package, ...badges.products },
        ]}
        active={tab}
        onChange={(id) => {
          setTab(id as CrmTab);
          setSearch("");
        }}
      />

      {/* Only when something is wrong with the Account Manager (staffed in Setup → Team), and not already a step in the card below. */}
      {tab === "overview" && snapshot && !agentStepShown ? <AccountManagerBox hire={snapshot.hire} refresh={refresh} onMessage={setMessage} /> : null}
      {tab === "overview" ? <GetStarted status={setupStatus} moduleName="CRM" hasData={hasData} linkFor={(href) => navigation.linkProps(href) as unknown as Record<string, unknown>} /> : null}
      {tab === "overview" ? (
        snapshot ? (
          <CrmOverview
            summary={summary}
            series={snapshot.series}
            stages={stages}
            contacts={snapshot.contacts}
            onTab={(next) => { setTab(next); setSearch(""); }}
            needs={needs}
            unlinked={(summary?.unlinkedContactIds ?? []).map((id) => ({
              id,
              label: contactNameOf(id) ?? "A contact",
              onClick: () => navigation.navigate(clientPath("contact", id)),
            }))}
          />
        ) : <Muted>{message ? "The CRM could not load." : "Loading the CRM…"}</Muted>
      ) : null}

      {tab === "companies" && snapshot ? (
        snapshot.accounts.length === 0 ? (
          <EmptyState
            title="No companies yet"
            icon={Building2}
            description="Add the companies you work with. Their people become contacts, and each one gets its own client page."
            action={emptyAction("company", "+ Company")}
          />
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search companies…" />
            {narrow ? (
              <CompactRows
                label="Companies"
                rows={accounts}
                title={(row) => row.name}
                meta={(row) => [row.domain, `${peopleAt(row.id)} ${peopleAt(row.id) === 1 ? "person" : "people"}`].filter(Boolean).join(" · ")}
                trailing={(row) => <LifecyclePill lifecycle={row.lifecycle} size="sm" />}
                linkFor={(row) => navigation.linkProps(clientPath("company", row.id)) as unknown as Record<string, unknown>}
                empty="No companies match."
              />
            ) : (
              <DataTable
                columns={[
                  { key: "name", header: "Company", render: (value, row) => <NameLink to={clientPath("company", String(row.id))} name={String(value)} /> },
                  { key: "domain", header: "Website" },
                  { key: "people", header: "People", width: "90px" },
                  { key: "lifecycle", header: "Lifecycle", width: "130px", render: (value) => <LifecyclePill lifecycle={String(value)} /> },
                  {
                    key: "id",
                    header: "",
                    width: "80px",
                    render: (_value, row) => <OpenLink to={clientPath("company", String(row.id))} label={`Open ${String(row.name)}`} />,
                  },
                ]}
                rows={accounts.map((row) => ({ ...row, domain: row.domain ?? "—", people: String(peopleAt(row.id)) }))}
                emptyMessage="No companies match."
              />
            )}
          </div>
        )
      ) : null}

      {tab === "contacts" && snapshot ? (
        snapshot.contacts.length === 0 ? (
          <EmptyState
            title="No contacts yet"
            icon={ContactIcon}
            description="Add the people you deal with, then link each one to their company. Leads from Social and the Mailbox arrive here on their own."
            action={emptyAction("contact", "+ Contact")}
          />
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search contacts…">
              {snapshot.accounts.length > 0 ? <Button type="button" variant="secondary" onClick={() => openCreate("link")}>Link to company</Button> : null}
            </Toolbar>
            {narrow ? (
              <CompactRows
                label="Contacts"
                rows={contacts}
                title={(row) => row.name}
                meta={(row) => [followUpDue(row, now) ? `Follow up: ${nextActionText(row.nextActionKind, row.nextActionDueAt)}` : null, row.emails[0], rolesFor(row.id) || "No company"].filter(Boolean).join(" · ")}
                trailing={(row) => followUpDue(row, now) ? <Pill tone="warn" size="sm" dot>Follow up</Pill> : <LifecyclePill lifecycle={row.lifecycle} size="sm" />}
                linkFor={(row) => navigation.linkProps(clientPath("contact", row.id)) as unknown as Record<string, unknown>}
                empty="No contacts match."
              />
            ) : (
              <DataTable
                columns={[
                  { key: "name", header: "Contact", render: (value, row) => <NameLink to={clientPath("contact", String(row.id))} name={String(value)} /> },
                  { key: "email", header: "Email", render: (value) => value ? <EmailText email={String(value)} /> : <span style={{ color: tokens.muted }}>—</span> },
                  { key: "roles", header: "Company", render: (value) => value ? String(value) : <span style={{ color: tokens.muted }}>No company</span> },
                  { key: "next", header: "Next action", render: (_value, row) => {
                    const contact = row as unknown as Contact;
                    if (!contact.nextActionKind) return <span style={{ color: tokens.muted }}>—</span>;
                    return <Pill tone={followUpDue(contact, now) ? "warn" : "info"} size="sm" icon={Clock}>{nextActionText(contact.nextActionKind, contact.nextActionDueAt)}</Pill>;
                  } },
                  { key: "lifecycle", header: "Lifecycle", render: (value, row) => (
                    <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                      <LifecyclePill lifecycle={String(value)} />
                      {(row as unknown as Contact).leadScore ? <BandPill band={leadBand((row as unknown as Contact).leadScore!)} /> : null}
                    </span>
                  ) },
                  {
                    key: "id",
                    header: "",
                    width: "80px",
                    render: (_value, row) => <OpenLink to={clientPath("contact", String(row.id))} label={`Open ${String(row.name)}`} />,
                  },
                ]}
                rows={contacts.map((row) => ({
                  ...row,
                  email: row.emails[0] ?? "",
                  roles: rolesFor(row.id),
                  next: "",
                }))}
                emptyMessage="No contacts match."
              />
            )}
          </div>
        )
      ) : null}

      {tab === "deals" && snapshot ? (
        snapshot.deals.length === 0 ? (
          <EmptyState
            title="No deals yet"
            icon={Briefcase}
            description="A deal is a sale in progress for a client. Add one, then move it through the stages until it is won or lost."
            action={emptyAction("deal", "+ Deal")}
          />
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search deals…" />
            {narrow ? (
              <div style={{ display: "grid", gap: 16 }}>
                {dealsByStage(stages, deals).filter((group) => group.deals.length > 0).map(({ stage, deals: stageDeals }) => (
                  <section key={stage.id} style={{ display: "grid", gap: 4 }} aria-label={stage.name}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                      <StagePill name={stage.name} kind={stage.kind} size="sm" />
                      <span style={{ fontSize: 12, color: tokens.muted, fontVariantNumeric: "tabular-nums" }}>{stageDeals.length} · {stageTotal(stageDeals)}</span>
                    </div>
                    <CompactRows
                      label={`${stage.name} deals`}
                      rows={stageDeals}
                      title={(deal) => deal.title}
                      meta={(deal) => clientOf(deal) ?? "No client yet"}
                      trailing={(deal) => deal.amountMinor > 0 ? formatMoney(deal.amountMinor, deal.currency) : <span style={{ color: tone("warn").fg }}>No value</span>}
                      onOpen={(deal) => setDetail({ kind: "deal", id: deal.id })}
                    />
                  </section>
                ))}
                {deals.length === 0 ? <Muted>No deals match.</Muted> : null}
              </div>
            ) : (
              <PipelineBoard
                columns={dealsByStage(stages, deals).map(({ stage, deals: stageDeals }) => ({
                  id: stage.id,
                  title: stage.name,
                  meta: `${stageDeals.length} · ${stageTotal(stageDeals)}`,
                  children: stageDeals.length === 0
                    ? <p style={{ margin: 0, fontSize: 12, color: tokens.muted }}>Empty</p>
                    : stageDeals.map((deal) => (
                      <PipelineCard
                        key={deal.id}
                        title={deal.title}
                        subtitle={`${deal.amountMinor > 0 ? formatMoney(deal.amountMinor, deal.currency) : "No value yet"} · ${clientOf(deal) ?? "No client yet"}`}
                        onClick={() => setDetail({ kind: "deal", id: deal.id })}
                        footer={(
                          <Select
                            aria-label={`Move ${deal.title}`}
                            value={deal.stageId}
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) => {
                              event.stopPropagation();
                              void run(() => moveDeal({ dealId: deal.id, stageId: event.target.value }), "Deal moved");
                            }}
                            style={{ height: 28, fontSize: 12, marginTop: 6, width: "100%" }}
                          >
                            {stages.map((option) => (
                              <option key={option.id} value={option.id}>{option.name}</option>
                            ))}
                          </Select>
                        )}
                      />
                    )),
                }))}
              />
            )}
          </div>
        )
      ) : null}

      {tab === "sequences" && snapshot ? (
        <div style={{ display: "grid", gap: 12 }}>
          <GmailBanner state={gmail} emailSequences={emailSequences} />
          {snapshot.sequences.length === 0 ? (
            <EmptyState
              title="No sequences yet"
              icon={Workflow}
              description="A sequence is a set of follow-up steps, spaced out over days. Create one, then enroll contacts from their page."
              action={emptyAction("sequence", "+ Sequence")}
            />
          ) : (
            <>
              <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search sequences…" />
              {narrow ? (
                <CompactRows
                  label="Sequences"
                  rows={sequences}
                  title={(row) => row.name}
                  meta={(row) => deliveryText(row)}
                  onOpen={(row) => setDetail({ kind: "sequence", id: row.id })}
                  empty="No sequences match."
                />
              ) : (
                <DataTable
                  columns={[
                    { key: "name", header: "Sequence", render: (value, row) => <NameButton name={String(value)} onClick={() => setDetail({ kind: "sequence", id: String(row.id) })} /> },
                    { key: "delivery", header: "Each due step", render: (_value, row) => <DeliveryPill sequence={row as unknown as SequenceView} /> },
                    {
                      key: "id",
                      header: "",
                      width: "80px",
                      render: (_value, row) => (
                        <Button type="button" variant="secondary" style={smallButton} onClick={() => setDetail({ kind: "sequence", id: String(row.id) })}>
                          Open
                        </Button>
                      ),
                    },
                  ]}
                  rows={sequences as unknown as Record<string, unknown>[]}
                  emptyMessage="No sequences match."
                />
              )}
            </>
          )}
        </div>
      ) : null}

      {tab === "products" && snapshot ? (
        snapshot.products.length === 0 ? (
          <EmptyState
            title="No products yet"
            icon={Package}
            description="Add the products and services you sell, with their price, to itemise deals and quotes."
            action={emptyAction("product", "+ Product")}
          />
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search products…" />
            {narrow ? (
              <CompactRows
                label="Products"
                rows={products}
                title={(row) => row.name}
                meta={(row) => [row.isActive ? null : "Inactive", row.description].filter(Boolean).join(" · ") || "Active"}
                trailing={(row) => formatMoney(row.unitAmountMinor, row.currency)}
                empty="No products match."
              />
            ) : (
              <DataTable
                columns={[
                  { key: "name", header: "Product" },
                  { key: "description", header: "Description" },
                  { key: "price", header: "Price", render: (_value, row) => formatMoney((row as unknown as Product).unitAmountMinor, (row as unknown as Product).currency) },
                  { key: "isActive", header: "Status", render: (value) => <Pill tone={value ? "ok" : "neutral"} dot>{value ? "Active" : "Inactive"}</Pill> },
                ]}
                rows={products.map((row) => ({ ...row, price: "" }))}
                emptyMessage="No products match."
              />
            )}
          </div>
        )
      ) : null}

      <Modal
        open={create === "company"}
        title="Add a company"
        description="A client or prospect company. Its people are contacts you link to it."
        onClose={() => setCreate(null)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
            <Button
              type="button"
              disabled={!companyName.trim()}
              onClick={() => void run(async () => {
                await createCompany({ name: companyName });
                setCompanyName("");
              }, "Company saved")}
            >
              Save company
            </Button>
          </>
        )}
      >
        <Field label="Company name">
          <Input value={companyName} onChange={(event) => setCompanyName(event.target.value)} placeholder="Northwind" required />
        </Field>
      </Modal>

      <Modal
        open={create === "contact"}
        title="Add a contact"
        description="A person. Link them to their company afterwards, or leave a sole trader on their own."
        onClose={() => setCreate(null)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
            <Button
              type="button"
              disabled={!contactName.trim()}
              onClick={() => void run(async () => {
                await createContact({
                  name: contactName,
                  emails: contactEmail.trim() ? [contactEmail.trim()] : [],
                });
                setContactName("");
                setContactEmail("");
              }, "Contact saved")}
            >
              Save contact
            </Button>
          </>
        )}
      >
        <Field label="Name">
          <Input value={contactName} onChange={(event) => setContactName(event.target.value)} placeholder="Ada Lovelace" required />
        </Field>
        <Field label="Email">
          <Input value={contactEmail} type="email" onChange={(event) => setContactEmail(event.target.value)} placeholder="ada@northwind.test" />
        </Field>
      </Modal>

      <Modal
        open={create === "link"}
        title="Link a contact to a company"
        onClose={() => setCreate(null)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
            <Button
              type="button"
              disabled={!linkContactId || !linkAccountId}
              onClick={() => void run(() => linkContact({
                contactId: linkContactId,
                companyRecordId: linkAccountId,
                roleLabel: linkRole,
              }), "Link saved")}
            >
              Save link
            </Button>
          </>
        )}
      >
        <Field label="Contact">
          <Select value={linkContactId} onChange={(event) => setLinkContactId(event.target.value)} required>
            <option value="">Select contact</option>
            {(snapshot?.contacts ?? []).map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
          </Select>
        </Field>
        <Field label="Company">
          <Select value={linkAccountId} onChange={(event) => setLinkAccountId(event.target.value)} required>
            <option value="">Select company</option>
            {(snapshot?.accounts ?? []).map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
          </Select>
        </Field>
        <Field label="Role">
          <Input value={linkRole} onChange={(event) => setLinkRole(event.target.value)} placeholder="buyer, owner, staff" />
        </Field>
      </Modal>

      <Modal
        open={create === "deal"}
        title="Add a deal"
        description="A sale in progress for a client. It starts in the first stage."
        onClose={() => setCreate(null)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
            <Button
              type="button"
              disabled={!dealTitle.trim() || parseMoneyInput(dealAmount) === null}
              onClick={() => void run(async () => {
                await createDeal({
                  title: dealTitle,
                  amountMinor: parseMoneyInput(dealAmount) ?? 0,
                  currency: dealCurrency.trim().toUpperCase() || "ZAR",
                  companyRecordId: dealAccountId || undefined,
                  contactId: dealContactId || undefined,
                });
                setDealTitle("");
                setDealAmount("");
                setDealContactId("");
                setDealAccountId("");
              }, "Deal saved")}
            >
              Save deal
            </Button>
          </>
        )}
      >
        <Field label="Title">
          <Input value={dealTitle} onChange={(event) => setDealTitle(event.target.value)} placeholder="Website rebuild" required />
        </Field>
        <MoneyFields value={dealAmount} onValue={setDealAmount} currency={dealCurrency} onCurrency={setDealCurrency} label="Value" />
        <Field label="Company">
          <Select value={dealAccountId} onChange={(event) => setDealAccountId(event.target.value)}>
            <option value="">None yet</option>
            {(snapshot?.accounts ?? []).map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
          </Select>
        </Field>
        <Field label="Contact">
          <Select value={dealContactId} onChange={(event) => setDealContactId(event.target.value)}>
            <option value="">None yet</option>
            {(snapshot?.contacts ?? []).map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
          </Select>
        </Field>
      </Modal>

      <Modal
        open={create === "sequence"}
        title="Add a sequence"
        description="A sequence made here has one step, Reach out. For one with several steps spaced over days, ask the Account Manager to build it."
        onClose={() => setCreate(null)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
            <Button
              type="button"
              disabled={!sequenceName.trim()}
              onClick={() => void run(async () => {
                await createSequence({ name: sequenceName, completionMode: "manual", delivery: sequenceDelivery });
                setSequenceName("");
              }, sequenceDelivery === "email" ? "Sequence saved. Nothing is emailed until a person approves it in its approval issue." : "Sequence saved")}
            >
              Save sequence
            </Button>
          </>
        )}
      >
        <Field label="Name">
          <Input value={sequenceName} onChange={(event) => setSequenceName(event.target.value)} placeholder="New lead follow-up" required />
        </Field>
        <Field label="Each due step">
          <Select value={sequenceDelivery} onChange={(event) => setSequenceDeliveryChoice(event.target.value === "email" ? "email" : "issue")}>
            <option value="issue">Opens an issue for a person</option>
            <option value="email" disabled={gmail === "missing" || gmail === "reconnect" || gmail === "off"}>
              {gmail === "missing" || gmail === "reconnect" || gmail === "off" ? "Is emailed from the Mailbox (connect Gmail first)" : "Is emailed from the Mailbox (a person approves once)"}
            </option>
          </Select>
        </Field>
      </Modal>

      <Modal
        open={create === "product"}
        title="Add a product"
        description="Something you sell, with its price per unit."
        onClose={() => setCreate(null)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
            <Button
              type="button"
              disabled={!productName.trim() || parseMoneyInput(productAmount) === null}
              onClick={() => void run(async () => {
                await createProduct({
                  name: productName,
                  unitAmountMinor: parseMoneyInput(productAmount) ?? 0,
                  currency: productCurrency.trim().toUpperCase() || "ZAR",
                });
                setProductName("");
                setProductAmount("");
              }, "Product saved")}
            >
              Save product
            </Button>
          </>
        )}
      >
        <Field label="Name">
          <Input value={productName} onChange={(event) => setProductName(event.target.value)} placeholder="SEO retainer" required />
        </Field>
        <MoneyFields value={productAmount} onValue={setProductAmount} currency={productCurrency} onCurrency={setProductCurrency} label="Price" />
      </Modal>

      <DealSheet
        deal={detailDeal}
        stages={stages}
        companies={(snapshot?.accounts ?? []).map((row) => ({ id: row.id, name: row.name }))}
        contacts={(snapshot?.contacts ?? []).map((row) => ({ id: row.id, name: row.name }))}
        billing={billingInstalled ? { prefill: BILLING_PREFILL } : null}
        onClose={() => setDetail(null)}
        onChanged={refresh}
      />
      <SequenceSheet sequence={detailSequence} gmail={gmail} onClose={() => setDetail(null)} onChanged={refresh} />
    </Page>
  );
}

/** Billing opens its quote form with the client and deal filled in from `new=1&dealId=`. */
const BILLING_PREFILL = true;

/** "3 · R 45,000.00": a stage's deals and value (in the first deal's currency). */
function stageTotal(deals: Array<{ amountMinor: number; currency: string }>): string {
  const currency = deals[0]?.currency ?? "ZAR";
  return formatMoney(deals.filter((deal) => deal.currency === currency).reduce((sum, deal) => sum + deal.amountMinor, 0), currency);
}

/** A money field typed in rand (not cents), with its currency. */
function MoneyFields({ value, onValue, currency, onCurrency, label }: { value: string; onValue: (value: string) => void; currency: string; onCurrency: (value: string) => void; label: string }) {
  const invalid = parseMoneyInput(value) === null;
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)", gap: 12 }}>
        <Field label={label}>
          <Input value={value} inputMode="decimal" onChange={(event) => onValue(event.target.value)} placeholder="15000" aria-invalid={invalid} />
        </Field>
        <Field label="Currency">
          <Input value={currency} maxLength={3} onChange={(event) => onCurrency(event.target.value.toUpperCase())} placeholder="ZAR" />
        </Field>
      </div>
      {invalid ? <span style={{ fontSize: 12, color: tone("bad").fg }}>Type an amount like 15000 or 15 000.50.</span> : null}
    </div>
  );
}

function OpenLink({ to, label, text = "Open" }: { to: string; label?: string; text?: string }) {
  const navigation = useHostNavigation();
  return (
    <a {...navigation.linkProps(to)} aria-label={label} style={linkButtonStyle}>
      {text}
    </a>
  );
}

/** A record's name in a table, linking to its page. */
function NameLink({ to, name }: { to: string; name: string }) {
  const navigation = useHostNavigation();
  return (
    <a {...navigation.linkProps(to)} style={{ color: tokens.fg, fontWeight: 600, textDecoration: "none", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={name}>
      {name}
    </a>
  );
}

function NameButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} style={{ appearance: "none", border: "none", background: "transparent", padding: 0, color: tokens.fg, fontWeight: 600, fontSize: 13, fontFamily: "inherit", cursor: "pointer", textAlign: "left" }}>
      {name}
    </button>
  );
}

const linkButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  height: 28,
  padding: "0 12px",
  borderRadius: 9,
  fontSize: 12,
  fontWeight: 600,
  background: tokens.secondary,
  color: tokens.secondaryFg,
  border: `1px solid ${tokens.border}`,
  textDecoration: "none",
  whiteSpace: "nowrap",
};

const smallButton: CSSProperties = { height: 28, fontSize: 12 };

// ---------------------------------------------------------------------------
// Client workspace: /crm?client=company:<id> or /crm?client=contact:<id>
// ---------------------------------------------------------------------------

interface WorkspaceCompany {
  id: string;
  name: string;
  domain: string | null;
  lifecycle: string;
  currency: string;
  tags: string[];
  humanOwned: string[];
  billingEmail: string | null;
  phone: string | null;
  address: string | null;
  vatNumber: string | null;
  registrationNumber: string | null;
}

interface WorkspaceContact {
  id: string;
  name: string;
  emails: string[];
  phones: string[];
  lifecycle: string;
  tags: string[];
  humanOwned: string[];
  nextActionKind: string | null;
  nextActionDueAt: string | null;
  emailStatus?: "ok" | "bounced" | "unsubscribed";
  leadScore?: LeadScore | null;
}

interface WorkspaceDeal {
  id: string;
  title: string;
  amountMinor: number;
  currency: string;
  stageId: string;
  stageName: string;
  stageKind: string;
  contactId: string | null;
  contactName: string | null;
  accountId: string | null;
}

interface WorkspaceData {
  found: boolean;
  kind: ClientRef["kind"];
  id: string;
  company?: WorkspaceCompany | null;
  contact?: WorkspaceContact | null;
  contacts?: Array<{ id: string; name: string; emails: string[]; lifecycle: string; roleLabel: string }>;
  companies?: Array<{ id: string; name: string; domain: string | null; lifecycle: string; roleLabel: string }>;
  deals?: WorkspaceDeal[];
  activities?: Activity[];
  stages?: Stage[];
  sequences?: Array<{ id: string; name: string }>;
  options?: { companies: Array<{ id: string; name: string }>; contacts: Array<{ id: string; name: string }> };
  profile?: ClientProfileView | null;
  clientLeads?: ClientLeadView[];
  leadForms?: LeadFormView[];
  sites?: SiteView[];
  projects?: ProjectView[];
  projectOptions?: ProjectView[];
  connectorDownload?: string | null;
  /** Client care: health, cases, requests, reports, sites, feedback, sensitivity (null when it could not be read). */
  care?: CareView | null;
  /** Documents to sign: whether e-sign is on for the client and its documents (null when it could not be read). */
  agreements?: AgreementsView | null;
  /** Where enquiries came from and the site visit counters (null when it could not be read). */
  growth?: GrowthView | null;
}

/** What `GET /api/plugins/<key>/api/client-summary` returns for one client. */
interface ClientSummary {
  headline: string;
  stats: Array<{ label: string; value: string | number; tone?: "ok" | "warn" | "bad" }>;
}

type SummaryState = { status: "loading" } | { status: "ok"; summary: ClientSummary } | { status: "error" };
type ScoreResult = {
  total: number;
  band: string;
  parts: Array<{ label: string; points: number }>;
  jev?: LeadScore | null;
  jevNote?: string;
};
type WorkspaceModal = "add-contact" | "link-company" | "deal" | null;
type Patch = Record<string, unknown>;

/** Each module's card on a client's page (only modules that are installed show). */
const WORK_SOURCES = [
  { tab: "social", label: "Social", pluginKey: "partnersinbiz.social", path: "/social" },
  { tab: "seo", label: "SEO", pluginKey: "partnersinbiz.seo", path: "/seo" },
  { tab: "campaigns", label: "Campaigns", pluginKey: "partnersinbiz.campaigns", path: "/campaigns" },
  { tab: "billing", label: "Billing", pluginKey: BILLING_PLUGIN, path: "/billing" },
] as const;

type WorkSource = (typeof WORK_SOURCES)[number];

function ClientWorkspace({ companyId, client }: { companyId: string | null; client: ClientRef }) {
  const navigation = useHostNavigation();
  const narrow = useIsNarrow();
  const load = usePluginAction("crm.client-workspace");
  const updateCompany = usePluginAction("crm.update-company");
  const updateContact = usePluginAction("crm.update-contact");
  const createCompany = usePluginAction("crm.create-company");
  const createContact = usePluginAction("crm.create-contact");
  const linkContact = usePluginAction("crm.link-contact");
  const createDeal = usePluginAction("crm.create-deal");
  const logActivity = usePluginAction("crm.log-activity");
  const setHumanOwned = usePluginAction("crm.set-human-owned");
  const enroll = usePluginAction("crm.enroll");
  const scoreContact = usePluginAction("crm.score-contact");
  const updateProfile = usePluginAction("crm.update-client-profile");
  const setEmailStatus = usePluginAction("crm.set-email-status");
  const deleteCompany = usePluginAction("crm.delete-company");
  const saveSite = usePluginAction("crm.save-client-site");
  const deleteSite = usePluginAction("crm.delete-client-site");
  const connectSite = usePluginAction("crm.connect-client-site");
  const checkSite = usePluginAction("crm.check-client-site");
  const linkProject = usePluginAction("crm.link-client-project");
  const unlinkProject = usePluginAction("crm.unlink-client-project");
  const createLeadForm = usePluginAction("crm.create-lead-endpoint");
  const updateLeadForm = usePluginAction("crm.update-lead-source");
  const rotateLeadForm = usePluginAction("crm.rotate-lead-key");
  const makeLeadSecret = usePluginAction("crm.make-lead-secret");
  const startNewClient = usePluginAction("crm.start-new-client");
  // Client care: one hook per page action the care card runs (`crm.<tool name>`).
  const careActions: Record<string, ReturnType<typeof usePluginAction>> = {
    "open-support-case": usePluginAction("crm.open-support-case"),
    "update-support-case": usePluginAction("crm.update-support-case"),
    "create-client-action": usePluginAction("crm.create-client-action"),
    "update-client-action": usePluginAction("crm.update-client-action"),
    "build-client-report": usePluginAction("crm.build-client-report"),
    "send-client-report": usePluginAction("crm.send-client-report"),
    "set-site-monitoring": usePluginAction("crm.set-site-monitoring"),
    "set-client-sensitivity": usePluginAction("crm.set-client-sensitivity"),
  };
  // Agreements and growth: e-sign on or off is a person's action; a document goes out only through an approved email.
  const agreementActions: Record<string, ReturnType<typeof usePluginAction>> = {
    "enable-esign": usePluginAction("crm.enable-esign"),
    "disable-esign": usePluginAction("crm.disable-esign"),
    "send-for-signature": usePluginAction("crm.send-for-signature"),
    "void-sign-document": usePluginAction("crm.void-sign-document"),
    "update-event-key": usePluginAction("crm.update-event-key"),
  };
  const createEventKey = usePluginAction("crm.create-event-key");
  // Only installed modules get a card, like the workspace tabs; nothing shows while that is unknown.
  const contributions = useUiContributions();
  const sources = WORK_SOURCES.filter((source) => moduleInstalled(contributions, source.pluginKey) === true);
  const billingInstalled = moduleInstalled(contributions, BILLING_PLUGIN) === true;
  const summaries = useClientSummaries(companyId, client, contributions === undefined ? null : sources);

  const [data, setData] = useState<WorkspaceData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [message, setMessage] = useState("");
  const [modal, setModal] = useState<WorkspaceModal>(null);
  const [openDealId, setOpenDealId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [locking, setLocking] = useState(false);

  const [pickMode, setPickMode] = useState<"new" | "existing">("new");
  const [pickName, setPickName] = useState("");
  const [pickEmail, setPickEmail] = useState("");
  const [pickId, setPickId] = useState("");
  const [pickRole, setPickRole] = useState("staff");
  const [dealTitle, setDealTitle] = useState("");
  const [dealAmount, setDealAmount] = useState("");
  const [dealCurrency, setDealCurrency] = useState("ZAR");
  const [dealPartyId, setDealPartyId] = useState("");
  const [note, setNote] = useState("");
  const [enrollSequenceId, setEnrollSequenceId] = useState("");
  const [score, setScore] = useState<ScoreResult | null>(null);

  async function refresh() {
    setData((await load({ kind: client.kind, id: client.id })) as WorkspaceData);
  }

  useEffect(() => {
    if (!companyId) return;
    let live = true;
    setLoadError("");
    load({ kind: client.kind, id: client.id })
      .then((result) => {
        if (live) setData(result as WorkspaceData);
      })
      .catch((error: unknown) => {
        if (live) setLoadError(errorText(error));
      });
    return () => {
      live = false;
    };
  }, [companyId, client.kind, client.id]);

  async function run(work: () => Promise<unknown>, success: string): Promise<boolean> {
    setMessage("");
    try {
      await work();
      await refresh();
      setMessage(success);
      setModal(null);
      return true;
    } catch (error) {
      setMessage(errorText(error));
      return false;
    }
  }

  // Before the client loads there is no workspace bar yet: the same "All clients" link stands in its place.
  const backLink = (
    <a {...navigation.linkProps("/crm?tab=companies")} style={{ fontSize: 12.5, color: tokens.muted, textDecoration: "none", width: "fit-content", minHeight: 24, display: "inline-flex", alignItems: "center" }}>← All clients</a>
  );

  if (!data) {
    return (
      <WorkspaceShell>
        {backLink}
        {loadError ? (
          <EmptyState
            title="Could not load this client"
            description={loadError}
            action={(
              <Button type="button" onClick={() => {
                setLoadError("");
                refresh().catch((error: unknown) => setLoadError(errorText(error)));
              }}>
                Try again
              </Button>
            )}
          />
        ) : (
          <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>Loading client…</p>
        )}
      </WorkspaceShell>
    );
  }

  if (!data.found || (!data.company && !data.contact)) {
    return (
      <WorkspaceShell>
        <EmptyState
          title={client.kind === "company" ? "Company not found" : "Contact not found"}
          description="This client may have been deleted or merged into another record, or it has not been shared with you."
          action={<a {...navigation.linkProps("/crm?tab=companies")} style={{ ...linkButtonStyle, height: narrow ? 40 : 36, padding: "0 14px", fontSize: 13 }}>See all clients</a>}
        />
      </WorkspaceShell>
    );
  }

  const company = data.company ?? null;
  const contact = data.contact ?? null;
  const record = company ?? contact!;
  const name = company?.name ?? contact?.name ?? "Client";
  const contacts = data.contacts ?? [];
  const companies = data.companies ?? [];
  const detail = company
    ? [company.domain, LIFECYCLE_LABEL[company.lifecycle] ?? company.lifecycle].filter(Boolean).join(" · ")
    : [LIFECYCLE_LABEL[contact!.lifecycle] ?? contact!.lifecycle, companies[0]?.name].filter(Boolean).join(" · ");
  const deals = data.deals ?? [];
  const stages = data.stages ?? [];
  const sequences = data.sequences ?? [];
  const options = data.options ?? { companies: [], contacts: [] };
  const linkedIds = new Set((company ? contacts : companies).map((row) => row.id));
  const pickChoices = (company ? options.contacts : options.companies).filter((row) => !linkedIds.has(row.id));
  const pickReady = pickMode === "new" ? pickName.trim() !== "" : pickId !== "";
  const openDeal = openDealId ? deals.find((deal) => deal.id === openDealId) ?? null : null;
  const dealView: DealView | null = openDeal
    ? { id: openDeal.id, title: openDeal.title, amountMinor: openDeal.amountMinor, currency: openDeal.currency, stageId: openDeal.stageId, accountId: openDeal.accountId, contactId: openDeal.contactId }
    : null;

  function openModal(next: Exclude<WorkspaceModal, null>) {
    setPickMode(next === "link-company" && pickChoices.length > 0 ? "existing" : "new");
    setPickName("");
    setPickEmail("");
    setPickId("");
    setPickRole("staff");
    setDealTitle("");
    setDealAmount("");
    setDealCurrency(company?.currency ?? "ZAR");
    setDealPartyId(contact && companies.length === 1 ? companies[0]!.id : "");
    setModal(next);
  }

  async function saveDetails(patch: Patch): Promise<boolean> {
    let refused: string[] = [];
    const ok = await run(async () => {
      const result = company
        ? await updateCompany({ companyRecordId: company.id, ...patch })
        : await updateContact({ contactId: contact!.id, ...patch });
      refused = (result as { refused?: string[] } | null)?.refused ?? [];
    }, "Details saved");
    if (ok && refused.length > 0) setMessage(`Saved. These locked fields were kept: ${refused.join(", ")}`);
    return ok;
  }

  async function saveProfile(patch: Patch, success = "Profile saved"): Promise<boolean> {
    let refused: string[] = [];
    const ok = await run(async () => {
      const result = await updateProfile({ client: `${client.kind}:${client.id}`, ...patch });
      refused = (result as { refused?: string[] } | null)?.refused ?? [];
    }, success);
    if (ok && refused.length > 0) setMessage(`Saved. These fields were kept: ${refused.join(", ")}`);
    return ok;
  }

  /** A field's lock: only people may change it once it has a value. */
  async function toggleLock(keys: string[], lock: boolean, label: string) {
    setLocking(true);
    await run(
      () => setHumanOwned({ recordType: client.kind, recordId: client.id, humanOwned: toggleOwned(record.humanOwned, keys, lock) }),
      lock ? `${label}: only people can change it now.` : `${label}: agents can change it again.`,
    );
    setLocking(false);
  }

  function submitPick() {
    if (company) {
      void run(async () => {
        let contactId = pickId;
        if (pickMode === "new") {
          const created = (await createContact({
            name: pickName,
            emails: pickEmail.trim() ? [pickEmail.trim()] : [],
          })) as { id: string };
          contactId = created.id;
        }
        await linkContact({ contactId, companyRecordId: company.id, roleLabel: pickRole });
      }, "Contact added");
      return;
    }
    if (contact) {
      void run(async () => {
        let accountId = pickId;
        if (pickMode === "new") {
          const created = (await createCompany({ name: pickName })) as { id: string };
          accountId = created.id;
        }
        await linkContact({ contactId: contact.id, companyRecordId: accountId, roleLabel: pickRole });
      }, "Linked to company");
    }
  }

  const scoreShown = score?.jev ?? contact?.leadScore ?? null;

  return (
    <WorkspaceShell>
      <ClientWorkspaceBar
        client={{ kind: client.kind, id: client.id, name, detail }}
        active="overview"
        linkProps={navigation.linkProps}
        ownPath="/crm?tab=companies"
        actions={(
          <>
            <Button type="button" onClick={() => openModal("deal")}>+ Deal</Button>
            {company ? (
              <MoreMenu
                label={`More actions for ${name}`}
                items={[{ key: "delete", label: "Delete company…", destructive: true, onSelect: () => setDeleting(true) }]}
              />
            ) : null}
          </>
        )}
      />
      <PageMessage message={message || undefined} />

      <WorkspaceKpis company={company} contact={contact} deals={deals} contacts={contacts} activities={data.activities ?? []} score={scoreShown} />

      {sources.length > 0 ? (
        <div style={{ display: "grid", gridTemplateColumns: fluidColumns(200), gap: 12 }}>
          {sources.map((source) => (
            <WorkCard
              key={source.tab}
              label={source.label}
              module={source.tab}
              state={summaries[source.tab] ?? { status: "loading" }}
              link={navigation.linkProps(withClientParam(source.path, client))}
            />
          ))}
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 380px), 1fr))", gap: 16, alignItems: "start" }}>
        <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
          {company ? <CompanyDetails company={company} onSave={saveDetails} locking={locking} onLock={(keys, lock, label) => void toggleLock(keys, lock, label)} /> : null}
          {contact ? <ContactDetails contact={contact} onSave={saveDetails} locking={locking} onLock={(keys, lock, label) => void toggleLock(keys, lock, label)} /> : null}
          {/* The client's profile: a company, or a contact who is a client in their own right (a sole trader). */}
          {company || companies.length === 0 ? <ClientProfileCard profile={data.profile ?? null} onSave={saveProfile} /> : null}
          {company || companies.length === 0 ? (
            <WebsitesCard
              sites={data.sites ?? []}
              projects={data.projects ?? []}
              download={data.connectorDownload ?? null}
              projectLinkProps={(path) => navigation.linkProps(path)}
              onSave={(patch, success) => run(() => saveSite({ client: `${client.kind}:${client.id}`, ...patch }), success)}
              onDelete={(siteId) => run(() => deleteSite({ siteId }), "Website removed")}
              onConnect={async (siteId) => {
                setMessage("");
                try {
                  const result = (await connectSite({ siteId })) as ConnectResult;
                  await refresh();
                  return result;
                } catch (error) {
                  setMessage(errorText(error));
                  return null;
                }
              }}
              onCheck={async (siteId) => {
                setMessage("");
                try {
                  const result = (await checkSite({ siteId })) as { connected?: boolean; error?: string; warnings?: string[] };
                  await refresh();
                  setMessage(result.connected ? ["Connector answers.", ...(result.warnings ?? [])].join(" ") : result.error ?? "The site did not answer.");
                  return Boolean(result.connected);
                } catch (error) {
                  setMessage(errorText(error));
                  return false;
                }
              }}
            />
          ) : null}
          {company || companies.length === 0 ? (
            <LeadFormsCard
              forms={data.leadForms ?? []}
              sites={(data.sites ?? []).map((site) => ({ id: site.id, url: site.url, label: site.label }))}
              onCreate={async (params) => {
                setMessage("");
                try {
                  const result = (await createLeadForm({ client: `${client.kind}:${client.id}`, ...params })) as CreatedLeadForm;
                  await refresh();
                  setMessage(result.created ? "Lead form made" : "That form already exists");
                  return result;
                } catch (error) {
                  setMessage(errorText(error));
                  return null;
                }
              }}
              onUpdate={(params, success) => run(() => updateLeadForm(params), success)}
              onSecret={async (sourceId) => {
                setMessage("");
                try {
                  const result = (await makeLeadSecret({ sourceId })) as { serverSecret?: string; serverSecretNote?: string };
                  await refresh();
                  setMessage("Signing secret made. It is shown once: copy it now.");
                  return result;
                } catch (error) {
                  setMessage(errorText(error));
                  return null;
                }
              }}
              onRotate={async (sourceId, serverSecret) => {
                setMessage("");
                try {
                  const result = (await rotateLeadForm({ sourceId, serverSecret })) as { serverSecret?: string; serverSecretNote?: string; oldKeyValidUntil?: string };
                  await refresh();
                  setMessage(`New key made. The old one works until ${result.oldKeyValidUntil?.slice(0, 10) ?? "next week"}: put the new snippet on the site before then.`);
                  return result;
                } catch (error) {
                  setMessage(errorText(error));
                  return null;
                }
              }}
            />
          ) : null}
          {company || companies.length === 0 ? (
            <ProjectsCard
              projects={data.projects ?? []}
              options={data.projectOptions ?? []}
              projectLinkProps={(path) => navigation.linkProps(path)}
              onLink={(projectId) => run(() => linkProject({ client: `${client.kind}:${client.id}`, projectId }), "Project linked")}
              onUnlink={(projectId) => run(() => unlinkProject({ client: `${client.kind}:${client.id}`, projectId }), "Project unlinked")}
            />
          ) : null}
          {company || companies.length === 0 ? (
            <NewClientCard
              onLoad={async () => {
                setMessage("");
                try {
                  return (await startNewClient({ client: `${client.kind}:${client.id}` })) as ChecklistResult;
                } catch (error) {
                  setMessage(errorText(error));
                  return null;
                }
              }}
            />
          ) : null}

          {company ? (
            <SectionCard
              title={`People (${contacts.length})`}
              icon={Users}
              actions={<Button type="button" variant="secondary" style={smallButton} onClick={() => openModal("add-contact")}>+ Add contact</Button>}
            >
              {contacts.length === 0 ? (
                <Muted>No one is linked to this company yet. Add the people you deal with there.</Muted>
              ) : narrow ? (
                <CompactRows
                  label="People"
                  rows={contacts}
                  title={(row) => row.name}
                  meta={(row) => [row.roleLabel, row.emails[0]].filter(Boolean).join(" · ")}
                  linkFor={(row) => navigation.linkProps(clientPath("contact", row.id)) as unknown as Record<string, unknown>}
                />
              ) : (
                <DataTable
                  columns={[
                    { key: "name", header: "Name", render: (value, row) => <NameLink to={clientPath("contact", String(row.id))} name={String(value)} /> },
                    { key: "email", header: "Email", render: (value) => value ? <EmailText email={String(value)} /> : <span style={{ color: tokens.muted }}>—</span> },
                    { key: "roleLabel", header: "Role", width: "100px" },
                    {
                      key: "id",
                      header: "",
                      width: "72px",
                      render: (_value, row) => <OpenLink to={clientPath("contact", String(row.id))} label={`Open ${String(row.name)}`} />,
                    },
                  ]}
                  rows={contacts.map((row) => ({ ...row, email: row.emails[0] ?? "" }))}
                  emptyMessage="No contacts."
                />
              )}
            </SectionCard>
          ) : null}

          {contact ? (
            <SectionCard
              title={`Companies (${companies.length})`}
              icon={Building2}
              actions={<Button type="button" variant="secondary" style={smallButton} onClick={() => openModal("link-company")}>Link to company</Button>}
            >
              {companies.length === 0 ? (
                <Muted>Not linked to a company. A sole trader can stay that way.</Muted>
              ) : narrow ? (
                <CompactRows
                  label="Companies"
                  rows={companies}
                  title={(row) => row.name}
                  meta={(row) => row.roleLabel}
                  trailing={(row) => <LifecyclePill lifecycle={row.lifecycle} size="sm" />}
                  linkFor={(row) => navigation.linkProps(clientPath("company", row.id)) as unknown as Record<string, unknown>}
                />
              ) : (
                <DataTable
                  columns={[
                    { key: "name", header: "Company", render: (value, row) => <NameLink to={clientPath("company", String(row.id))} name={String(value)} /> },
                    { key: "roleLabel", header: "Role" },
                    { key: "lifecycle", header: "Lifecycle", render: (value) => <LifecyclePill lifecycle={String(value)} /> },
                    {
                      key: "id",
                      header: "",
                      width: "72px",
                      render: (_value, row) => <OpenLink to={clientPath("company", String(row.id))} label={`Open ${String(row.name)}`} />,
                    },
                  ]}
                  rows={companies as unknown as Record<string, unknown>[]}
                  emptyMessage="No companies."
                />
              )}
            </SectionCard>
          ) : null}

          <SectionCard title={`Deals (${deals.length})`} icon={Briefcase}>
            {deals.length === 0 ? (
              <Muted>No deals for this client yet. Start one with + Deal at the top.</Muted>
            ) : narrow ? (
              <CompactRows
                label="Deals"
                rows={deals}
                title={(deal) => deal.title}
                meta={(deal) => [deal.stageName, company ? deal.contactName : null].filter(Boolean).join(" · ")}
                trailing={(deal) => deal.amountMinor > 0 ? formatMoney(deal.amountMinor, deal.currency) : <span style={{ color: tone("warn").fg }}>No value</span>}
                onOpen={(deal) => setOpenDealId(deal.id)}
              />
            ) : (
              <DataTable
                columns={[
                  { key: "title", header: "Deal", render: (value, row) => <NameButton name={String(value)} onClick={() => setOpenDealId(String(row.id))} /> },
                  { key: "amount", header: "Value", render: (_value, row) => {
                    const deal = row as unknown as WorkspaceDeal;
                    return deal.amountMinor > 0 ? <span style={{ whiteSpace: "nowrap" }}>{formatMoney(deal.amountMinor, deal.currency)}</span> : <Pill tone="warn" size="sm" dot>No value</Pill>;
                  } },
                  { key: "stageName", header: "Stage", render: (value, row) => <StagePill name={String(value)} kind={String((row as unknown as WorkspaceDeal).stageKind)} size="sm" /> },
                  ...(company ? [{ key: "contactName", header: "Contact" }] : []),
                  {
                    key: "id",
                    header: "",
                    width: "72px",
                    render: (_value, row) => (
                      <Button type="button" variant="secondary" style={smallButton} onClick={() => setOpenDealId(String(row.id))}>Open</Button>
                    ),
                  },
                ]}
                rows={deals.map((deal) => ({ ...deal, amount: "", contactName: deal.contactName ?? "—" }))}
                emptyMessage="No deals."
              />
            )}
          </SectionCard>
        </div>

        <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
          <SectionCard title="Activity" icon={ActivityIcon} subtitle="Emails, notes and deal moves, newest first.">
            <Form onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await logActivity({ recordType: client.kind, recordId: client.id, kind: "note", body: note });
                setNote("");
              }, "Note logged");
            }}>
              <TextArea
                aria-label="Note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Log a note, a call summary or the next step…"
              />
              <div>
                <Button type="submit" variant="secondary" disabled={!note.trim()}>Log note</Button>
              </div>
            </Form>
            <ActivityTimeline items={data.activities ?? []} limit={12} />
          </SectionCard>

          {(company || companies.length === 0) && careVisible(data.care) ? (
            <ClientCareCard
              care={data.care!}
              clientRef={`${client.kind}:${client.id}`}
              onRun={(action, params, success) => run(() => careActions[action]!(params), success)}
            />
          ) : null}

          {(company || companies.length === 0) && agreementsVisible(data.agreements, data.growth) ? (
            <ClientAgreementsCard
              agreements={data.agreements ?? null}
              growth={data.growth ?? null}
              clientRef={`${client.kind}:${client.id}`}
              clientName={name}
              onRun={(action, params, success) => run(() => agreementActions[action]!(params), success)}
              onCreateKey={async (params) => {
                setMessage("");
                try {
                  const result = (await createEventKey(params)) as CreatedKey;
                  await refresh();
                  setMessage(result.created === false ? "That counter already exists" : "Counter made. Nothing is installed: the text is for the client's developer.");
                  return result;
                } catch (error) {
                  setMessage(errorText(error));
                  return null;
                }
              }}
            />
          ) : null}

          {company || companies.length === 0 ? <ClientLeadsCard leads={data.clientLeads ?? []} /> : null}

          {contact ? (
            <SectionCard title="Contact tools" icon={Target}>
              <EmailStatusControl
                key={contact.emailStatus ?? "ok"}
                status={(contact.emailStatus ?? "ok") as EmailStatus}
                onSave={(status, why) => run(() => setEmailStatus({ contactId: contact.id, status, note: why }), status === "ok" ? "Email allowed again" : "Email status saved. Sequences stopped and the other modules were told.")}
              />
              {scoreShown ? <LeadScoreCard score={scoreShown} when={formatDate(scoreShown.scoredAt)} /> : null}
              <div style={{ display: "grid", gap: 8 }}>
                <div>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void scoreContact({ contactId: contact.id })
                      .then((result) => setScore(result as ScoreResult))
                      .catch((error: unknown) => setMessage(errorText(error)))}
                  >
                    Score this contact
                  </Button>
                </div>
                {score ? <ScoreCard score={score} /> : null}
              </div>
              {sequences.length === 0 ? (
                <Muted>No sequences yet. Create one on the CRM's Sequences tab to enroll this contact.</Muted>
              ) : (
                <Form onSubmit={(event) => {
                  event.preventDefault();
                  void run(() => enroll({ sequenceId: enrollSequenceId, contactId: contact.id }), "Contact enrolled");
                }}>
                  <Field label="Enroll in a sequence">
                    <Select value={enrollSequenceId} onChange={(event) => setEnrollSequenceId(event.target.value)} required>
                      <option value="">Choose a sequence</option>
                      {sequences.map((sequence) => <option key={sequence.id} value={sequence.id}>{sequence.name}</option>)}
                    </Select>
                  </Field>
                  <div>
                    <Button type="submit" variant="secondary" disabled={!enrollSequenceId}>Enroll</Button>
                  </div>
                </Form>
              )}
            </SectionCard>
          ) : null}
        </div>
      </div>

      <Modal
        open={modal === "add-contact" || modal === "link-company"}
        title={company ? `Add a contact to ${name}` : `Link ${name} to a company`}
        description={company
          ? "Create a new person or link someone already in the CRM."
          : "Pick a company this person works for, or create one."}
        onClose={() => setModal(null)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setModal(null)}>Cancel</Button>
            <Button type="button" disabled={!pickReady} onClick={submitPick}>{company ? "Add contact" : "Save link"}</Button>
          </>
        )}
      >
        <Field label="Add">
          <Select
            value={pickMode}
            onChange={(event) => {
              setPickMode(event.target.value === "existing" ? "existing" : "new");
              setPickId("");
            }}
          >
            <option value="new">{company ? "A new contact" : "A new company"}</option>
            <option value="existing">{company ? "Someone already in the CRM" : "A company already in the CRM"}</option>
          </Select>
        </Field>
        {pickMode === "new" ? (
          <>
            <Field label={company ? "Name" : "Company name"}>
              <Input value={pickName} onChange={(event) => setPickName(event.target.value)} placeholder={company ? "Ada Lovelace" : "Northwind"} required />
            </Field>
            {company ? (
              <Field label="Email">
                <Input value={pickEmail} type="email" onChange={(event) => setPickEmail(event.target.value)} placeholder="ada@northwind.test" />
              </Field>
            ) : null}
          </>
        ) : (
          <Field label={company ? "Contact" : "Company"}>
            <Select value={pickId} onChange={(event) => setPickId(event.target.value)} required>
              <option value="">{pickChoices.length === 0 ? "Nothing left to link" : "Select…"}</option>
              {pickChoices.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Role">
          <Input value={pickRole} onChange={(event) => setPickRole(event.target.value)} placeholder="buyer, staff, owner" />
        </Field>
      </Modal>

      <Modal
        open={modal === "deal"}
        title={`New deal for ${name}`}
        description="A sale in progress. It starts in the first stage."
        onClose={() => setModal(null)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setModal(null)}>Cancel</Button>
            <Button
              type="button"
              disabled={!dealTitle.trim() || parseMoneyInput(dealAmount) === null}
              onClick={() => void run(() => createDeal({
                title: dealTitle,
                amountMinor: parseMoneyInput(dealAmount) ?? 0,
                currency: dealCurrency.trim().toUpperCase() || "ZAR",
                companyRecordId: company ? company.id : dealPartyId || undefined,
                contactId: contact ? contact.id : dealPartyId || undefined,
              }), "Deal saved")}
            >
              Save deal
            </Button>
          </>
        )}
      >
        <Field label="Title">
          <Input value={dealTitle} onChange={(event) => setDealTitle(event.target.value)} placeholder="Website rebuild" required />
        </Field>
        <MoneyFields value={dealAmount} onValue={setDealAmount} currency={dealCurrency} onCurrency={setDealCurrency} label="Value" />
        {company ? (
          <Field label="Contact">
            <Select value={dealPartyId} onChange={(event) => setDealPartyId(event.target.value)}>
              <option value="">None yet</option>
              {contacts.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
            </Select>
          </Field>
        ) : (
          <Field label="Company">
            <Select value={dealPartyId} onChange={(event) => setDealPartyId(event.target.value)}>
              <option value="">None yet</option>
              {companies.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
            </Select>
          </Field>
        )}
      </Modal>

      {company ? (
        <DeleteCompanyDialog
          open={deleting}
          name={company.name}
          onClose={() => setDeleting(false)}
          onDelete={async () => {
            setMessage("");
            try {
              await deleteCompany({ companyRecordId: company.id, confirm: company.name });
              navigation.navigate("/crm?tab=companies");
              return true;
            } catch (error) {
              setMessage(errorText(error));
              return false;
            }
          }}
        />
      ) : null}

      <DealSheet
        deal={dealView}
        stages={stages}
        companies={options.companies}
        contacts={options.contacts}
        billing={billingInstalled ? { prefill: BILLING_PREFILL } : null}
        onClose={() => setOpenDealId(null)}
        onChanged={refresh}
      />
    </WorkspaceShell>
  );
}

function CompanyDetails({ company, onSave, locking, onLock }: {
  company: WorkspaceCompany;
  onSave: (patch: Patch) => Promise<boolean>;
  locking: boolean;
  onLock: (keys: string[], lock: boolean, label: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [lifecycle, setLifecycle] = useState("lead");
  const [currency, setCurrency] = useState("ZAR");
  const [tags, setTags] = useState("");
  const [billingEmail, setBillingEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [vatNumber, setVatNumber] = useState("");
  const [registrationNumber, setRegistrationNumber] = useState("");

  function startEdit() {
    setName(company.name);
    setDomain(company.domain ?? "");
    setLifecycle(company.lifecycle);
    setCurrency(company.currency);
    setTags(company.tags.join(", "));
    setBillingEmail(company.billingEmail ?? "");
    setPhone(company.phone ?? "");
    setAddress(company.address ?? "");
    setVatNumber(company.vatNumber ?? "");
    setRegistrationNumber(company.registrationNumber ?? "");
    setEditing(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    const ok = await onSave({ name, domain, lifecycle, currency, tags: splitList(tags), billingEmail, phone, address, vatNumber, registrationNumber });
    setSaving(false);
    if (ok) setEditing(false);
  }

  const rows: FieldRow[] = [
    { key: "name", label: "Name", value: company.name },
    { key: "domain", label: "Website", value: company.domain ? <span style={{ overflowWrap: "anywhere" }}>{company.domain}</span> : <NotSet /> },
    { key: "lifecycle", label: "Lifecycle", value: <LifecyclePill lifecycle={company.lifecycle} /> },
    { key: "currency", label: "Currency", value: company.currency },
    { key: "tags", label: "Tags", value: company.tags.join(", ") || <NotSet /> },
    { key: "billingEmail", label: "Billing email", value: company.billingEmail ? <span style={{ overflowWrap: "anywhere" }}>{company.billingEmail}</span> : <NotSet /> },
    { key: "phone", label: "Phone", value: company.phone || <NotSet /> },
    { key: "address", label: "Address", value: company.address ? <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{company.address}</span> : <NotSet /> },
    { key: "vatNumber", label: "VAT no.", value: company.vatNumber || <NotSet /> },
    { key: "registrationNumber", label: "Reg. no.", value: company.registrationNumber || <NotSet /> },
  ];

  return (
    <SectionCard
      title="Details"
      icon={Building2}
      actions={editing ? undefined : <Button type="button" variant="secondary" style={smallButton} onClick={startEdit}>Edit</Button>}
    >
      {editing ? (
        <Form onSubmit={(event) => void submit(event)}>
          <Field label="Company name">
            <Input value={name} onChange={(event) => setName(event.target.value)} required />
          </Field>
          <Field label="Website">
            <Input value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="northwind.test" />
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)", gap: 12 }}>
            <Field label="Lifecycle">
              <LifecycleSelect value={lifecycle} onChange={setLifecycle} />
            </Field>
            <Field label="Currency">
              <Input value={currency} maxLength={3} onChange={(event) => setCurrency(event.target.value.toUpperCase())} />
            </Field>
          </div>
          <Field label="Tags (comma separated)">
            <Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="retainer, priority" />
          </Field>
          <Field label="Billing email">
            <Input type="email" value={billingEmail} maxLength={254} onChange={(event) => setBillingEmail(event.target.value)} placeholder="accounts@northwind.test" />
          </Field>
          <Field label="Phone">
            <Input value={phone} maxLength={64} onChange={(event) => setPhone(event.target.value)} />
          </Field>
          <Field label="Address">
            <TextArea value={address} rows={3} maxLength={500} onChange={(event) => setAddress(event.target.value)} placeholder={"12 Main Road\nCape Town\n8001"} />
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 12 }}>
            <Field label="VAT no.">
              <Input value={vatNumber} maxLength={64} onChange={(event) => setVatNumber(event.target.value)} />
            </Field>
            <Field label="Reg. no.">
              <Input value={registrationNumber} maxLength={64} onChange={(event) => setRegistrationNumber(event.target.value)} />
            </Field>
          </div>
          <EditButtons saving={saving} onCancel={() => setEditing(false)} />
        </Form>
      ) : (
        <FieldList rows={rows} owned={company.humanOwned} busy={locking} onToggle={onLock} />
      )}
    </SectionCard>
  );
}

function ContactDetails({ contact, onSave, locking, onLock }: {
  contact: WorkspaceContact;
  onSave: (patch: Patch) => Promise<boolean>;
  locking: boolean;
  onLock: (keys: string[], lock: boolean, label: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [emails, setEmails] = useState("");
  const [phones, setPhones] = useState("");
  const [lifecycle, setLifecycle] = useState("lead");
  const [tags, setTags] = useState("");
  const [nextKind, setNextKind] = useState("");
  const [nextDue, setNextDue] = useState("");

  function startEdit() {
    setName(contact.name);
    setEmails(contact.emails.join(", "));
    setPhones(contact.phones.join(", "));
    setLifecycle(contact.lifecycle);
    setTags(contact.tags.join(", "));
    setNextKind(contact.nextActionKind ?? "");
    setNextDue(dateInputValue(contact.nextActionDueAt));
    setEditing(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    const ok = await onSave({
      name,
      emails: splitList(emails),
      phones: splitList(phones),
      lifecycle,
      tags: splitList(tags),
      nextActionKind: nextKind || null,
      nextActionDueAt: nextKind && nextDue ? nextDue : null,
    });
    setSaving(false);
    if (ok) setEditing(false);
  }

  const rows: FieldRow[] = [
    { key: "name", label: "Name", value: contact.name },
    {
      key: "emails",
      label: contact.emails.length > 1 ? "Emails" : "Email",
      value: contact.emails.length ? <span style={{ display: "grid", gap: 2, minWidth: 0 }}>{contact.emails.map((email) => <EmailText key={email} email={email} />)}</span> : <NotSet />,
    },
    { key: "phones", label: contact.phones.length > 1 ? "Phones" : "Phone", value: contact.phones.join(", ") || <NotSet /> },
    { key: "lifecycle", label: "Lifecycle", value: <LifecyclePill lifecycle={contact.lifecycle} /> },
    {
      key: "nextAction",
      label: "Next action",
      lockKeys: ["nextActionKind", "nextActionDueAt"],
      value: contact.nextActionKind
        ? <Pill tone={dueTone(contact.nextActionDueAt)} icon={Clock}>{nextActionText(contact.nextActionKind, contact.nextActionDueAt)}</Pill>
        : <NotSet />,
    },
    { key: "tags", label: "Tags", value: contact.tags.join(", ") || <NotSet /> },
  ];

  return (
    <SectionCard
      title="Details"
      icon={UserRound}
      actions={editing ? undefined : <Button type="button" variant="secondary" style={smallButton} onClick={startEdit}>Edit</Button>}
    >
      {editing ? (
        <Form onSubmit={(event) => void submit(event)}>
          <Field label="Name">
            <Input value={name} onChange={(event) => setName(event.target.value)} required />
          </Field>
          <Field label="Emails (comma separated)">
            <Input value={emails} onChange={(event) => setEmails(event.target.value)} placeholder="ada@northwind.test" />
          </Field>
          <Field label="Phones (comma separated)">
            <Input value={phones} onChange={(event) => setPhones(event.target.value)} placeholder="+27 82 000 0000" />
          </Field>
          <Field label="Lifecycle">
            <LifecycleSelect value={lifecycle} onChange={setLifecycle} />
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 12 }}>
            <Field label="Next action">
              <Select value={nextKind} onChange={(event) => setNextKind(event.target.value)}>
                <option value="">None</option>
                {NEXT_ACTION_OPTIONS.map((option) => <option key={option} value={option}>{NEXT_ACTION_LABEL[option]}</option>)}
              </Select>
            </Field>
            <Field label="Due">
              <Input type="date" value={nextDue} disabled={!nextKind} onChange={(event) => setNextDue(event.target.value)} />
            </Field>
          </div>
          <Field label="Tags (comma separated)">
            <Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="decision-maker" />
          </Field>
          <EditButtons saving={saving} onCancel={() => setEditing(false)} />
        </Form>
      ) : (
        <FieldList rows={rows} owned={contact.humanOwned} busy={locking} onToggle={onLock} />
      )}
    </SectionCard>
  );
}

function NotSet() {
  return <span style={{ color: tokens.muted }}>Not set</span>;
}

function LifecycleSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <Select value={value} onChange={(event) => onChange(event.target.value)}>
      {LIFECYCLE_OPTIONS.map((option) => <option key={option} value={option}>{LIFECYCLE_LABEL[option] ?? option}</option>)}
    </Select>
  );
}

function EditButtons({ saving, onCancel }: { saving: boolean; onCancel: () => void }) {
  return (
    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
      <Button type="button" variant="secondary" onClick={onCancel} disabled={saving}>Cancel</Button>
      <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
    </div>
  );
}

/** Why only the basic score shows (the smart scoring is an optional add-on in the CRM settings). */
function scoreNote(score: ScoreResult): string | null {
  if (score.jev) return null;
  if (!score.jevNote) return null;
  return /not set up/i.test(score.jevNote)
    ? "Basic score. Smart scoring (optional) is off in the CRM settings."
    : "Basic score. Smart scoring did not answer this time.";
}

function ScoreCard({ score }: { score: ScoreResult }) {
  const note = scoreNote(score);
  return (
    <div style={{ display: "grid", gap: 6, padding: 10, borderRadius: 10, border: `1px solid ${tokens.border}`, background: tokens.bg }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <strong style={{ fontSize: 20, fontVariantNumeric: "tabular-nums" }}>{score.total}<span style={{ fontSize: 12, color: tokens.muted }}>/100</span></strong>
        <BandPill band={score.band} />
      </div>
      {score.parts.length > 0 ? (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 4, fontSize: 12 }}>
          {score.parts.map((part) => (
            <li key={part.label} style={{ display: "flex", justifyContent: "space-between", color: tokens.muted }}>
              <span>{part.label}</span>
              <span>+{part.points}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {note ? <span style={{ fontSize: 11.5, color: tokens.muted }}>{note}</span> : null}
    </div>
  );
}

function WorkCard({ label, module, state, link }: {
  label: string;
  module: string;
  state: SummaryState;
  link: { href?: string; onClick: (event: ReactMouseEvent<HTMLAnchorElement>) => void };
}) {
  return (
    <a
      {...link}
      aria-label={`Open ${label} for this client`}
      className="pib-link-card"
      style={{
        display: "grid",
        gap: 10,
        alignContent: "start",
        minHeight: 96,
        padding: 14,
        borderRadius: 14,
        border: `1px solid ${tokens.border}`,
        background: tokens.card,
        color: tokens.fg,
        textDecoration: "none",
        boxShadow: "0 1px 2px color-mix(in oklab, black 4%, transparent)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <IconBadge icon={moduleAccent(module).icon} accent={moduleAccent(module)} size="sm" />
          <span style={{ fontSize: 13.5, fontWeight: 650 }}>{label}</span>
        </span>
        <span style={{ fontSize: 12, fontWeight: 600, color: tokens.primary }}>Open →</span>
      </div>
      {state.status === "loading" ? <span style={{ fontSize: 12.5, color: tokens.muted }}>Loading…</span> : null}
      {state.status === "error" ? <span style={{ fontSize: 12.5, color: tokens.muted }}>Nothing to show yet. Open it to see this client's work.</span> : null}
      {state.status === "ok" ? (
        <>
          {state.summary.headline ? (
            <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35 }}>{displayText(state.summary.headline)}</div>
          ) : null}
          {state.summary.stats.length > 0 ? (
            <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(92px, 1fr))", gap: 8 }}>
              {state.summary.stats.map((stat) => (
                <div key={stat.label} style={{ display: "grid", gap: 2, minWidth: 0 }}>
                  <dt style={{ fontSize: 11, color: tokens.muted, overflowWrap: "anywhere" }}>{stat.label}</dt>
                  <dd style={{
                    margin: 0,
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    fontSize: 15,
                    fontWeight: 650,
                    fontVariantNumeric: "tabular-nums",
                    color: stat.tone === "bad" ? tone("bad").fg : tokens.fg,
                  }}>
                    {stat.tone ? <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 999, flexShrink: 0, background: tone(stat.tone).solid }} /> : null}
                    <span style={{ minWidth: 0 }}>{typeof stat.value === "string" ? displayText(stat.value) : stat.value}</span>
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </>
      ) : null}
    </a>
  );
}

/**
 * Fetches each installed module's client summary in parallel. `sources` is
 * null while it is not known which modules are installed (nothing is fetched
 * yet). A failing summary shows as `error`.
 */
function useClientSummaries(companyId: string | null, client: ClientRef, sources: readonly WorkSource[] | null): Partial<Record<WorkSource["tab"], SummaryState>> {
  const [states, setStates] = useState<Partial<Record<WorkSource["tab"], SummaryState>>>({});
  const keys = sources ? sources.map((source) => source.tab).join(",") : null;
  useEffect(() => {
    if (!sources) return;
    setStates(Object.fromEntries(sources.map((source) => [source.tab, { status: companyId ? "loading" : "error" }])));
    if (!companyId) return;
    const controller = new AbortController();
    for (const source of sources) {
      fetchClientSummary(source.pluginKey, companyId, client, controller.signal)
        .then((summary) => {
          if (controller.signal.aborted) return;
          setStates((prev) => ({ ...prev, [source.tab]: summary ? { status: "ok", summary } : { status: "error" } }));
        })
        .catch(() => {
          if (!controller.signal.aborted) setStates((prev) => ({ ...prev, [source.tab]: { status: "error" } }));
        });
    }
    return () => controller.abort();
  }, [companyId, client.kind, client.id, keys]);
  return states;
}

async function fetchClientSummary(
  pluginKey: string,
  companyId: string,
  client: ClientRef,
  signal: AbortSignal,
): Promise<ClientSummary | null> {
  const query = new URLSearchParams({ companyId, kind: client.kind, id: client.id });
  const response = await fetch(`/api/plugins/${encodeURIComponent(pluginKey)}/api/client-summary?${query.toString()}`, {
    credentials: "include",
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) return null;
  return asClientSummary(await response.json().catch(() => null));
}

/** Accepts the summary as the body, or wrapped in `{ summary }`. Anything malformed is null. */
function asClientSummary(body: unknown): ClientSummary | null {
  const root = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const source = root && root.summary && typeof root.summary === "object" ? (root.summary as Record<string, unknown>) : root;
  if (!source) return null;
  const headline = typeof source.headline === "string" ? source.headline.trim() : "";
  const stats: ClientSummary["stats"] = [];
  if (Array.isArray(source.stats)) {
    for (const item of source.stats) {
      if (!item || typeof item !== "object") continue;
      const stat = item as Record<string, unknown>;
      if (typeof stat.label !== "string" || (typeof stat.value !== "string" && typeof stat.value !== "number")) continue;
      const tone = stat.tone === "ok" || stat.tone === "warn" || stat.tone === "bad" ? stat.tone : undefined;
      stats.push(tone ? { label: stat.label, value: stat.value, tone } : { label: stat.label, value: stat.value });
      if (stats.length === 6) break;
    }
  }
  if (!headline && stats.length === 0) return null;
  return { headline, stats };
}

/** Same frame as `Page`, without its header: the workspace bar is the header. */
function WorkspaceShell({ children }: { children: ReactNode }) {
  return <PageFrame accent="crm">{children}</PageFrame>;
}

/** Overdue next actions are bad, due within two days warn, later ones scheduled. */
function dueTone(due: string | null, now = Date.now()): "bad" | "warn" | "info" {
  const t = due ? Date.parse(due) : Number.NaN;
  if (Number.isNaN(t)) return "info";
  if (t < now - 86_400_000) return "bad";
  if (t < now + 2 * 86_400_000) return "warn";
  return "info";
}

/** The KPI row at the top of a client workspace. */
function WorkspaceKpis({ company, contact, deals, contacts, activities, score }: {
  company: WorkspaceCompany | null;
  contact: WorkspaceContact | null;
  deals: WorkspaceDeal[];
  contacts: Array<{ id: string }>;
  activities: Activity[];
  score: LeadScore | null;
}) {
  const currency = company?.currency ?? deals[0]?.currency ?? "ZAR";
  const open = deals.filter((deal) => deal.stageKind === "open");
  const won = deals.filter((deal) => deal.stageKind === "won");
  const openAmount = open.filter((deal) => deal.currency === currency).reduce((sum, deal) => sum + deal.amountMinor, 0);
  const wonAmount = won.filter((deal) => deal.currency === currency).reduce((sum, deal) => sum + deal.amountMinor, 0);
  const last = activities.map((item) => Date.parse(item.createdAt)).filter((t) => !Number.isNaN(t)).sort((a, b) => b - a)[0];
  const quietDays = last ? Math.floor((Date.now() - last) / 86_400_000) : null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: fluidColumns(150), gap: 10 }}>
      <KpiCard size="sm" label="Open deals" value={formatMoney(openAmount, currency)} hint={open.length ? `${open.length} ${open.length === 1 ? "deal" : "deals"} open` : "Nothing open"} icon={Funnel} />
      <KpiCard size="sm" label="Won" value={formatMoney(wonAmount, currency)} tone={won.length ? "ok" : "neutral"} hint={`${won.length} ${won.length === 1 ? "deal" : "deals"}`} icon={Target} />
      <KpiCard
        size="sm"
        label="Last activity"
        value={last ? whenText(last) ?? "—" : "None yet"}
        tone={quietDays !== null && quietDays > 30 ? "warn" : "neutral"}
        hint={quietDays === null ? "Log a note or an email" : quietDays > 30 ? "Quiet for over a month" : `${activities.length} logged`}
        icon={Clock}
      />
      {company ? <KpiCard size="sm" label="People" value={contacts.length} tone={contacts.length ? "neutral" : "warn"} hint={contacts.length ? "Linked contacts" : "Add a contact"} icon={Users} /> : null}
      {contact ? (
        <KpiCard
          size="sm"
          label="Lead score"
          value={score ? `${Math.round(((score.fit + score.intent + score.urgency) / 9) * 100)}%` : "—"}
          tone={score ? (leadBand(score) === "hot" ? "ok" : "neutral") : "neutral"}
          hint={score ? `${leadBand(score) === "hot" ? "Hot" : leadBand(score) === "warm" ? "Warm" : "Cold"} lead` : "Not scored yet"}
          icon={Target}
        />
      ) : null}
    </div>
  );
}

/** Splits "a, b; c" into a de-duplicated list. */
function splitList(value: string): string[] {
  return [...new Set(value.split(/[,;\n]/).map((part) => part.trim()).filter(Boolean))];
}

function dateInputValue(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

export function CrmSidebar({ context }: PluginSidebarProps) {
  // Hidden when the company switched the CRM module off in Setup; shown while loading.
  const enabled = useModuleEnabled(context.companyId, PLUGIN_ID);
  // The Cockpit's Clients / Marketing / Finance group shows this page instead (pib-plugin-ui NAV_GROUPS).
  const grouped = useGroupedNav("partnersinbiz.crm");
  if (enabled === false || grouped !== false) return null;
  return (
    <SidebarNavLink to="/crm" label="CRM" icon={(
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
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
        isActive
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      ].join(" ")}
      style={{ textDecoration: "none" }}
    >
      <span aria-hidden="true" className="relative shrink-0">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
    </a>
  );
}
