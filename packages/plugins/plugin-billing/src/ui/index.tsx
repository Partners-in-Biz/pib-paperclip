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
  BarChart,
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
  Toolbar,
  errorText,
  formatMinor,
  tokens,
} from "@partnersinbiz/pib-plugin-ui";
import { clientScopeFromSearch, formatClientParam, parseClientParam, type ClientKind } from "@partnersinbiz/pib-plugin-kit/client-ref";

interface Invoice { id: string; number: string; status: string; currency: string; totalMinor: number; customerKind?: string; customerRef: string; customerName?: string | null; taxRate?: number; dueAt?: string | null }
interface Quote { id: string; number: string; status: string; currency: string; totalMinor: number; customerKind?: string; customerRef: string; customerName?: string | null }
interface Client { kind: ClientKind; id: string; name: string; email?: string | null }
interface WorkspaceClient { kind: ClientKind; id: string; name: string | null; detail: string | null; found: boolean }
interface Snapshot {
  invoices: Invoice[];
  quotes?: Quote[];
  expenses?: Expense[];
  clients?: Client[];
  client?: WorkspaceClient | null;
  settingsSaved?: boolean;
  defaults?: { currency: string; taxRate: number; senderName: string };
}

/** Customer typed by hand when the CRM client list is empty. */
interface ManualCustomer { kind: ClientKind; name: string; ref: string }
const EMPTY_MANUAL: ManualCustomer = { kind: "company", name: "", ref: "" };

