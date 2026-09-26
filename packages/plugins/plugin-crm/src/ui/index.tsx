import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DataTable,
  KeyValueList,
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
  Form,
  Input,
  Modal,
  Page,
  PipelineBoard,
  PipelineCard,
  Select,
  Sheet,
  StatRow,
  Tabs,
  Toolbar,
  errorText,
  formatMinor,
} from "@partnersinbiz/pib-plugin-ui";

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
  | { kind: "company"; id: string }
  | { kind: "contact"; id: string }
  | { kind: "deal"; id: string }
  | { kind: "sequence"; id: string }
  | null;

export function CrmPage({ context }: PluginPageProps) {
  const load = usePluginAction("crm.load");
  const createCompany = usePluginAction("crm.create-company");
  const createContact = usePluginAction("crm.create-contact");
  const linkContact = usePluginAction("crm.link-contact");
  const createDeal = usePluginAction("crm.create-deal");
  const moveDeal = usePluginAction("crm.move-deal");
  const setHumanOwned = usePluginAction("crm.set-human-owned");
  const createSequence = usePluginAction("crm.create-sequence");
  const enroll = usePluginAction("crm.enroll");
  const createProduct = usePluginAction("crm.create-product");
  const updateProduct = usePluginAction("crm.update-product");
  const scoreContact = usePluginAction("crm.score-contact");
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
  const [humanOwned, setHumanOwnedFields] = useState("name");
  const [enrollSequenceId, setEnrollSequenceId] = useState("");
  const [timeline, setTimeline] = useState<Activity[]>([]);
  const [score, setScore] = useState<{ total: number; band: string; parts: Array<{ label: string; points: number }> } | null>(null);

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

  const detailCompany = detail?.kind === "company" ? snapshot?.accounts.find((row) => row.id === detail.id) : null;
  const detailContact = detail?.kind === "contact" ? snapshot?.contacts.find((row) => row.id === detail.id) : null;
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
                onClick: () => setDetail({ kind: "contact", id }),
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
                  render: (_value, row) => (
                    <Button type="button" variant="secondary" style={{ height: 28, fontSize: 12 }} onClick={() => setDetail({ kind: "company", id: String(row.id) })}>
                      Open
                    </Button>
                  ),
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
                  render: (_value, row) => (
                    <Button type="button" variant="secondary" style={{ height: 28, fontSize: 12 }} onClick={() => setDetail({ kind: "contact", id: String(row.id) })}>
                      Open
                    </Button>
                  ),
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
              description="Create a sequence, then enroll contacts from their detail sheet."
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
        title={
          detailCompany?.name
          ?? detailContact?.name
          ?? detailDeal?.title
          ?? detailSequence?.name
          ?? "Record"
        }
        onClose={() => setDetail(null)}
      >
        {detailCompany ? (
          <>
            <KeyValueList pairs={[
              { label: "Domain", value: detailCompany.domain ?? "—" },
              { label: "Lifecycle", value: <StatusBadge label={detailCompany.lifecycle} status="info" /> },
            ]} />
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)" }}>Activity</div>
            <Timeline items={timeline} />
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)" }}>Contacts</div>
            <DataTable
              columns={[{ key: "name", header: "Name" }, { key: "role", header: "Role" }]}
              rows={(snapshot?.links ?? [])
                .filter((link) => link.accountId === detailCompany.id)
                .map((link) => ({ id: link.contactId, name: contactNameOf(link.contactId), role: link.roleLabel }))}
              emptyMessage="No linked contacts."
            />
          </>
        ) : null}

        {detailContact ? (
          <>
            <KeyValueList pairs={[
              { label: "Email", value: detailContact.emails[0] ?? "—" },
              { label: "Lifecycle", value: <StatusBadge label={detailContact.lifecycle} status="info" /> },
              { label: "Roles", value: rolesFor(detailContact.id) || "—" },
              { label: "Human-owned", value: detailContact.humanOwned.join(", ") || "—" },
            ]} />
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted-foreground)" }}>Activity</div>
            <Timeline items={timeline} />
            <div style={{ display: "grid", gap: 8 }}>
              <Button
                type="button"
                variant="secondary"
                onClick={() => void scoreContact({ contactId: detailContact.id })
                  .then((result) => setScore(result as { total: number; band: string; parts: Array<{ label: string; points: number }> }))
                  .catch((error: unknown) => setMessage(errorText(error)))}
              >
                Score this contact
              </Button>
              {score ? (
                <div style={{ display: "grid", gap: 6, padding: 10, borderRadius: 8, border: "1px solid var(--border)", background: "var(--card)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <strong style={{ fontSize: 20 }}>{score.total}<span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>/100</span></strong>
                    <StatusBadge label={score.band} status={score.band === "hot" ? "ok" : score.band === "warm" ? "warning" : "info"} />
                  </div>
                  {score.parts.length > 0 ? (
                    <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 4, fontSize: 12 }}>
                      {score.parts.map((part) => (
                        <li key={part.label} style={{ display: "flex", justifyContent: "space-between", color: "var(--muted-foreground)" }}>
                          <span>{part.label}</span>
                          <span>+{part.points}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </div>
            <Form onSubmit={(event) => {
              event.preventDefault();
              void run(() => setHumanOwned({
                recordType: "contact",
                recordId: detailContact.id,
                humanOwned: humanOwned.split(",").map((part) => part.trim()).filter(Boolean),
              }), "Human-owned fields saved");
            }}>
              <Field label="Mark human-owned fields">
                <Input value={humanOwned} onChange={(event) => setHumanOwnedFields(event.target.value)} placeholder="name, plan" />
              </Field>
              <Button type="submit" variant="secondary">Save ownership</Button>
            </Form>
            <Form onSubmit={(event) => {
              event.preventDefault();
              void run(() => enroll({ sequenceId: enrollSequenceId, contactId: detailContact.id }), "Contact enrolled");
            }}>
              <Field label="Enroll in sequence">
                <Select value={enrollSequenceId} onChange={(event) => setEnrollSequenceId(event.target.value)} required>
                  <option value="">Sequence</option>
                  {(snapshot?.sequences ?? []).map((sequence) => <option key={sequence.id} value={sequence.id}>{sequence.name}</option>)}
                </Select>
              </Field>
              <Button type="submit">Enroll</Button>
            </Form>
            <Button type="button" variant="secondary" onClick={() => {
              setLinkContactId(detailContact.id);
              setCreate("link");
            }}>
              Link to company
            </Button>
          </>
        ) : null}

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
