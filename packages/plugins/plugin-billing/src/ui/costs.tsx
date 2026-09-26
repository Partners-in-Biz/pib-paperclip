import { useEffect, useMemo, useState } from "react";
import { DataTable } from "@paperclipai/plugin-sdk/ui";
import { Button, EmptyState, Field, Input, Modal, Select, TextArea, Toolbar, errorText, tokens } from "@partnersinbiz/pib-plugin-ui";
import { parseClientParam } from "@partnersinbiz/pib-plugin-kit/client-ref";
import { Card, ClientSelect, Drawer, FilePicker, Muted, Row, SmallButton, Status, TaxCodeSelect, Totals, dayInput, fmtDate, minorToInput, money, openUrl, taxShort, toMinor, today, uploadFile, useBilling, words } from "./parts.js";
import type { Bill, Expense } from "./types.js";

// ── Bills ──────────────────────────────────────────────────────────────────

export function BillsTab() {
  const { snapshot, call, run } = useBilling();
  const bills = snapshot.bills ?? [];
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [supplier, setSupplier] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [reference, setReference] = useState("");
  const [issueDate, setIssueDate] = useState(today());
  const [dueDate, setDueDate] = useState("");
  const [category, setCategory] = useState("other");
  const q = search.trim().toLowerCase();
  const rows = useMemo(() => bills.filter((b) => !q || `${b.supplierName} ${b.supplierReference ?? ""} ${b.status}`.toLowerCase().includes(q)), [bills, q]);
  const newButton = <Button type="button" onClick={() => setCreating(true)}>+ Add bill</Button>;
  const owed = bills.reduce((sum, b) => sum + (b.currency === (snapshot.defaults?.currency ?? "ZAR") ? b.outstandingMinor : 0), 0);
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search bills…">{newButton}</Toolbar>
      {bills.length > 0 ? <Muted>{money(owed, snapshot.defaults?.currency ?? "ZAR")} owed to suppliers. Supplier invoices that arrive by email from a known supplier are drafted here automatically.</Muted> : null}
      {bills.length === 0 ? (
        <EmptyState title="No bills yet" description="Add a supplier's invoice with its lines and VAT, approve it (it is posted to the books), then pay it." action={newButton} />
      ) : (
        <DataTable
          columns={[
            { key: "supplierName", header: "Supplier" },
            { key: "ref", header: "Their ref" },
            { key: "status", header: "Status", render: (value) => <Status status={String(value)} /> },
            { key: "total", header: "Total" },
            { key: "owed", header: "Owed" },
            { key: "due", header: "Due" },
            { key: "id", header: "", width: "80px", render: (_v, row) => <SmallButton onClick={() => setOpenId(String(row.id))}>Open</SmallButton> },
          ]}
          rows={rows.map((b) => ({ ...b, ref: b.supplierReference ?? "—", total: money(b.totalMinor, b.currency), owed: b.outstandingMinor ? money(b.outstandingMinor, b.currency) : "—", due: fmtDate(b.dueDate) }))}
        />
      )}
      <Modal open={creating} title="Add bill" onClose={() => setCreating(false)} footer={<>
        <Button type="button" variant="secondary" onClick={() => setCreating(false)}>Cancel</Button>
        <Button type="button" onClick={() => void run(async () => {
          const ref = parseClientParam(supplier);
          const bill = await call<{ id: string }>("billing.create-bill", {
            supplierKind: ref ? ref.kind : "text",
            ...(ref ? { supplierRef: ref.id } : {}),
            supplierName: supplierName || (snapshot.clients ?? []).find((c) => ref && c.id === ref.id)?.name || "",
            supplierReference: reference,
            issueDate,
            ...(dueDate ? { dueDate } : {}),
            category,
          });
          setCreating(false);
          setOpenId(bill.id);
        }, "Bill drafted. Add its lines.")}>Create</Button>
      </>}>
        <ClientSelect clients={snapshot.clients ?? []} value={supplier} onChange={setSupplier} label="Supplier from the CRM" allowEmpty />
        {!supplier ? <Field label="Or supplier name"><Input value={supplierName} onChange={(e) => setSupplierName(e.target.value)} /></Field> : null}
        <Field label="Their invoice number"><Input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
        <Row>
          <Field label="Invoice date"><Input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} /></Field>
          <Field label="Due (default 30 days)"><Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
        </Row>
        <CategorySelect value={category} onChange={setCategory} />
      </Modal>
      {openId ? <BillDrawer billId={openId} onClose={() => setOpenId(null)} /> : null}
    </div>
  );
}

