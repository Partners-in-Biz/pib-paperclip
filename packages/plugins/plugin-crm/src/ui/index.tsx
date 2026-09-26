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
  KeyValueList,
  MetricCard,
  StatusBadge,
  useHostLocation,
  useHostNavigation,
  usePluginAction,
  type PluginPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  BarChart,
  Button,
  ClientWorkspaceBar,
  EmptyState,
  Field,
  Form,
  Input,
  Modal,
  Page,
  PipelineBoard,
  PipelineCard,
  Section,
  Select,
  Sheet,
  StatRow,
  Tabs,
  TextArea,
  Toolbar,
  errorText,
  formatMinor,
  tokens,
} from "@partnersinbiz/pib-plugin-ui";
import { clientScopeFromSearch, withClientParam, type ClientRef } from "@partnersinbiz/pib-plugin-kit/client-ref";

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

interface Sequence {
  id: string;
  name: string;
  completionMode: string;
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
  accounts: Account[];
  contacts: Contact[];
  deals: Deal[];
  links: Link[];
  sequences: Sequence[];
  stages: Stage[];
  products: Product[];
  summary: Summary;
}

type TabId = "overview" | "companies" | "contacts" | "deals" | "sequences" | "products";
type CreateKind = "company" | "contact" | "deal" | "sequence" | "link" | "product" | null;
type Detail =
  | { kind: "deal"; id: string }
  | { kind: "sequence"; id: string }
  | null;

const LIFECYCLE_OPTIONS = ["lead", "prospect", "customer", "churned"] as const;
const NEXT_ACTION_OPTIONS = ["call", "email", "meet"] as const;

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

