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
  formatMinor,
} from "@partnersinbiz/pib-plugin-ui";

interface Invoice { id: string; number: string; status: string; currency: string; totalMinor: number; customerRef: string; customerName?: string | null; taxRate?: number; dueAt?: string | null }
interface Quote { id: string; number: string; status: string; currency: string; totalMinor: number; customerRef: string; customerName?: string | null }
interface Client { id: string; name: string }
interface Snapshot {
  invoices: Invoice[];
  quotes?: Quote[];
  expenses?: Expense[];
  clients?: Client[];
  settingsSaved?: boolean;
  defaults?: { currency: string; taxRate: number; senderName: string };
}

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

export function BillingPage({ context }: PluginPageProps) {
  const load = usePluginAction("billing.load");
  const createInvoice = usePluginAction("billing.create-invoice");
  const addLine = usePluginAction("billing.add-line");
  const requestSend = usePluginAction("billing.request-send");
  const requestPay = usePluginAction("billing.request-pay");
  const createQuote = usePluginAction("billing.create-quote");
  const createExpense = usePluginAction("billing.create-expense");
  const invoiceHtml = usePluginAction("billing.invoice-html");
  const quoteHtml = usePluginAction("billing.quote-html");
  const [clients, setClients] = useState<Client[]>([]);
  const [settingsSaved, setSettingsSaved] = useState(true);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<TabId>("overview");
  const [search, setSearch] = useState("");
  const [create, setCreate] = useState<CreateKind>(null);
  const [customerName, setCustomerName] = useState("");
  const [customerRef, setCustomerRef] = useState("");
  const [currency, setCurrency] = useState("ZAR");
  const [invoiceId, setInvoiceId] = useState("");
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unitAmount, setUnitAmount] = useState("");
  const [quoteName, setQuoteName] = useState("");
  const [quoteRef, setQuoteRef] = useState("");
  const [expenseDescription, setExpenseDescription] = useState("");
  const [expenseAmount, setExpenseAmount] = useState("");
  const [expenseCategory, setExpenseCategory] = useState("other");

  async function refresh() {
    const snapshot = (await load({})) as Snapshot;
    setInvoices(snapshot.invoices);
    setQuotes(snapshot.quotes ?? []);
    setExpenses(snapshot.expenses ?? []);
    setClients(snapshot.clients ?? []);
    setSettingsSaved(snapshot.settingsSaved !== false);
    if (snapshot.defaults?.currency) setCurrency((current) => current || snapshot.defaults!.currency);
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
  const rows = useMemo(() => invoices.filter((invoice) => !q || `${invoice.number} ${invoice.status} ${invoice.customerRef} ${invoice.customerName ?? ""}`.toLowerCase().includes(q)), [invoices, q]);
  const byStatus = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const invoice of invoices) counts[invoice.status] = (counts[invoice.status] ?? 0) + 1;
    return counts;
  }, [invoices]);
  const totalMinor = invoices.reduce((sum, invoice) => sum + invoice.totalMinor, 0);
  const currencyCode = invoices[0]?.currency ?? "ZAR";

  return (
    <Page
      title="Billing"
      description="Draft an invoice here. Sending and payment wait for a person to finish the approval issue."
      message={message || (!settingsSaved
        ? "Billing settings are not saved for this company. Open Settings → Plugins → Billing, add your business, VAT and EFT details, and click Save — they print on every invoice."
        : undefined)}
      actions={<Button type="button" onClick={() => setCreate("invoice")}>+ Draft invoice</Button>}
    >
      <Tabs
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "invoices", label: `Invoices (${invoices.length})` },
          { id: "quotes", label: `Quotes (${quotes.length})` },
          { id: "expenses", label: `Expenses (${expenses.length})` },
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
            <Button type="button" onClick={() => setCreate("invoice")}>+ Draft invoice</Button>
          </Toolbar>
          {rows.length === 0 ? (
            <EmptyState title="No invoices yet" description="Draft an invoice, add lines, then request send or payment approval." action={<Button type="button" onClick={() => setCreate("invoice")}>+ Draft invoice</Button>} />
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
            <EmptyState title="No quotes yet" description="Draft a quote, then convert it to an invoice when the customer accepts." action={<Button type="button" onClick={() => setCreate("quote")}>+ Draft quote</Button>} />
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

      {tab === "expenses" ? (
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

      <Modal open={create === "invoice"} title="Draft invoice" onClose={() => setCreate(null)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
          <Button type="button" onClick={() => void run(async () => {
            await createInvoice({ currency, customerKind: "company", customerRef, ...(customerName ? { customerName } : {}) });
            setCustomerName("");
            setCustomerRef("");
          }, "Draft created")}>Create draft</Button>
        </>
      )}>
        {clients.length > 0 ? (
          <Field label="Client">
            <Select value={customerRef} onChange={(event) => setCustomerRef(event.target.value)} required>
              <option value="">Choose a CRM client…</option>
              {clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
            </Select>
          </Field>
        ) : (
          <>
            <Field label="Customer name"><Input value={customerName} onChange={(event) => setCustomerName(event.target.value)} required /></Field>
            <Field label="Customer reference (CRM id)"><Input value={customerRef} onChange={(event) => setCustomerRef(event.target.value)} required /></Field>
          </>
        )}
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

      <Modal open={create === "quote"} title="Draft quote" onClose={() => setCreate(null)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
          <Button type="button" onClick={() => void run(async () => {
            await createQuote({ currency, customerKind: "company", customerRef: quoteRef, ...(quoteName ? { customerName: quoteName } : {}) });
            setQuoteName("");
            setQuoteRef("");
          }, "Quote draft created")}>Create quote</Button>
        </>
      )}>
        {clients.length > 0 ? (
          <Field label="Client">
            <Select value={quoteRef} onChange={(event) => setQuoteRef(event.target.value)} required>
              <option value="">Choose a CRM client…</option>
              {clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
            </Select>
          </Field>
        ) : (
          <>
            <Field label="Customer name"><Input value={quoteName} onChange={(event) => setQuoteName(event.target.value)} required /></Field>
            <Field label="Customer reference (CRM id)"><Input value={quoteRef} onChange={(event) => setQuoteRef(event.target.value)} required /></Field>
          </>
        )}
        <Field label="Currency"><Input value={currency} onChange={(event) => setCurrency(event.target.value)} /></Field>
      </Modal>

      <Modal open={create === "expense"} title="Add expense" onClose={() => setCreate(null)} footer={(
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