function CategorySelect({ value, onChange, label = "Category" }: { value: string; onChange: (value: string) => void; label?: string }) {
  const { snapshot } = useBilling();
  const categories = snapshot.expenseCategories ?? ["other"];
  return (
    <Field label={label}>
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        {[...new Set([...categories, value])].map((c) => <option key={c} value={c}>{words(c)}</option>)}
      </Select>
    </Field>
  );
}

function BillDrawer({ billId, onClose }: { billId: string; onClose: () => void }) {
  const { call, snapshot, run, say } = useBilling();
  const [bill, setBill] = useState<Bill | null>(null);
  const [line, setLine] = useState({ description: "", quantity: "1", unit: "", taxCode: "", category: "" });
  const [paying, setPaying] = useState(false);
  const [amount, setAmount] = useState("");
  const [paidAt, setPaidAt] = useState(today());
  const [reference, setReference] = useState("");

  async function reload() {
    setBill(await call<Bill>("billing.bill-detail", { billId }));
  }
  useEffect(() => {
    reload().catch((error: unknown) => say(errorText(error)));
  }, [billId]);
  const act = (work: () => Promise<unknown>, success: string) => run(async () => { await work(); await reload(); }, success);

  if (!bill) return <Drawer open title="Bill" onClose={onClose}><Muted>Loading…</Muted></Drawer>;
  const draft = bill.status === "draft";
  const cur = bill.currency;
  return (
    <Drawer
      open
      title={`Bill from ${bill.supplierName}`}
      subtitle={<><Status status={bill.status} />{bill.supplierReference ? <span>Ref {bill.supplierReference}</span> : null}<span>· Due {fmtDate(bill.dueDate)}</span>{bill.source === "email" ? <span>· from email</span> : null}{bill.pendingAction ? <span>· waiting on the approval issue</span> : null}</>}
      onClose={onClose}
      actions={<>
        {draft ? <SmallButton variant="primary" disabled={bill.totalMinor <= 0} onClick={() => void act(() => call("billing.approve-bill", { billId: bill.id }), "Bill approved and posted")}>Approve</SmallButton> : null}
        {bill.status === "approved" || bill.status === "partially_paid" ? <SmallButton variant="primary" onClick={() => { setAmount(minorToInput(bill.outstandingMinor)); setPaying(true); }}>Record payment</SmallButton> : null}
        {snapshot.features?.r2 ? <FilePicker label={bill.hasFile ? "Replace file" : "Attach supplier invoice"} onFile={(file) => void act(async () => {
          const up = await uploadFile(call, "bill", file);
          await call("billing.attach-bill-file", { billId: bill.id, key: up.key, fileName: up.fileName, mime: up.mime });
        }, "File attached")} /> : null}
        {bill.hasFile ? <SmallButton onClick={() => void call<{ url: string }>("billing.bill-file", { billId: bill.id }).then((r) => openUrl(r.url)).catch((e: unknown) => say(errorText(e)))}>View file</SmallButton> : null}
        {bill.status !== "cancelled" && bill.paidMinor === 0 ? <SmallButton onClick={() => void act(() => call("billing.cancel-bill", { billId: bill.id }), "Bill cancelled")}>Cancel bill</SmallButton> : null}
      </>}
    >
      {bill.ledgerStatus === "rejected" ? <Muted style={{ color: tokens.destructive }}>Accounting refused this bill's journal: {bill.ledgerError ?? ""}</Muted> : null}
      <Card title="Lines">
        {bill.lines.length === 0 ? <Muted>No lines yet. Copy them from the supplier's invoice.</Muted> : bill.lines.map((l) => (
          <Row key={l.id} style={{ justifyContent: "space-between", padding: "8px 10px", borderRadius: 8, background: tokens.secondary, fontSize: 13 }}>
            <span>{l.description} <span style={{ color: tokens.muted }}>· {l.quantity} × {money(l.unitAmountMinor, cur)} · {taxShort(l.taxCode, snapshot.taxCodes)} · {words(l.category ?? bill.category)}</span></span>
            <Row style={{ gap: 6 }}>
              <span>{money(l.grossMinor, cur)}</span>
              {draft ? <SmallButton onClick={() => void act(() => call("billing.remove-bill-line", { billId: bill.id, lineId: l.id }), "Line removed")}>Remove</SmallButton> : null}
            </Row>
          </Row>
        ))}
        {draft ? (
          <div style={{ display: "grid", gridTemplateColumns: "2fr 60px 110px 140px 140px auto", gap: 6, alignItems: "end" }}>
            <Field label="Description"><Input value={line.description} onChange={(e) => setLine({ ...line, description: e.target.value })} /></Field>
            <Field label="Qty"><Input value={line.quantity} onChange={(e) => setLine({ ...line, quantity: e.target.value })} /></Field>
            <Field label={bill.pricesIncludeVat ? "Amount (incl.)" : "Amount (excl.)"}><Input value={line.unit} onChange={(e) => setLine({ ...line, unit: e.target.value })} placeholder="0.00" /></Field>
            <TaxCodeSelect value={line.taxCode} onChange={(taxCode) => setLine({ ...line, taxCode })} allowDefault="Default" />
            <CategorySelect label="Category" value={line.category || bill.category} onChange={(category) => setLine({ ...line, category })} />
            <SmallButton variant="primary" style={{ height: 36 }} onClick={() => void act(async () => {
              await call("billing.add-bill-line", { billId: bill.id, description: line.description, quantity: Number(line.quantity || "1"), unitAmountMinor: toMinor(line.unit), ...(line.taxCode ? { taxCode: line.taxCode } : {}), ...(line.category ? { category: line.category } : {}) });
              setLine({ ...line, description: "", unit: "" });
            }, "Line added")}>Add</SmallButton>
          </div>
        ) : null}
        <Totals rows={[
          { label: "Subtotal (excl. VAT)", value: money(bill.subtotalMinor, cur) },
          { label: "VAT (input)", value: money(bill.vatMinor, cur) },
          { label: "Total", value: money(bill.totalMinor, cur), strong: true },
          ...(bill.paidMinor ? [{ label: "Paid", value: `− ${money(bill.paidMinor, cur)}` }, { label: "Still owed", value: money(bill.outstandingMinor, cur), strong: true }] : []),
        ]} />
      </Card>
      {draft ? <BillDetails bill={bill} onSave={(patch) => act(() => call("billing.update-bill", { billId: bill.id, ...patch }), "Bill saved")} /> : null}
      {(bill.payments ?? []).length > 0 ? (
        <Card title="Payments">
          {(bill.payments ?? []).map((p) => <Muted key={p.id}>{fmtDate(p.paidAt)} · {money(p.amountMinor, cur)}{p.reference ? ` · ${p.reference}` : ""}{p.bankTxId ? " · matched to the bank" : ""}</Muted>)}
        </Card>
      ) : null}
      {bill.journalNumber ? <Muted>Books: posted as {bill.journalNumber}</Muted> : null}
      <Modal open={paying} title="Record bill payment" onClose={() => setPaying(false)} footer={<>
        <Button type="button" variant="secondary" onClick={() => setPaying(false)}>Cancel</Button>
        <Button type="button" onClick={() => void act(async () => {
          await call("billing.pay-bill", { billId: bill.id, amountMinor: toMinor(amount), paidAt, reference });
          setPaying(false);
        }, "Payment recorded")}>Record</Button>
      </>}>
        <Field label={`Amount (${cur})`}><Input value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Date paid"><Input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} /></Field>
        <Field label="Reference"><Input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
      </Modal>
    </Drawer>
  );
}