function CrmList({ context }: PluginPageProps) {
  const navigation = useHostNavigation();
  const load = usePluginAction("crm.load");
  const createCompany = usePluginAction("crm.create-company");
  const createContact = usePluginAction("crm.create-contact");
  const linkContact = usePluginAction("crm.link-contact");
  const createDeal = usePluginAction("crm.create-deal");
  const moveDeal = usePluginAction("crm.move-deal");
  const createSequence = usePluginAction("crm.create-sequence");
  const createProduct = usePluginAction("crm.create-product");
  const activities = usePluginAction("crm.activities");

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<TabId>("overview");
  const [search, setSearch] = useState("");
  const [create, setCreate] = useState<CreateKind>(null);
  const [detail, setDetail] = useState<Detail>(null);

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
  const [sequenceName, setSequenceName] = useState("");
  const [productName, setProductName] = useState("");
  const [productAmount, setProductAmount] = useState("");
  const [productCurrency, setProductCurrency] = useState("ZAR");
  const [timeline, setTimeline] = useState<Activity[]>([]);

  async function refresh() {
    setSnapshot((await load({})) as Snapshot);
  }

  useEffect(() => {
    if (!context.companyId) return;
    refresh().catch((error: unknown) => setMessage(errorText(error)));
  }, [context.companyId]);

  useEffect(() => {
    if (!detail) {
      setTimeline([]);
      return;
    }
    activities({ recordType: detail.kind, recordId: detail.id })
      .then((result) => setTimeline((result as Activity[]) ?? []))
      .catch(() => setTimeline([]));
  }, [detail]);

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
  const openCurrency = summary ? Object.entries(summary.openPipelineByCurrency)[0] : null;

  const accountName = (id: string | null) => snapshot?.accounts.find((row) => row.id === id)?.name ?? "—";
  const contactNameOf = (id: string | null) => snapshot?.contacts.find((row) => row.id === id)?.name ?? "—";
  const stageName = (id: string) => stages.find((stage) => stage.id === id)?.name ?? id;

  function rolesFor(contactId: string): string {
    return (snapshot?.links ?? [])
      .filter((link) => link.contactId === contactId)
      .map((link) => `${link.roleLabel} at ${accountName(link.accountId)}`)
      .join(", ");
  }

  const detailDeal = detail?.kind === "deal" ? snapshot?.deals.find((row) => row.id === detail.id) : null;
  const detailSequence = detail?.kind === "sequence" ? snapshot?.sequences.find((row) => row.id === detail.id) : null;

  return (
    <Page
      title="CRM"
      description="People, the companies they work for, and the deals between them."
      message={message || (snapshot && snapshot.settingsSaved === false
        ? "CRM settings are not saved for this company yet. Open Settings → Plugins → CRM and click Save once, or sequence steps will not open issues and other plugins will not see your clients."
        : undefined)}
      actions={(
        <>
          <Button type="button" variant="secondary" onClick={() => setCreate("company")}>+ Company</Button>
          <Button type="button" variant="secondary" onClick={() => setCreate("contact")}>+ Contact</Button>
          <Button type="button" onClick={() => setCreate("deal")}>+ Deal</Button>
        </>
      )}
    >
      <Tabs
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "companies", label: `Companies (${snapshot?.accounts.length ?? 0})` },
          { id: "contacts", label: `Contacts (${snapshot?.contacts.length ?? 0})` },
          { id: "deals", label: `Deals (${snapshot?.deals.length ?? 0})` },
          { id: "sequences", label: `Sequences (${snapshot?.sequences.length ?? 0})` },
          { id: "products", label: `Products (${snapshot?.products.length ?? 0})` },
        ]}
        active={tab}
        onChange={(id) => {
          setTab(id as TabId);
          setSearch("");
        }}
      />

      {tab === "overview" ? (
        <div style={{ display: "grid", gap: 16 }}>
          <StatRow>
            <MetricCard label="Companies" value={summary?.companyCount ?? 0} />
            <MetricCard label="Contacts" value={summary?.contactCount ?? 0} />
            <MetricCard
              label="Open pipeline"
              value={openCurrency ? formatMinor(openCurrency[1], openCurrency[0]) : "—"}
            />
            <MetricCard label="Deals" value={summary?.dealCount ?? 0} />
          </StatRow>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
            <BarChart
              title="Pipeline by stage"
              items={stages.map((stage) => ({
                label: stage.name,
                value: summary?.byStage[stage.id]?.count ?? 0,
              }))}
            />
            <BarChart
              title="Company lifecycle"
              items={Object.entries(summary?.accountLifecycle ?? {}).map(([label, value]) => ({ label, value }))}
            />
            <BarChart
              title="Contact lifecycle"
              items={Object.entries(summary?.contactLifecycle ?? {}).map(([label, value]) => ({ label, value }))}
            />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
            <AttentionCard
              title="Contacts without a company"
              empty="Every contact is linked."
              items={(summary?.unlinkedContactIds ?? []).map((id) => ({
                id,
                label: contactNameOf(id),
                onClick: () => navigation.navigate(clientPath("contact", id)),
              }))}
            />
            <AttentionCard
              title="Deals without an amount"
              empty="Every deal has an amount."
              items={(summary?.dealsWithoutAmountIds ?? []).map((id) => ({
                id,
                label: snapshot?.deals.find((deal) => deal.id === id)?.title ?? id,
                onClick: () => setDetail({ kind: "deal", id }),
              }))}
            />
          </div>
        </div>
      ) : null}

      {tab === "companies" ? (
        <div style={{ display: "grid", gap: 12 }}>
          <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search companies…">
            <Button type="button" onClick={() => setCreate("company")}>+ Add company</Button>
          </Toolbar>
          {accounts.length === 0 ? (
            <EmptyState
              title="No companies yet"
              description="Add the accounts your contacts work for."
              action={<Button type="button" onClick={() => setCreate("company")}>+ Add company</Button>}
            />
          ) : (
            <DataTable
              columns={[
                { key: "name", header: "Company" },
                { key: "domain", header: "Domain" },
                { key: "lifecycle", header: "Lifecycle", render: (value) => <StatusBadge label={String(value)} status="info" /> },
                {
                  key: "id",
                  header: "",
                  width: "90px",
                  render: (_value, row) => <OpenLink to={clientPath("company", String(row.id))} label={`Open ${String(row.name)}`} />,
                },
              ]}
              rows={accounts.map((row) => ({ ...row, domain: row.domain ?? "—" }))}
              emptyMessage="No companies match."
            />
          )}
        </div>
      ) : null}

      {tab === "contacts" ? (
        <div style={{ display: "grid", gap: 12 }}>
          <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search contacts…">
            <Button type="button" variant="secondary" onClick={() => setCreate("link")}>Link to company</Button>
            <Button type="button" onClick={() => setCreate("contact")}>+ Add contact</Button>
          </Toolbar>
          {contacts.length === 0 ? (
            <EmptyState
              title="No contacts yet"
              description="Add people, then link them to companies."
              action={<Button type="button" onClick={() => setCreate("contact")}>+ Add contact</Button>}
            />
          ) : (
            <DataTable
              columns={[
                { key: "name", header: "Contact" },
                { key: "email", header: "Email" },
                { key: "roles", header: "Company roles" },
                { key: "lifecycle", header: "Lifecycle", render: (value) => <StatusBadge label={String(value)} status="info" /> },
                {
                  key: "id",
                  header: "",
                  width: "90px",
                  render: (_value, row) => <OpenLink to={clientPath("contact", String(row.id))} label={`Open ${String(row.name)}`} />,
                },
              ]}
              rows={contacts.map((row) => ({
                ...row,
                email: row.emails[0] ?? "—",
                roles: rolesFor(row.id) || "—",
              }))}
              emptyMessage="No contacts match."
            />
          )}
        </div>
      ) : null}

      {tab === "deals" ? (
        <div style={{ display: "grid", gap: 12 }}>
          <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search deals…">
            <Button type="button" onClick={() => setCreate("deal")}>+ Add deal</Button>
          </Toolbar>
          {deals.length === 0 ? (
            <EmptyState
              title="No deals yet"
              description="Track opportunities across your sales stages."
              action={<Button type="button" onClick={() => setCreate("deal")}>+ Add deal</Button>}
            />
          ) : (
            <PipelineBoard
              columns={stages.map((stage) => {
                const stageDeals = deals.filter((deal) => deal.stageId === stage.id);
                const amount = stageDeals.reduce((sum, deal) => sum + deal.amountMinor, 0);
                const currency = stageDeals[0]?.currency ?? "ZAR";
                return {
                  id: stage.id,
                  title: stage.name,
                  meta: `${stageDeals.length} · ${formatMinor(amount, currency)}`,
                  children: stageDeals.length === 0
                    ? <p style={{ margin: 0, fontSize: 12, color: "var(--muted-foreground)" }}>Empty</p>
                    : stageDeals.map((deal) => (
                      <PipelineCard
                        key={deal.id}
                        title={deal.title}
                        subtitle={`${formatMinor(deal.amountMinor, deal.currency)} · ${contactNameOf(deal.contactId)}`}
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
                            style={{ height: 28, fontSize: 12, marginTop: 6 }}
                          >
                            {stages.map((option) => (
                              <option key={option.id} value={option.id}>{option.name}</option>
                            ))}
                          </Select>
                        )}
                      />
                    )),
                };
              })}
            />
          )}
        </div>
      ) : null}

      {tab === "sequences" ? (
        <div style={{ display: "grid", gap: 12 }}>
          <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search sequences…">
            <Button type="button" onClick={() => setCreate("sequence")}>+ Add sequence</Button>
          </Toolbar>
          {sequences.length === 0 ? (
            <EmptyState
              title="No sequences yet"
              description="Create a sequence, then enroll contacts from their client workspace."
              action={<Button type="button" onClick={() => setCreate("sequence")}>+ Add sequence</Button>}
            />
          ) : (
            <DataTable
              columns={[
                { key: "name", header: "Sequence" },
                { key: "completionMode", header: "Completion", render: (value) => <StatusBadge label={String(value)} status="pending" /> },
                {
                  key: "id",
                  header: "",
                  width: "90px",
                  render: (_value, row) => (
                    <Button type="button" variant="secondary" style={{ height: 28, fontSize: 12 }} onClick={() => setDetail({ kind: "sequence", id: String(row.id) })}>
                      Open
                    </Button>
                  ),
                },
              ]}
              rows={sequences as unknown as Record<string, unknown>[]}
              emptyMessage="No sequences match."
            />
          )}
        </div>
      ) : null}

      {tab === "products" ? (
        <div style={{ display: "grid", gap: 12 }}>
          <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search products…">
            <Button type="button" onClick={() => setCreate("product")}>+ Add product</Button>
          </Toolbar>
          {products.length === 0 ? (
            <EmptyState
              title="No products yet"
              description="Add the products and services you sell, then reference them in deals and invoices."
              action={<Button type="button" onClick={() => setCreate("product")}>+ Add product</Button>}
            />
          ) : (
            <DataTable
              columns={[
                { key: "name", header: "Product" },
                { key: "description", header: "Description" },
                { key: "price", header: "Price", render: (_value, row) => formatMinor((row as unknown as Product).unitAmountMinor, (row as unknown as Product).currency) },
                { key: "isActive", header: "Status", render: (value) => <StatusBadge label={value ? "Active" : "Inactive"} status={value ? "ok" : "info"} /> },
              ]}
              rows={products.map((row) => ({ ...row, price: "" }))}
              emptyMessage="No products match."
            />
          )}
        </div>
      ) : null}

      <Modal
        open={create === "company"}
        title="Add company"
        description="A CRM company is the account. It is not this Paperclip workspace."
        onClose={() => setCreate(null)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
            <Button
              type="button"
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
        title="Add contact"
        description="Add a person, then link them to a company."
        onClose={() => setCreate(null)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
            <Button
              type="button"
              onClick={() => void run(async () => {
                await createContact({
                  name: contactName,
                  emails: contactEmail ? [contactEmail] : [],
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
          <Input value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} placeholder="ada@northwind.test" />
        </Field>
      </Modal>

      <Modal
        open={create === "link"}
        title="Link contact to company"
        onClose={() => setCreate(null)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
            <Button
              type="button"
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
            {(snapshot?.contacts ?? []).map((contact) => <option key={contact.id} value={contact.id}>{contact.name}</option>)}
          </Select>
        </Field>
        <Field label="Company">
          <Select value={linkAccountId} onChange={(event) => setLinkAccountId(event.target.value)} required>
            <option value="">Select company</option>
            {(snapshot?.accounts ?? []).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </Select>
        </Field>
        <Field label="Role">
          <Input value={linkRole} onChange={(event) => setLinkRole(event.target.value)} placeholder="buyer" />
        </Field>
      </Modal>

      <Modal
        open={create === "deal"}
        title="Add deal"
        description="Amount is in minor units (cents)."
        onClose={() => setCreate(null)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
            <Button
              type="button"
              onClick={() => void run(async () => {
                await createDeal({
                  title: dealTitle,
                  amountMinor: Number(dealAmount || 0),
                  currency: dealCurrency,
                  contactId: dealContactId || undefined,
                });
                setDealTitle("");
                setDealAmount("");
                setDealContactId("");
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
        <Field label="Amount (minor units)">
          <Input value={dealAmount} onChange={(event) => setDealAmount(event.target.value)} placeholder="15000000" />
        </Field>
        <Field label="Currency">
          <Input value={dealCurrency} onChange={(event) => setDealCurrency(event.target.value)} placeholder="ZAR" />
        </Field>
        <Field label="Contact">
          <Select value={dealContactId} onChange={(event) => setDealContactId(event.target.value)}>
            <option value="">Optional</option>
            {(snapshot?.contacts ?? []).map((contact) => <option key={contact.id} value={contact.id}>{contact.name}</option>)}
          </Select>
        </Field>
      </Modal>

      <Modal
        open={create === "sequence"}
        title="Add sequence"
        onClose={() => setCreate(null)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
            <Button
              type="button"
              onClick={() => void run(async () => {
                await createSequence({ name: sequenceName, completionMode: "manual" });
                setSequenceName("");
              }, "Sequence saved")}
            >
              Save sequence
            </Button>
          </>
        )}
      >
        <Field label="Name">
          <Input value={sequenceName} onChange={(event) => setSequenceName(event.target.value)} placeholder="Intro" required />
        </Field>
      </Modal>

      <Modal
        open={create === "product"}
        title="Add product"
        description="Amount is in minor units (cents)."
        onClose={() => setCreate(null)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
            <Button
              type="button"
              onClick={() => void run(async () => {
                await createProduct({
                  name: productName,
                  unitAmountMinor: Number(productAmount || 0),
                  currency: productCurrency,
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
          <Input value={productName} onChange={(event) => setProductName(event.target.value)} placeholder="Website rebuild" required />
        </Field>
        <Field label="Unit amount (minor units)">
          <Input value={productAmount} onChange={(event) => setProductAmount(event.target.value)} placeholder="15000000" />
        </Field>
        <Field label="Currency">
          <Input value={productCurrency} onChange={(event) => setProductCurrency(event.target.value)} placeholder="ZAR" />
        </Field>
      </Modal>

      <Sheet
        open={detail != null}
        title={detailDeal?.title ?? detailSequence?.name ?? "Record"}
        onClose={() => setDetail(null)}
      >
        {detailDeal ? (
          <>
            <KeyValueList pairs={[
              { label: "Amount", value: formatMinor(detailDeal.amountMinor, detailDeal.currency) },
              { label: "Stage", value: stageName(detailDeal.stageId) },
              { label: "Contact", value: contactNameOf(detailDeal.contactId) },
              { label: "Company", value: accountName(detailDeal.accountId) },
            ]} />
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)" }}>Activity</div>
            <Timeline items={timeline} />
            <Field label="Move stage">
              <Select
                value={detailDeal.stageId}
                onChange={(event) => void run(() => moveDeal({ dealId: detailDeal.id, stageId: event.target.value }), "Deal moved")}
              >
                {stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
              </Select>
            </Field>
          </>
        ) : null}

        {detailSequence ? (
          <KeyValueList pairs={[
            { label: "Completion", value: <StatusBadge label={detailSequence.completionMode} status="pending" /> },
          ]} />
        ) : null}
      </Sheet>
    </Page>
  );
}

function Timeline({ items }: { items: Activity[] }) {
  if (items.length === 0) {
    return <p style={{ margin: 0, fontSize: 13, color: "var(--muted-foreground)" }}>No activity yet.</p>;
  }
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 8 }}>
      {items.map((item) => (
        <li key={item.id} style={{ display: "grid", gap: 2, padding: "8px 10px", borderRadius: 8, background: "var(--secondary)", fontSize: 13 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <span style={{ fontWeight: 600, textTransform: "capitalize" }}>{item.kind}</span>
            <span style={{ color: "var(--muted-foreground)", fontSize: 11 }}>{new Date(item.createdAt).toLocaleString()}</span>
          </div>
          <div style={{ color: "var(--foreground)", lineHeight: 1.4, whiteSpace: "pre-wrap" }}>{item.body}</div>
        </li>
      ))}
    </ul>
  );
}

function AttentionCard({ title, empty, items }: {
  title: string;
  empty: string;
  items: Array<{ id: string; label: string; onClick: () => void }>;
}) {
  return (
    <div style={{
      display: "grid",
      gap: 8,
      padding: 14,
      borderRadius: 12,
      border: "1px solid var(--border)",
      background: "var(--card)",
    }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)", textTransform: "uppercase", letterSpacing: "0.02em" }}>
        {title}
      </div>
      {items.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--muted-foreground)" }}>{empty}</p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 6 }}>
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={item.onClick}
                style={{
                  appearance: "none",
                  border: "1px solid var(--border)",
                  background: "var(--secondary)",
                  color: "var(--foreground)",
                  borderRadius: 8,
                  padding: "8px 10px",
                  width: "100%",
                  textAlign: "left",
                  fontSize: 13,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
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
  sequences?: Sequence[];
  options?: { companies: Array<{ id: string; name: string }>; contacts: Array<{ id: string; name: string }> };
}

/** What `GET /api/plugins/<key>/api/client-summary` returns for one client. */
interface ClientSummary {
  headline: string;
  stats: Array<{ label: string; value: string | number; tone?: "ok" | "warn" | "bad" }>;
}

type SummaryState = { status: "loading" } | { status: "ok"; summary: ClientSummary } | { status: "error" };
type ScoreResult = { total: number; band: string; parts: Array<{ label: string; points: number }> };
type WorkspaceModal = "add-contact" | "link-company" | "deal" | null;
type Patch = Record<string, unknown>;

const WORK_SOURCES = [
  { tab: "social", label: "Social", pluginKey: "partnersinbiz.social", path: "/social" },
  { tab: "seo", label: "SEO", pluginKey: "partnersinbiz.seo", path: "/seo" },
  { tab: "campaigns", label: "Campaigns", pluginKey: "partnersinbiz.campaigns", path: "/campaigns" },
  { tab: "billing", label: "Billing", pluginKey: "partnersinbiz.billing", path: "/billing" },
] as const;

type WorkTab = (typeof WORK_SOURCES)[number]["tab"];

function ClientWorkspace({ companyId, client }: { companyId: string | null; client: ClientRef }) {
  const navigation = useHostNavigation();
  const load = usePluginAction("crm.client-workspace");
  const updateCompany = usePluginAction("crm.update-company");
  const updateContact = usePluginAction("crm.update-contact");
  const createCompany = usePluginAction("crm.create-company");
  const createContact = usePluginAction("crm.create-contact");
  const linkContact = usePluginAction("crm.link-contact");
  const createDeal = usePluginAction("crm.create-deal");
  const moveDeal = usePluginAction("crm.move-deal");
  const logActivity = usePluginAction("crm.log-activity");
  const setHumanOwned = usePluginAction("crm.set-human-owned");
  const enroll = usePluginAction("crm.enroll");
  const scoreContact = usePluginAction("crm.score-contact");
  const summaries = useClientSummaries(companyId, client);

  const [data, setData] = useState<WorkspaceData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [message, setMessage] = useState("");
  const [modal, setModal] = useState<WorkspaceModal>(null);

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
  const [humanOwned, setHumanOwnedFields] = useState("");
  const [enrollSequenceId, setEnrollSequenceId] = useState("");
  const [score, setScore] = useState<ScoreResult | null>(null);

  function apply(next: WorkspaceData) {
    setData(next);
    const record = next.company ?? next.contact;
    if (record) setHumanOwnedFields(record.humanOwned.join(", "));
  }

  async function refresh() {
    apply((await load({ kind: client.kind, id: client.id })) as WorkspaceData);
  }

  useEffect(() => {
    if (!companyId) return;
    let live = true;
    setLoadError("");
    load({ kind: client.kind, id: client.id })
      .then((result) => {
        if (live) apply(result as WorkspaceData);
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

  const back = navigation.linkProps("/crm");
  const backLink = (
    <a {...back} style={{ fontSize: 12.5, color: tokens.muted, textDecoration: "none", width: "fit-content" }}>← All CRM</a>
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
        {backLink}
        <EmptyState
          title={client.kind === "company" ? "Company not found" : "Contact not found"}
          description="This client may have been deleted or merged into another record, or it has not been shared with you."
          action={<a {...back} style={{ ...linkButtonStyle, height: 36, padding: "0 14px", fontSize: 13 }}>Back to CRM</a>}
        />
      </WorkspaceShell>
    );
  }

  const company = data.company ?? null;
  const contact = data.contact ?? null;
  const name = company?.name ?? contact?.name ?? "Client";
  const detail = company
    ? [company.domain, company.lifecycle].filter(Boolean).join(" · ")
    : [contact?.emails[0], contact?.lifecycle].filter(Boolean).join(" · ");
  const contacts = data.contacts ?? [];
  const companies = data.companies ?? [];
  const deals = data.deals ?? [];
  const stages = data.stages ?? [];
  const sequences = data.sequences ?? [];
  const options = data.options ?? { companies: [], contacts: [] };
  const linkedIds = new Set((company ? contacts : companies).map((row) => row.id));
  const pickChoices = (company ? options.contacts : options.companies).filter((row) => !linkedIds.has(row.id));
  const pickReady = pickMode === "new" ? pickName.trim() !== "" : pickId !== "";

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
    if (ok && refused.length > 0) setMessage(`Saved. These human-owned fields were kept: ${refused.join(", ")}`);
    return ok;
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

  return (
    <WorkspaceShell>
      <ClientWorkspaceBar
        client={{ kind: client.kind, id: client.id, name, detail }}
        active="overview"
        linkProps={navigation.linkProps}
        actions={(
          <>
            <Button type="button" variant="secondary" onClick={() => openModal(company ? "add-contact" : "link-company")}>
              {company ? "+ Contact" : "Link to company"}
            </Button>
            <Button type="button" onClick={() => openModal("deal")}>+ Deal</Button>
          </>
        )}
      />
      {message ? <StatusLine>{message}</StatusLine> : null}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        {WORK_SOURCES.map((source) => (
          <WorkCard
            key={source.tab}
            label={source.label}
            state={summaries[source.tab]}
            link={navigation.linkProps(withClientParam(source.path, client))}
          />
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 380px), 1fr))", gap: 16, alignItems: "start" }}>
        <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
          {company ? <CompanyDetails company={company} onSave={saveDetails} /> : null}
          {contact ? <ContactDetails contact={contact} onSave={saveDetails} /> : null}

          {company ? (
            <Section
              title={`Contacts (${contacts.length})`}
              actions={<Button type="button" variant="secondary" style={smallButton} onClick={() => openModal("add-contact")}>+ Add contact</Button>}
            >
              {contacts.length === 0 ? (
                <Muted>No one is linked to this company yet.</Muted>
              ) : (
                <DataTable
                  columns={[
                    { key: "name", header: "Name" },
                    { key: "email", header: "Email" },
                    { key: "roleLabel", header: "Role" },
                    {
                      key: "id",
                      header: "",
                      width: "80px",
                      render: (_value, row) => <OpenLink to={clientPath("contact", String(row.id))} label={`Open ${String(row.name)}`} />,
                    },
                  ]}
                  rows={contacts.map((row) => ({ ...row, email: row.emails[0] ?? "—" }))}
                  emptyMessage="No contacts."
                />
              )}
            </Section>
          ) : null}

          {contact ? (
            <Section
              title={`Companies (${companies.length})`}
              actions={<Button type="button" variant="secondary" style={smallButton} onClick={() => openModal("link-company")}>Link to company</Button>}
            >
              {companies.length === 0 ? (
                <Muted>Not linked to a company. A sole trader can stay that way.</Muted>
              ) : (
                <DataTable
                  columns={[
                    { key: "name", header: "Company" },
                    { key: "roleLabel", header: "Role" },
                    { key: "lifecycle", header: "Lifecycle", render: (value) => <StatusBadge label={String(value)} status={lifecycleStatus(String(value))} /> },
                    {
                      key: "id",
                      header: "",
                      width: "80px",
                      render: (_value, row) => <OpenLink to={clientPath("company", String(row.id))} label={`Open ${String(row.name)}`} />,
                    },
                  ]}
                  rows={companies as unknown as Record<string, unknown>[]}
                  emptyMessage="No companies."
                />
              )}
            </Section>
          ) : null}

          <Section
            title={`Deals (${deals.length})`}
            actions={<Button type="button" variant="secondary" style={smallButton} onClick={() => openModal("deal")}>+ Deal</Button>}
          >
            {deals.length === 0 ? (
              <Muted>No deals for this client yet.</Muted>
            ) : (
              <DataTable
                columns={[
                  { key: "title", header: "Deal" },
                  { key: "amount", header: "Amount" },
                  ...(company ? [{ key: "contactName", header: "Contact" }] : []),
                  {
                    key: "stageId",
                    header: "Stage",
                    width: "170px",
                    render: (_value, row) => {
                      const deal = row as unknown as WorkspaceDeal;
                      return (
                        <Select
                          aria-label={`Move ${deal.title}`}
                          value={deal.stageId}
                          onChange={(event) => void run(() => moveDeal({ dealId: deal.id, stageId: event.target.value }), "Deal moved")}
                          style={smallButton}
                        >
                          {stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
                        </Select>
                      );
                    },
                  },
                ]}
                rows={deals.map((deal) => ({
                  ...deal,
                  amount: formatMinor(deal.amountMinor, deal.currency),
                  contactName: deal.contactName ?? "—",
                }))}
                emptyMessage="No deals."
              />
            )}
          </Section>
        </div>

        <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
          <Section title="Activity">
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
            <Timeline items={data.activities ?? []} />
          </Section>

          {contact ? (
            <Section title="Contact tools">
              <div style={{ display: "grid", gap: 8 }}>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void scoreContact({ contactId: contact.id })
                    .then((result) => setScore(result as ScoreResult))
                    .catch((error: unknown) => setMessage(errorText(error)))}
                >
                  Score this contact
                </Button>
                {score ? <ScoreCard score={score} /> : null}
              </div>
              {sequences.length === 0 ? (
                <Muted>No sequences yet. Create one on the CRM Sequences tab to enroll this contact.</Muted>
              ) : (
                <Form onSubmit={(event) => {
                  event.preventDefault();
                  void run(() => enroll({ sequenceId: enrollSequenceId, contactId: contact.id }), "Contact enrolled");
                }}>
                  <Field label="Enroll in sequence">
                    <Select value={enrollSequenceId} onChange={(event) => setEnrollSequenceId(event.target.value)} required>
                      <option value="">Sequence</option>
                      {sequences.map((sequence) => <option key={sequence.id} value={sequence.id}>{sequence.name}</option>)}
                    </Select>
                  </Field>
                  <div>
                    <Button type="submit" disabled={!enrollSequenceId}>Enroll</Button>
                  </div>
                </Form>
              )}
            </Section>
          ) : null}

          <Section title="Human-owned fields">
            <Muted>Agents cannot overwrite these fields once they have a value.</Muted>
            <Form onSubmit={(event) => {
              event.preventDefault();
              void run(() => setHumanOwned({
                recordType: client.kind,
                recordId: client.id,
                humanOwned: splitList(humanOwned),
              }), "Human-owned fields saved");
            }}>
              <Field label="Fields (comma separated)">
                <Input value={humanOwned} onChange={(event) => setHumanOwnedFields(event.target.value)} placeholder="name, lifecycle" />
              </Field>
              <div>
                <Button type="submit" variant="secondary">Save ownership</Button>
              </div>
            </Form>
          </Section>
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
                <Input value={pickEmail} onChange={(event) => setPickEmail(event.target.value)} placeholder="ada@northwind.test" />
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
        description="Amount is in minor units (cents)."
        onClose={() => setModal(null)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setModal(null)}>Cancel</Button>
            <Button
              type="button"
              disabled={!dealTitle.trim()}
              onClick={() => void run(() => createDeal({
                title: dealTitle,
                amountMinor: Number(dealAmount || 0),
                currency: dealCurrency,
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
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
          <Field label="Amount (minor units)">
            <Input value={dealAmount} inputMode="numeric" onChange={(event) => setDealAmount(event.target.value)} placeholder="15000000" />
          </Field>
          <Field label="Currency">
            <Input value={dealCurrency} maxLength={3} onChange={(event) => setDealCurrency(event.target.value)} placeholder="ZAR" />
          </Field>
        </div>
        {company ? (
          <Field label="Contact">
            <Select value={dealPartyId} onChange={(event) => setDealPartyId(event.target.value)}>
              <option value="">Optional</option>
              {contacts.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
            </Select>
          </Field>
        ) : (
          <Field label="Company">
            <Select value={dealPartyId} onChange={(event) => setDealPartyId(event.target.value)}>
              <option value="">Optional</option>
              {companies.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
            </Select>
          </Field>
        )}
      </Modal>
    </WorkspaceShell>
  );
}

function CompanyDetails({ company, onSave }: { company: WorkspaceCompany; onSave: (patch: Patch) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [lifecycle, setLifecycle] = useState("lead");
  const [currency, setCurrency] = useState("ZAR");
  const [tags, setTags] = useState("");

  function startEdit() {
    setName(company.name);
    setDomain(company.domain ?? "");
    setLifecycle(company.lifecycle);
    setCurrency(company.currency);
    setTags(company.tags.join(", "));
    setEditing(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    const ok = await onSave({ name, domain, lifecycle, currency, tags: splitList(tags) });
    setSaving(false);
    if (ok) setEditing(false);
  }

  return (
    <Section
      title="Details"
      actions={editing ? undefined : <Button type="button" variant="secondary" style={smallButton} onClick={startEdit}>Edit</Button>}
    >
      {editing ? (
        <Form onSubmit={(event) => void submit(event)}>
          <Field label="Company name">
            <Input value={name} onChange={(event) => setName(event.target.value)} required />
          </Field>
          <Field label="Domain">
            <Input value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="northwind.test" />
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
            <Field label="Lifecycle">
              <LifecycleSelect value={lifecycle} onChange={setLifecycle} />
            </Field>
            <Field label="Currency">
              <Input value={currency} maxLength={3} onChange={(event) => setCurrency(event.target.value)} />
            </Field>
          </div>
          <Field label="Tags (comma separated)">
            <Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="retainer, priority" />
          </Field>
          <EditButtons saving={saving} onCancel={() => setEditing(false)} />
        </Form>
      ) : (
        <KeyValueList pairs={[
          { label: "Name", value: company.name },
          { label: "Domain", value: company.domain ?? "—" },
          { label: "Lifecycle", value: <StatusBadge label={company.lifecycle} status={lifecycleStatus(company.lifecycle)} /> },
          { label: "Currency", value: company.currency },
          { label: "Tags", value: company.tags.join(", ") || "—" },
          { label: "Human-owned", value: company.humanOwned.join(", ") || "—" },
        ]} />
      )}
    </Section>
  );
}

function ContactDetails({ contact, onSave }: { contact: WorkspaceContact; onSave: (patch: Patch) => Promise<boolean> }) {
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

  const nextAction = contact.nextActionKind
    ? [contact.nextActionKind, formatDate(contact.nextActionDueAt)].filter(Boolean).join(" · ")
    : "—";

  return (
    <Section
      title="Details"
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
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Next action">
              <Select value={nextKind} onChange={(event) => setNextKind(event.target.value)}>
                <option value="">None</option>
                {NEXT_ACTION_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
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
        <KeyValueList pairs={[
          { label: "Name", value: contact.name },
          { label: "Emails", value: contact.emails.join(", ") || "—" },
          { label: "Phones", value: contact.phones.join(", ") || "—" },
          { label: "Lifecycle", value: <StatusBadge label={contact.lifecycle} status={lifecycleStatus(contact.lifecycle)} /> },
          { label: "Next action", value: nextAction },
          { label: "Tags", value: contact.tags.join(", ") || "—" },
          { label: "Human-owned", value: contact.humanOwned.join(", ") || "—" },
        ]} />
      )}
    </Section>
  );
}

function LifecycleSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <Select value={value} onChange={(event) => onChange(event.target.value)}>
      {LIFECYCLE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
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

function ScoreCard({ score }: { score: ScoreResult }) {
  return (
    <div style={{ display: "grid", gap: 6, padding: 10, borderRadius: 8, border: `1px solid ${tokens.border}`, background: tokens.bg }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <strong style={{ fontSize: 20 }}>{score.total}<span style={{ fontSize: 12, color: tokens.muted }}>/100</span></strong>
        <StatusBadge label={score.band} status={score.band === "hot" ? "ok" : score.band === "warm" ? "warning" : "info"} />
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
    </div>
  );
}

function WorkCard({ label, state, link }: {
  label: string;
  state: SummaryState;
  link: { href?: string; onClick: (event: ReactMouseEvent<HTMLAnchorElement>) => void };
}) {
  return (
    <a
      {...link}
      aria-label={`Open ${label} for this client`}
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 650, letterSpacing: "0.06em", textTransform: "uppercase", color: tokens.muted }}>{label}</span>
        <span style={{ fontSize: 12, fontWeight: 600 }}>Open →</span>
      </div>
      {state.status === "loading" ? <span style={{ fontSize: 12.5, color: tokens.muted }}>Loading…</span> : null}
      {state.status === "ok" ? (
        <>
          {state.summary.headline ? (
            <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35 }}>{state.summary.headline}</div>
          ) : null}
          {state.summary.stats.length > 0 ? (
            <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(78px, 1fr))", gap: 8 }}>
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
                    color: stat.tone === "bad" ? tokens.destructive : tokens.fg,
                  }}>
                    {stat.tone ? <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 999, flexShrink: 0, background: TONE_DOT[stat.tone] }} /> : null}
                    {stat.value}
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

const TONE_DOT: Record<"ok" | "warn" | "bad", string> = {
  ok: "#22c55e",
  warn: "#f59e0b",
  bad: tokens.destructive,
};

function initialSummaries(): Record<WorkTab, SummaryState> {
  return {
    social: { status: "loading" },
    seo: { status: "loading" },
    campaigns: { status: "loading" },
    billing: { status: "loading" },
  };
}

/** Fetches each plugin's client summary in parallel. A missing or failing plugin shows as `error`. */
function useClientSummaries(companyId: string | null, client: ClientRef): Record<WorkTab, SummaryState> {
  const [states, setStates] = useState<Record<WorkTab, SummaryState>>(initialSummaries);
  useEffect(() => {
    setStates(initialSummaries());
    if (!companyId) {
      setStates({ social: { status: "error" }, seo: { status: "error" }, campaigns: { status: "error" }, billing: { status: "error" } });
      return;
    }
    const controller = new AbortController();
    for (const source of WORK_SOURCES) {
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
  }, [companyId, client.kind, client.id]);
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

const shellFont = `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

/** Same frame as `Page`, without its header: the workspace bar is the header. */
function WorkspaceShell({ children }: { children: ReactNode }) {
  return (
    <main style={{ fontFamily: shellFont, color: tokens.fg, padding: 28, maxWidth: 1160, display: "grid", gap: 22 }}>
      {children}
    </main>
  );
}

function StatusLine({ children }: { children: ReactNode }) {
  return (
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
      {children}
    </p>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <p style={{ margin: 0, fontSize: 13, color: tokens.muted, lineHeight: 1.45 }}>{children}</p>;
}

function lifecycleStatus(lifecycle: string): "ok" | "warning" | "error" | "info" | "pending" {
  if (lifecycle === "customer") return "ok";
  if (lifecycle === "prospect") return "pending";
  if (lifecycle === "churned") return "error";
  return "info";
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

function formatDate(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
}

export function CrmSidebar(_props: PluginSidebarProps) {
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