const FONT = `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

/** "1 234,50" / "1234.5" → minor units. */
function toMinor(value: string): number {
  const cleaned = value.replace(/\s/g, "").replace(",", ".");
  const amount = Number(cleaned);
  if (!Number.isFinite(amount)) throw new Error("Enter a valid amount");
  return Math.round(amount * 100);
}

function openPrintable(html: string) {
  const win = window.open("", "_blank");
  if (!win) throw new Error("Allow pop-ups to open the printable document");
  win.document.open();
  win.document.write(html);
  win.document.close();
}
interface Expense { id: string; description: string; amountMinor: number; currency: string; category: string }
type TabId = "overview" | "invoices" | "quotes" | "expenses";
type CreateKind = "invoice" | "line" | "quote" | "expense" | null;

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

/** Companies and contacts from the CRM, grouped, as `kind:id` option values. */
function ClientSelect({ clients, value, onChange }: { clients: Client[]; value: string; onChange: (value: string) => void }) {
  const companies = clients.filter((client) => client.kind === "company");
  const contacts = clients.filter((client) => client.kind === "contact");
  return (
    <Field label="Client">
      <Select value={value} onChange={(event) => onChange(event.target.value)} required>
        <option value="">Choose a CRM company or contact…</option>
        {companies.length > 0 ? (
          <optgroup label="Companies">
            {companies.map((client) => <option key={`company:${client.id}`} value={`company:${client.id}`}>{client.name}</option>)}
          </optgroup>
        ) : null}
        {contacts.length > 0 ? (
          <optgroup label="Contacts">
            {contacts.map((client) => (
              <option key={`contact:${client.id}`} value={`contact:${client.id}`}>{client.email ? `${client.name} (${client.email})` : client.name}</option>
            ))}
          </optgroup>
        ) : null}
      </Select>
    </Field>
  );
}

function ManualCustomerFields({ value, onChange }: { value: ManualCustomer; onChange: (value: ManualCustomer) => void }) {
  return (
    <>
      <Field label="Customer type">
        <Select value={value.kind} onChange={(event) => onChange({ ...value, kind: event.target.value as ClientKind })}>
          <option value="company">Company</option>
          <option value="contact">Contact (person or sole trader)</option>
        </Select>
      </Field>
      <Field label="Customer name"><Input value={value.name} onChange={(event) => onChange({ ...value, name: event.target.value })} required /></Field>
      <Field label="Customer reference (CRM id)"><Input value={value.ref} onChange={(event) => onChange({ ...value, ref: event.target.value })} required /></Field>
    </>
  );
}

export function BillingPage({ context }: PluginPageProps) {
  const location = useHostLocation();
  const navigation = useHostNavigation();
  const scope = useMemo(() => clientScopeFromSearch(location.search), [location.search]);
  const scopeKey = scope ? formatClientParam(scope) : "own";
  const load = usePluginAction("billing.load");
  const createInvoice = usePluginAction("billing.create-invoice");
  const addLine = usePluginAction("billing.add-line");
  const requestSend = usePluginAction("billing.request-send");
  const requestPay = usePluginAction("billing.request-pay");
  const createQuote = usePluginAction("billing.create-quote");
  const createExpense = usePluginAction("billing.create-expense");
  const invoiceHtml = usePluginAction("billing.invoice-html");
  const quoteHtml = usePluginAction("billing.quote-html");
  const [loaded, setLoaded] = useState(false);
  const [clients, setClients] = useState<Client[]>([]);
  const [client, setClient] = useState<WorkspaceClient | null>(null);
  const [settingsSaved, setSettingsSaved] = useState(true);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<TabId>("overview");
  const [search, setSearch] = useState("");
  const [create, setCreate] = useState<CreateKind>(null);
  const [invoiceCustomer, setInvoiceCustomer] = useState("");
  const [invoiceManual, setInvoiceManual] = useState<ManualCustomer>(EMPTY_MANUAL);
  const [currency, setCurrency] = useState("ZAR");
  const [invoiceId, setInvoiceId] = useState("");
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unitAmount, setUnitAmount] = useState("");
  const [quoteCustomer, setQuoteCustomer] = useState("");
  const [quoteManual, setQuoteManual] = useState<ManualCustomer>(EMPTY_MANUAL);
  const [expenseDescription, setExpenseDescription] = useState("");
  const [expenseAmount, setExpenseAmount] = useState("");
  const [expenseCategory, setExpenseCategory] = useState("other");

  async function refresh() {
    const snapshot = (await load({ client: scope })) as Snapshot;
    setInvoices(snapshot.invoices);
    setQuotes(snapshot.quotes ?? []);
    setExpenses(snapshot.expenses ?? []);
    setClients(snapshot.clients ?? []);
    setClient(snapshot.client ?? null);
    setSettingsSaved(snapshot.settingsSaved !== false);
    if (snapshot.defaults?.currency) setCurrency((current) => current || snapshot.defaults!.currency);
    setLoaded(true);
  }

  useEffect(() => {
    if (!context.companyId) return;
    setLoaded(false);
    setClient(null);
    setMessage("");
    if (scope && tab === "expenses") setTab("overview");
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

  /** The customer for a new invoice or quote: the workspace client, a picked CRM record, or typed by hand. */
  function customerPayload(picked: string, manual: ManualCustomer): { customerKind: ClientKind; customerRef: string; customerName?: string } {
    if (scope) {
      return { customerKind: scope.kind, customerRef: scope.id, ...(client && !client.found && client.name ? { customerName: client.name } : {}) };
    }
    if (clients.length > 0) {
      const ref = parseClientParam(picked);
      if (!ref) throw new Error("Choose a client");
      return { customerKind: ref.kind, customerRef: ref.id };
    }
    if (!manual.ref.trim()) throw new Error("Customer reference is required");
    return { customerKind: manual.kind, customerRef: manual.ref.trim(), ...(manual.name.trim() ? { customerName: manual.name.trim() } : {}) };
  }

  const clientName = client?.name ?? "this client";
  const q = search.trim().toLowerCase();
  const rows = useMemo(() => invoices.filter((invoice) => !q || `${invoice.number} ${invoice.status} ${invoice.customerRef} ${invoice.customerName ?? ""}`.toLowerCase().includes(q)), [invoices, q]);
  const byStatus = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const invoice of invoices) counts[invoice.status] = (counts[invoice.status] ?? 0) + 1;
    return counts;
  }, [invoices]);
  const totalMinor = invoices.reduce((sum, invoice) => sum + invoice.totalMinor, 0);
  const currencyCode = invoices[0]?.currency ?? "ZAR";
  const draftInvoiceButton = <Button type="button" onClick={() => setCreate("invoice")}>+ Draft invoice</Button>;
  const pageMessage = message
    || (scope && loaded && client && !client.found
      ? `${client.name ?? "This client"} is not in the Billing client list yet. Run the CRM "resync" action so new invoices pick up the CRM name.`
      : undefined)
    || (!settingsSaved
      ? "Billing settings are not saved for this company. Open Settings → Plugins → Billing, add your business, VAT and EFT details, and click Save — they print on every invoice."
      : undefined);
  const lockedClient = scope ? (
    <Field label="Client"><Input value={client?.name ?? scope.id} readOnly disabled /></Field>
  ) : null;

  const body = (
    <>
      <Tabs
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "invoices", label: `Invoices (${invoices.length})` },
          { id: "quotes", label: `Quotes (${quotes.length})` },
          ...(scope ? [] : [{ id: "expenses", label: `Expenses (${expenses.length})` }]),
        ]}
        active={tab}
        onChange={(id) => { setTab(id as TabId); setSearch(""); }}
      />

      {tab === "overview" ? (
        <div style={{ display: "grid", gap: 16 }}>
          <StatRow>
            <MetricCard label="Invoices" value={invoices.length} />
            <MetricCard label="Draft" value={byStatus.draft ?? 0} />
            <MetricCard label="Sent / paid" value={(byStatus.sent ?? 0) + (byStatus.paid ?? 0)} />
            <MetricCard label="Total booked" value={formatMinor(totalMinor, currencyCode)} />
          </StatRow>
          <BarChart title="Invoices by status" items={Object.entries(byStatus).map(([label, value]) => ({ label, value }))} />
        </div>
      ) : null}

      {tab === "invoices" ? (
        <div style={{ display: "grid", gap: 12 }}>
          <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search invoices…">
            {draftInvoiceButton}
          </Toolbar>
          {rows.length === 0 ? (
            <EmptyState
              title={scope ? `No invoices for ${clientName} yet` : "No invoices yet"}
              description="Draft an invoice, add lines, then request send or payment approval."
              action={draftInvoiceButton}
            />
          ) : (
            <DataTable
              columns={[
                { key: "number", header: "Number" },
                { key: "status", header: "Status", render: (value) => <StatusBadge label={String(value)} status={value === "paid" ? "ok" : value === "draft" ? "pending" : "info"} /> },
                { key: "total", header: "Total" },
                { key: "customer", header: "Customer" },
                {
                  key: "id",
                  header: "Actions",
                  width: "340px",
                  render: (_value, row) => (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <Button type="button" variant="secondary" style={{ height: 28, fontSize: 12 }} onClick={() => void invoiceHtml({ invoiceId: String(row.id) }).then((result) => openPrintable(String((result as { html: string }).html))).catch((error: unknown) => setMessage(errorText(error)))}>Print</Button>
                      <Button type="button" variant="secondary" style={{ height: 28, fontSize: 12 }} onClick={() => { setInvoiceId(String(row.id)); setCreate("line"); }}>Add line</Button>
                      <Button type="button" variant="secondary" style={{ height: 28, fontSize: 12 }} onClick={() => void run(() => requestSend({ invoiceId: String(row.id) }), "Send approval opened")}>Request send</Button>
                      <Button type="button" style={{ height: 28, fontSize: 12 }} onClick={() => void run(() => requestPay({ invoiceId: String(row.id) }), "Payment approval opened")}>Request pay</Button>
                    </div>
                  ),
                },
              ]}
              rows={rows.map((invoice) => ({ ...invoice, customer: invoice.customerName ?? invoice.customerRef, total: formatMinor(invoice.totalMinor, invoice.currency) }))}
              emptyMessage="No invoices match."
            />
          )}
        </div>
      ) : null}

      {tab === "quotes" ? (
        <div style={{ display: "grid", gap: 12 }}>
          <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search quotes…">
            <Button type="button" onClick={() => setCreate("quote")}>+ Draft quote</Button>
          </Toolbar>
          {quotes.length === 0 ? (
            <EmptyState
              title={scope ? `No quotes for ${clientName} yet` : "No quotes yet"}
              description="Draft a quote, then convert it to an invoice when the customer accepts."
              action={<Button type="button" onClick={() => setCreate("quote")}>+ Draft quote</Button>}
            />
          ) : (
            <DataTable
              columns={[
                { key: "number", header: "Number" },
                { key: "status", header: "Status", render: (value) => <StatusBadge label={String(value)} status={value === "accepted" ? "ok" : value === "draft" ? "pending" : "info"} /> },
                { key: "total", header: "Total" },
                { key: "customer", header: "Customer" },
                {
                  key: "id",
                  header: "",
                  width: "90px",
                  render: (_value, row) => (
                    <Button type="button" variant="secondary" style={{ height: 28, fontSize: 12 }} onClick={() => void quoteHtml({ quoteId: String(row.id) }).then((result) => openPrintable(String((result as { html: string }).html))).catch((error: unknown) => setMessage(errorText(error)))}>Print</Button>
                  ),
                },
              ]}
              rows={quotes.map((quote) => ({ ...quote, customer: quote.customerName ?? quote.customerRef, total: formatMinor(quote.totalMinor, quote.currency) }))}
              emptyMessage="No quotes match."
            />
          )}
        </div>
      ) : null}

      {tab === "expenses" && !scope ? (
        <div style={{ display: "grid", gap: 12 }}>
          <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search expenses…">
            <Button type="button" onClick={() => setCreate("expense")}>+ Add expense</Button>
          </Toolbar>
          {expenses.length === 0 ? (
            <EmptyState title="No expenses yet" description="Record business expenses to track spend." action={<Button type="button" onClick={() => setCreate("expense")}>+ Add expense</Button>} />
          ) : (
            <DataTable
              columns={[
                { key: "description", header: "Description" },
                { key: "category", header: "Category" },
                { key: "amount", header: "Amount" },
              ]}
              rows={expenses.map((expense) => ({ ...expense, amount: formatMinor(expense.amountMinor, expense.currency) }))}
              emptyMessage="No expenses match."
            />
          )}
        </div>
      ) : null}

      <Modal open={create === "invoice"} title={scope ? `Draft invoice for ${clientName}` : "Draft invoice"} onClose={() => setCreate(null)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
          <Button type="button" onClick={() => void run(async () => {
            await createInvoice({ currency, ...customerPayload(invoiceCustomer, invoiceManual) });
            setInvoiceCustomer("");
            setInvoiceManual(EMPTY_MANUAL);
          }, "Draft created")}>Create draft</Button>
        </>
      )}>
        {lockedClient ?? (clients.length > 0
          ? <ClientSelect clients={clients} value={invoiceCustomer} onChange={setInvoiceCustomer} />
          : <ManualCustomerFields value={invoiceManual} onChange={setInvoiceManual} />)}
        <Field label="Currency"><Input value={currency} onChange={(event) => setCurrency(event.target.value)} /></Field>
      </Modal>

      <Modal open={create === "line"} title="Add line" onClose={() => setCreate(null)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
          <Button type="button" onClick={() => void run(() => addLine({
            invoiceId,
            description,
            quantity: Number(quantity),
            unitAmountMinor: toMinor(unitAmount),
          }), "Line added")}>Add line</Button>
        </>
      )}>
        <Field label="Description"><Input value={description} onChange={(event) => setDescription(event.target.value)} required /></Field>
        <Field label="Quantity"><Input value={quantity} onChange={(event) => setQuantity(event.target.value)} /></Field>
        <Field label="Unit price (excl. VAT)"><Input value={unitAmount} onChange={(event) => setUnitAmount(event.target.value)} required /></Field>
      </Modal>

      <Modal open={create === "quote"} title={scope ? `Draft quote for ${clientName}` : "Draft quote"} onClose={() => setCreate(null)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
          <Button type="button" onClick={() => void run(async () => {
            await createQuote({ currency, ...customerPayload(quoteCustomer, quoteManual) });
            setQuoteCustomer("");
            setQuoteManual(EMPTY_MANUAL);
          }, "Quote draft created")}>Create quote</Button>
        </>
      )}>
        {lockedClient ?? (clients.length > 0
          ? <ClientSelect clients={clients} value={quoteCustomer} onChange={setQuoteCustomer} />
          : <ManualCustomerFields value={quoteManual} onChange={setQuoteManual} />)}
        <Field label="Currency"><Input value={currency} onChange={(event) => setCurrency(event.target.value)} /></Field>
      </Modal>

      <Modal open={create === "expense" && !scope} title="Add expense" onClose={() => setCreate(null)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
          <Button type="button" onClick={() => void run(async () => {
            await createExpense({ description: expenseDescription, amountMinor: toMinor(expenseAmount || "0"), category: expenseCategory });
            setExpenseDescription("");
            setExpenseAmount("");
          }, "Expense recorded")}>Save expense</Button>
        </>
      )}>
        <Field label="Description"><Input value={expenseDescription} onChange={(event) => setExpenseDescription(event.target.value)} required /></Field>
        <Field label="Amount"><Input value={expenseAmount} onChange={(event) => setExpenseAmount(event.target.value)} required /></Field>
        <Field label="Category"><Input value={expenseCategory} onChange={(event) => setExpenseCategory(event.target.value)} /></Field>
      </Modal>
    </>
  );

  if (scope) {
    return (
      <WorkspacePage
        header={(
          <ClientWorkspaceBar
            client={{ kind: scope.kind, id: scope.id, name: client?.name ?? (loaded ? "Unknown client" : "Loading…"), detail: client?.detail ?? null }}
            active="billing"
            linkProps={navigation.linkProps}
            ownPath="/billing"
            ownLabel="All billing"
            actions={draftInvoiceButton}
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
      title="Billing"
      description="PiB's invoices, quotes and expenses. Draft an invoice here. Sending and payment wait for a person to finish the approval issue."
      message={pageMessage}
      actions={draftInvoiceButton}
    >
      {body}
    </Page>
  );
}

export function BillingSidebar(_props: PluginSidebarProps) {
  return (
    <SidebarNavLink to="/billing" label="Billing" icon={(
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" />
        <path d="M16 8H8" /><path d="M16 12H8" /><path d="M12 16H8" />
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