function BillDetails({ bill, onSave }: { bill: Bill; onSave: (patch: Record<string, unknown>) => Promise<boolean> }) {
  const [reference, setReference] = useState(bill.supplierReference ?? "");
  const [issueDate, setIssueDate] = useState(dayInput(bill.issueDate));
  const [dueDate, setDueDate] = useState(dayInput(bill.dueDate));
  const [inclusive, setInclusive] = useState(bill.pricesIncludeVat);
  const [category, setCategory] = useState(bill.category);
  const [notes, setNotes] = useState(bill.notes ?? "");
  return (
    <Card title="Details">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
        <Field label="Their invoice number"><Input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
        <Field label="Invoice date"><Input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} /></Field>
        <Field label="Due"><Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
        <Field label="Amounts">
          <Select value={inclusive ? "incl" : "excl"} onChange={(e) => setInclusive(e.target.value === "incl")}>
            <option value="incl">Include VAT</option>
            <option value="excl">Exclude VAT</option>
          </Select>
        </Field>
        <CategorySelect value={category} onChange={setCategory} />
      </div>
      <Field label="Notes"><TextArea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <Row><SmallButton variant="primary" onClick={() => void onSave({ supplierReference: reference, issueDate: issueDate || null, dueDate: dueDate || null, pricesIncludeVat: inclusive, category, notes })}>Save details</SmallButton></Row>
    </Card>
  );
}

// ── Expenses ───────────────────────────────────────────────────────────────

export function ExpensesTab() {
  const { snapshot, call, run } = useBilling();
  const expenses = snapshot.expenses ?? [];
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const q = search.trim().toLowerCase();
  const rows = useMemo(() => expenses.filter((e) => !q || `${e.description} ${e.vendor ?? ""} ${e.category}`.toLowerCase().includes(q)), [expenses, q]);
  const review = expenses.filter((e) => e.status === "draft" || e.needsReview).length;
  const upload = snapshot.features?.r2 ? (
    <FilePicker label="Upload receipt" onFile={(file) => void run(async () => {
      const up = await uploadFile(call, "receipt", file);
      const expense = await call<Expense>("billing.receipt-to-expense", { key: up.key, mime: up.mime, fileName: up.fileName });
      setEditing(expense);
    }, snapshot.features?.receipts ? "Receipt read. Check the fields and save." : "Receipt uploaded. Fill in the fields and save.")} />
  ) : null;
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search expenses…">
        {upload}
        <Button type="button" onClick={() => setAdding(true)}>+ Add expense</Button>
      </Toolbar>
      {review > 0 ? <Muted>{review} expense{review === 1 ? "" : "s"} to check (drafts from receipts, or an unsure category).</Muted> : null}
      {!snapshot.features?.r2 ? <Muted>Set up the private R2 bucket in Billing settings to upload receipts.</Muted> : null}
      {expenses.length === 0 ? (
        <EmptyState title="No expenses yet" description="Upload a receipt (read automatically when a Claude key is set) or add an expense. Each one is posted to the books." action={<Button type="button" onClick={() => setAdding(true)}>+ Add expense</Button>} />
      ) : (
        <DataTable
          columns={[
            { key: "date", header: "Date" },
            { key: "what", header: "Expense" },
            { key: "category", header: "Category" },
            { key: "amount", header: "Amount" },
            { key: "vat", header: "VAT" },
            { key: "status", header: "Status", render: (value, row) => <Row style={{ gap: 4 }}><Status status={String(value)} />{row.needsReview ? <span style={{ fontSize: 11, color: tokens.muted }}>check</span> : null}</Row> },
            { key: "id", header: "", width: "80px", render: (_v, row) => <SmallButton onClick={() => setEditing(expenses.find((e) => e.id === row.id) ?? null)}>Open</SmallButton> },
          ]}
          rows={rows.map((e) => ({ ...e, date: fmtDate(e.incurredOn), what: e.vendor ? `${e.description} · ${e.vendor}` : e.description, category: words(e.category), amount: money(e.amountMinor, e.currency), vat: e.vatMinor ? `${money(e.vatMinor, e.currency)}${e.vatClaimable ? " (claim)" : ""}` : "—" }))}
        />
      )}
      <ExpenseModal open={adding} expense={null} onClose={() => setAdding(false)} />
      <ExpenseModal open={Boolean(editing)} expense={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function ExpenseModal({ open, expense, onClose }: { open: boolean; expense: Expense | null; onClose: () => void }) {
  const { call, run, snapshot, say } = useBilling();
  const [form, setForm] = useState({ description: "", vendor: "", amount: "", vat: "", category: "other", date: today(), vatClaimable: false, paidFrom: "bank", taxCode: "" });
  useEffect(() => {
    if (!open) return;
    setForm(expense
      ? { description: expense.description, vendor: expense.vendor ?? "", amount: minorToInput(expense.amountMinor), vat: minorToInput(expense.vatMinor), category: expense.category, date: dayInput(expense.incurredOn) || today(), vatClaimable: expense.vatClaimable, paidFrom: expense.paidFrom, taxCode: expense.taxCode ?? "" }
      : { description: "", vendor: "", amount: "", vat: "", category: "other", date: today(), vatClaimable: false, paidFrom: "bank", taxCode: "" });
  }, [open, expense?.id]);
  const extraction = expense?.extraction;
  const recorded = expense?.status === "recorded";
  const save = () => void run(async () => {
    const fields = {
      description: form.description,
      vendor: form.vendor || null,
      amountMinor: toMinor(form.amount || "0"),
      vatMinor: form.vat ? toMinor(form.vat) : 0,
      category: form.category,
      incurredOn: form.date,
      vatClaimable: form.vatClaimable,
      paidFrom: form.paidFrom,
      ...(form.taxCode ? { taxCode: form.taxCode } : {}),
    };
    if (expense) await call("billing.update-expense", { expenseId: expense.id, ...fields, record: true });
    else {
      const { incurredOn, ...rest } = fields;
      await call("billing.create-expense", { ...rest, incurredOn, vendor: fields.vendor ?? undefined });
    }
    onClose();
  }, recorded || !expense ? "Expense saved and posted" : "Expense recorded and posted");
  return (
    <Modal open={open} title={expense ? (expense.status === "draft" ? "Check the receipt" : "Expense") : "Add expense"} description={expense?.status === "draft" ? "Nothing is posted until you save." : undefined} onClose={onClose} footer={<>
      {expense && expense.status !== "void" && expense.status !== "draft" ? <Button type="button" variant="secondary" onClick={() => void run(async () => { await call("billing.void-expense", { expenseId: expense.id }); onClose(); }, "Expense voided (journal reversed)")}>Void</Button> : null}
      <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
      <Button type="button" onClick={save} disabled={expense?.status === "void"}>{expense?.status === "draft" ? "Save and post" : "Save"}</Button>
    </>}>
      {extraction?.error ? <Muted style={{ color: tokens.destructive }}>Could not read the receipt: {extraction.error}</Muted> : null}
      {extraction?.fields ? <Muted>Read from the receipt{extraction.jev?.category ? `; category suggested by Jev${extraction.jev.categoryConfident ? "" : " (unsure)"}` : ""}. Check before saving.</Muted> : null}
      {expense?.hasReceipt ? <Row><SmallButton onClick={() => void call<{ url: string }>("billing.receipt-file", { expenseId: expense.id }).then((r) => openUrl(r.url)).catch((e: unknown) => say(errorText(e)))}>View receipt</SmallButton></Row> : null}
      <Field label="Description"><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
      <Field label="Vendor"><Input value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} /></Field>
      <Row>
        <Field label="Total paid (incl. VAT)"><Input value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>
        <Field label="VAT on the receipt"><Input value={form.vat} onChange={(e) => setForm({ ...form, vat: e.target.value })} /></Field>
      </Row>
      <Row>
        <Field label="Date"><Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
        <Field label="Paid from">
          <Select value={form.paidFrom} onChange={(e) => setForm({ ...form, paidFrom: e.target.value })}>
            <option value="bank">Business bank</option>
            <option value="card">Business card</option>
            <option value="cash">Petty cash</option>
            <option value="owner">Owner paid (to reimburse)</option>
          </Select>
        </Field>
      </Row>
      <CategorySelect value={form.category} onChange={(category) => setForm({ ...form, category })} />
      <Row>
        <Field label="Claim the VAT">
          <Select value={form.vatClaimable ? "yes" : "no"} onChange={(e) => setForm({ ...form, vatClaimable: e.target.value === "yes" })}>
            <option value="yes">Yes (valid tax invoice)</option>
            <option value="no">No</option>
          </Select>
        </Field>
        {form.vat ? <TaxCodeSelect value={form.taxCode} onChange={(taxCode) => setForm({ ...form, taxCode })} allowDefault="Standard 15%" /> : null}
      </Row>
      {snapshot.features?.ledger ? <Muted>Saved expenses post to the books: the expense{form.vatClaimable ? ", input VAT" : ""} and the account it was paid from.</Muted> : null}
    </Modal>
  );
}
