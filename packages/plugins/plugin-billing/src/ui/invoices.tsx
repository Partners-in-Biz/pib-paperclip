import { useEffect, useMemo, useState } from "react";
import { DataTable } from "@paperclipai/plugin-sdk/ui";
import { Button, CircleCheck, CircleX, CompactRows, EmptyState, Field, Input, Mail, Modal, Pill, Receipt, ResponsiveGrid, Select, Send, TextArea, Timeline, Toolbar, errorText, fluidColumns, formatShortDate, tokens, tone, useIsNarrow, type TimelineItem } from "@partnersinbiz/pib-plugin-ui";
import { parseClientParam } from "@partnersinbiz/pib-plugin-kit/client-ref";
import {
  Card,
  ClientSelect,
  DeliveryNote,
  Drawer,
  EMPTY_MANUAL,
  FilePicker,
  ManualCustomerFields,
  Money,
  Muted,
  Row,
  SmallButton,
  Status,
  TaxCodeSelect,
  Totals,
  dayInput,
  fmtDate,
  minorToInput,
  money,
  openBase64Pdf,
  openUrl,
  statusLabel,
  taxShort,
  toMinor,
  today,
  uploadFile,
  useBilling,
  words,
  type ManualCustomer,
} from "./parts.js";
import { OPEN_STATUSES, isOverdue } from "./series.js";
import type { Invoice, InvoiceDetail, PaymentLink } from "./types.js";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "draft", label: "Drafts" },
  { id: "open", label: "Unpaid" },
  { id: "checking", label: "Checking payment" },
  { id: "overdue", label: "Overdue" },
  { id: "paid", label: "Paid" },
] as const;

const OPEN = OPEN_STATUSES;

export function customerPayload(scope: ReturnType<typeof useBilling>["scope"], clientsCount: number, picked: string, manual: ManualCustomer, workspaceName: string | null, found: boolean) {
  if (scope) return { customerKind: scope.kind, customerRef: scope.id, ...(!found && workspaceName ? { customerName: workspaceName } : {}) };
  if (clientsCount > 0) {
    const ref = parseClientParam(picked);
    if (!ref) throw new Error("Choose a client");
    return { customerKind: ref.kind, customerRef: ref.id };
  }
  if (!manual.ref.trim()) throw new Error("Customer reference is required");
  return { customerKind: manual.kind, customerRef: manual.ref.trim(), ...(manual.name.trim() ? { customerName: manual.name.trim() } : {}) };
}

/** The new invoice or quote form. `dealId` (a CRM deal, from a deep link) is saved on the document. */
export function NewDocumentModal({ kind, open, onClose, onCreated, dealId = null }: { kind: "invoice" | "quote"; open: boolean; onClose: () => void; onCreated: (id: string) => void; dealId?: string | null }) {
  const { call, snapshot, scope, clientName, run } = useBilling();
  const clients = snapshot.clients ?? [];
  const [picked, setPicked] = useState("");
  const [manual, setManual] = useState<ManualCustomer>(EMPTY_MANUAL);
  const [currency, setCurrency] = useState(snapshot.defaults?.currency ?? "ZAR");
  const [taxCode, setTaxCode] = useState(snapshot.defaults?.taxCode ?? "za_std_15");
  const [inclusive, setInclusive] = useState(Boolean(snapshot.defaults?.pricesIncludeVat));
  return (
    <Modal open={open} title={`${kind === "invoice" ? "Draft invoice" : "Draft quote"}${scope ? ` for ${clientName}` : ""}`} onClose={onClose} footer={(
      <>
        <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
        <Button type="button" onClick={() => void run(async () => {
          const payload = { currency, taxCode, pricesIncludeVat: inclusive, ...(dealId ? { dealId } : {}), ...customerPayload(scope, clients.length, picked, manual, snapshot.client?.name ?? null, Boolean(snapshot.client?.found)) };
          const created = await call<{ id: string }>(kind === "invoice" ? "billing.create-invoice" : "billing.create-quote", payload);
          setPicked("");
          setManual(EMPTY_MANUAL);
          onClose();
          onCreated(created.id);
        }, kind === "invoice" ? "Draft created. Add its lines." : "Quote draft created. Add its lines.")}>Create draft</Button>
      </>
    )}>
      {dealId ? <Muted>Linked to the CRM deal it was started from.</Muted> : null}
      {scope ? <Field label="Client"><Input value={clientName} readOnly disabled /></Field> : clients.length > 0
        ? <ClientSelect clients={clients} value={picked} onChange={setPicked} />
        : <ManualCustomerFields value={manual} onChange={setManual} />}
      <Field label="Currency"><Input value={currency} maxLength={3} onChange={(event) => setCurrency(event.target.value.toUpperCase())} /></Field>
      <TaxCodeSelect label="VAT for new lines" value={taxCode} onChange={setTaxCode} />
      <Field label="Prices">
        <Select value={inclusive ? "incl" : "excl"} onChange={(event) => setInclusive(event.target.value === "incl")}>
          <option value="excl">Line prices exclude VAT</option>
          <option value="incl">Line prices include VAT</option>
        </Select>
      </Field>
      <Muted>{kind === "invoice" ? "It" : "The quote"} gets its number automatically ({snapshot.features?.numbering === "sequential" ? (kind === "invoice" ? "INV-0001" : "QTE-0001") : (kind === "invoice" ? "per client, e.g. LUM-001" : "per client, e.g. Q-LUM-001")}).</Muted>
    </Modal>
  );
}

/** Set a client's three letters and the number its next invoice gets, to carry on from an old system. */
function NumberingModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { call, snapshot, scope, clientName, run } = useBilling();
  const clients = snapshot.clients ?? [];
  const [picked, setPicked] = useState("");
  const [prefix, setPrefix] = useState("");
  const [start, setStart] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const ref = scope ? { kind: scope.kind, id: scope.id } : parseClientParam(picked);
  const client = ref ? `${ref.kind}:${ref.id}` : "";
  useEffect(() => {
    if (!open || !client) { setPrefix(""); setStart(""); setHint(null); return; }
    let live = true;
    void call<{ prefix: string | null; nextNumber: number; next: string | null }>("billing.get-numbering", { client }).then((n) => {
      if (!live) return;
      setPrefix(n.prefix ?? "");
      setStart(String(n.nextNumber));
      setHint(n.next ? `Next invoice: ${n.next}` : "No invoice number yet. Choose three letters.");
    }).catch(() => undefined);
    return () => { live = false; };
  }, [open, client]);
  return (
    <Modal open={open} title={`Invoice numbering${scope ? ` for ${clientName}` : ""}`} onClose={onClose} footer={(
      <>
        <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
        <Button type="button" onClick={() => void run(async () => {
          if (!client) throw new Error("Choose a client");
          const result = await call<{ next: string }>("billing.set-numbering", { client, prefix: prefix.trim(), nextNumber: Number(start) });
          onClose();
          return result;
        }, "Numbering saved. The next invoice continues from it.")}>Save</Button>
      </>
    )}>
      {scope ? <Field label="Client"><Input value={clientName} readOnly disabled /></Field> : <ClientSelect clients={clients} value={picked} onChange={setPicked} />}
      <Field label="Three letters"><Input value={prefix} maxLength={3} placeholder="ABC" onChange={(event) => setPrefix(event.target.value.replace(/[^A-Za-z]/g, "").toUpperCase())} /></Field>
      <Field label="Next invoice number"><Input value={start} inputMode="numeric" placeholder="1" onChange={(event) => setStart(event.target.value.replace(/\D/g, ""))} /></Field>
      <Muted>{hint ?? "Pick the letters and the number of the next invoice, e.g. ABC and 150 gives ABC-150. Numbers already issued never change."}</Muted>
    </Modal>
  );
}

/** A payment dated after today on this invoice: it counts from that day. */
function FutureNote({ invoice }: { invoice: Invoice }) {
  if (!invoice.futurePaidMinor) return null;
  return <Pill tone="warn" size="sm">{`Payment dated ${formatShortDate(invoice.nextFuturePaidAt ?? null)}`}</Pill>;
}

/** The invoice list. "+ Draft invoice" is the page header's action; the empty state offers it only when the header does not. */
export function InvoicesTab({ openId, setOpenId, onCreate }: { openId: string | null; setOpenId: (id: string | null) => void; onCreate: () => void }) {
  const { snapshot, scope, clientName } = useBilling();
  const narrow = useIsNarrow();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
  const [search, setSearch] = useState("");
  const [numbering, setNumbering] = useState(false);
  const q = search.trim().toLowerCase();
  const rows = useMemo(() => snapshot.invoices.filter((invoice) => {
    if (q && !`${invoice.number} ${invoice.status} ${invoice.customerName ?? ""}`.toLowerCase().includes(q)) return false;
    if (filter === "draft") return invoice.status === "draft";
    if (filter === "open") return OPEN.has(invoice.status);
    if (filter === "checking") return invoice.status === "payment_pending_verification";
    if (filter === "overdue") return isOverdue(invoice);
    if (filter === "paid") return invoice.status === "paid";
    return true;
  }), [snapshot.invoices, q, filter]);
  const countOf = (id: (typeof FILTERS)[number]["id"]) => snapshot.invoices.filter((invoice) => {
    if (id === "draft") return invoice.status === "draft";
    if (id === "open") return OPEN.has(invoice.status);
    if (id === "checking") return invoice.status === "payment_pending_verification";
    if (id === "overdue") return isOverdue(invoice);
    if (id === "paid") return invoice.status === "paid";
    return true;
  }).length;
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {snapshot.invoices.length > 0 ? <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search invoices…" /> : null}
      <NumberingModal open={numbering} onClose={() => setNumbering(false)} />
      {snapshot.features?.numbering !== "sequential" ? <Row><SmallButton onClick={() => setNumbering(true)}>Set invoice numbering</SmallButton></Row> : null}
      {snapshot.invoices.length > 0 ? <Row>
        {FILTERS.map((f) => (
          <SmallButton key={f.id} variant={filter === f.id ? "primary" : "secondary"} onClick={() => setFilter(f.id)}>
            {f.label}
            {f.id !== "all" && countOf(f.id) > 0 ? <span style={{ marginLeft: 6, fontWeight: 650, color: filter === f.id ? undefined : f.id === "overdue" ? tone("bad").fg : f.id === "checking" ? tone("warn").fg : tokens.muted }}>{countOf(f.id)}</span> : null}
          </SmallButton>
        ))}
      </Row> : null}
      {snapshot.invoices.length === 0 ? (
        <EmptyState icon={Receipt} title={scope ? `No invoices for ${clientName} yet` : "No invoices yet"} description="Draft an invoice, add its lines with VAT codes, then ask for send approval. It is emailed with its PDF from the Mailbox." action={<Button type="button" onClick={onCreate}>+ Draft invoice</Button>} />
      ) : narrow ? (
        <CompactRows
          rows={rows}
          label="Invoices"
          title={(invoice) => (invoice.status === "draft" ? `Draft · ${invoice.customerName ?? invoice.customerRef}` : `${invoice.number} · ${invoice.customerName ?? invoice.customerRef}`)}
          meta={(invoice) => [
            invoice.status === "draft" ? "Not sent yet" : isOverdue(invoice) ? "Overdue" : statusLabel(invoice.status),
            invoice.futurePaidMinor ? `payment dated ${formatShortDate(invoice.nextFuturePaidAt ?? null)}` : null,
            invoice.status !== "draft" && invoice.dueAt ? `due ${fmtDate(invoice.dueAt)}` : null,
          ].filter(Boolean).join(" · ")}
          trailing={(invoice) => <span style={{ color: isOverdue(invoice) ? tone("bad").fg : undefined }}>{money(OPEN.has(invoice.status) ? invoice.outstandingMinor ?? 0 : invoice.totalMinor, invoice.currency)}</span>}
          onOpen={(invoice) => setOpenId(invoice.id)}
          empty="No invoices match."
        />
      ) : (
        <DataTable
          columns={[
            { key: "number", header: "Number", render: (value, row) => <button type="button" onClick={() => setOpenId(String(row.id))} style={{ background: "none", border: 0, padding: 0, color: row.status === "draft" ? tokens.muted : tokens.fg, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{row.status === "draft" ? "Draft" : String(value)}</button> },
            { key: "status", header: "Status", render: (value, row) => <div style={{ display: "grid", gap: 2, justifyItems: "start" }}><Status status={String(value)} /><FutureNote invoice={row as unknown as Invoice} />{row.deliveryStatus === "queued" || row.deliveryStatus === "failed" ? <DeliveryNote status={String(row.deliveryStatus)} error={row.deliveryError as string | null} /> : null}</div> },
            { key: "customer", header: "Customer" },
            { key: "total", header: "Total" },
            { key: "owed", header: "Owed", render: (_value, row) => {
              const invoice = row as unknown as Invoice;
              if (!OPEN.has(invoice.status)) return <span style={{ color: tokens.muted }}>—</span>;
              return <Money minor={invoice.outstandingMinor ?? 0} currency={invoice.currency} kind={isOverdue(invoice) ? "overdue" : null} />;
            } },
            { key: "due", header: "Due", render: (value, row) => <span style={{ color: isOverdue(row as unknown as Invoice) ? tone("bad").fg : undefined, fontWeight: isOverdue(row as unknown as Invoice) ? 600 : undefined }}>{String(value)}</span> },
            { key: "id", header: "", width: "80px", render: (_value, row) => <SmallButton onClick={() => setOpenId(String(row.id))}>Open</SmallButton> },
          ]}
          rows={rows.map((invoice) => ({
            ...invoice,
            customer: invoice.customerName ?? invoice.customerRef,
            total: money(invoice.totalMinor, invoice.currency),
            due: isOverdue(invoice) ? `${fmtDate(invoice.dueAt)} (overdue)` : fmtDate(invoice.dueAt),
          }))}
          emptyMessage="No invoices match."
        />
      )}
      {openId ? <InvoiceDrawer invoiceId={openId} onClose={() => setOpenId(null)} /> : null}
    </div>
  );
}

function emailTimeline(detail: InvoiceDetail): TimelineItem[] {
  const items: TimelineItem[] = detail.deliveries.map((d) => ({
    id: d.key,
    at: d.sentAt ?? d.createdAt,
    title: d.subject,
    detail: d.status === "sent" ? `Sent ${fmtDate(d.sentAt)}` : d.status === "queued" ? (d.error ?? "Queued in the Mailbox") : `Failed: ${d.error ?? "no reason given"}`,
    tone: d.status === "sent" ? "ok" : d.status === "queued" ? "info" : "bad",
    icon: d.status === "sent" ? CircleCheck : d.status === "queued" ? Send : CircleX,
  }));
  for (const r of detail.reminders) {
    items.push({ id: `reminder:${r.stage}`, at: r.createdAt, title: `Reminder ${r.stage}`, detail: `${words(r.status)}${r.error ? ` · ${r.error}` : ""}`, tone: r.status === "failed" ? "bad" : "ok", icon: Mail });
  }
  return items.sort((a, b) => Date.parse(String(b.at ?? 0)) - Date.parse(String(a.at ?? 0)));
}

type Dialog = null | "pay" | "credit" | "pop" | "writeoff" | "cancel" | "apply" | "send" | "refund";

export function InvoiceDrawer({ invoiceId, onClose }: { invoiceId: string; onClose: () => void }) {
  const { call, snapshot, run, say } = useBilling();
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [line, setLine] = useState({ description: "", quantity: "1", unit: "", taxCode: "" });
  const [editing, setEditing] = useState<string | null>(null);
  const [edit, setEdit] = useState({ description: "", quantity: "1", unit: "", taxCode: "" });
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [paidAt, setPaidAt] = useState(today());
  const [reason, setReason] = useState("");
  const [sendTo, setSendTo] = useState("");
  const [credit, setCredit] = useState("");
  const [refundLink, setRefundLink] = useState("");
  const [busy, setBusy] = useState(false);

  async function reload() {
    const next = await call<InvoiceDetail>("billing.invoice-detail", { invoiceId });
    setDetail(next);
  }
  useEffect(() => {
    setDetail(null);
    reload().catch((error: unknown) => say(errorText(error)));
  }, [invoiceId]);

  async function act(work: () => Promise<unknown>, success: string) {
    setBusy(true);
    const ok = await run(async () => {
      await work();
      await reload();
    }, success);
    setBusy(false);
    if (ok) setDialog(null);
    return ok;
  }

  if (!detail) return <Drawer open title="Invoice" onClose={onClose}><Muted>Loading…</Muted></Drawer>;
  const inv = detail.invoice;
  const draft = inv.status === "draft";
  const editable = draft && !detail.readOnly && inv.deliveryStatus !== "queued";
  const open = OPEN.has(inv.status);
  const codes = snapshot.taxCodes;
  const cur = inv.currency;

  const pdf = async (download: boolean) => {
    const result = await call<{ base64: string; filename: string; sentCopyUrl: string | null }>("billing.document-pdf", { kind: "invoice", id: inv.id });
    openBase64Pdf(result.base64, result.filename, download);
  };

  const actions = (
    <>
      <SmallButton onClick={() => void pdf(false).catch((e: unknown) => say(errorText(e)))}>Preview PDF</SmallButton>
      <SmallButton onClick={() => void pdf(true).catch((e: unknown) => say(errorText(e)))}>Download PDF</SmallButton>
      {inv.deliveryStatus === "sent" ? <SmallButton onClick={() => void call<{ sentCopyUrl: string | null }>("billing.document-pdf", { kind: "invoice", id: inv.id }).then((r) => {
        if (!r.sentCopyUrl) throw new Error("No stored copy of the emailed PDF (private storage was not set up when it was sent).");
        openUrl(r.sentCopyUrl);
      }).catch((e: unknown) => say(errorText(e)))}>Emailed PDF</SmallButton> : null}
      {draft && !detail.readOnly && !inv.pendingAction && inv.deliveryStatus !== "queued" ? <SmallButton variant="primary" disabled={busy || inv.totalMinor <= 0} onClick={() => { setSendTo(detail.recipients.map((r) => r.email).join(", ")); setDialog("send"); }}>Request send</SmallButton> : null}
      {draft && !detail.readOnly && inv.deliveryStatus !== "queued" ? <SmallButton disabled={busy || inv.totalMinor <= 0} onClick={() => void act(() => call("billing.mark-sent", { invoiceId: inv.id }), "Marked sent. It is now in the books.")}>Mark sent (no email)</SmallButton> : null}
      {inv.deliveryStatus === "failed" ? <SmallButton onClick={() => void act(() => call("billing.retry-send", { kind: "invoice", id: inv.id }), "Email queued again")}>Retry email</SmallButton> : null}
      {!draft && inv.status !== "cancelled" && inv.deliveryStatus !== "queued" && inv.deliveryStatus !== "failed" ? <SmallButton onClick={() => void act(() => call("billing.retry-send", { kind: "invoice", id: inv.id }), "Email queued")}>Email again</SmallButton> : null}
      {open ? <SmallButton onClick={() => { setAmount(minorToInput(inv.outstandingMinor)); setReference(inv.number); setDialog("pay"); }}>Record payment</SmallButton> : null}
      {open && snapshot.features?.r2 ? <SmallButton onClick={() => { setAmount(minorToInput(inv.outstandingMinor)); setDialog("pop"); }}>Upload proof of payment</SmallButton> : null}
      {open && !inv.pendingAction ? <SmallButton onClick={() => void act(() => call("billing.request-pay", { invoiceId: inv.id }), "Payment approval issue opened")}>Request pay approval</SmallButton> : null}
      {!draft && inv.status !== "cancelled" ? <SmallButton onClick={() => { setAmount(""); setReason(""); setDialog("credit"); }}>Credit note</SmallButton> : null}
      {open && detail.customerCredit.length > 0 ? <SmallButton onClick={() => { setCredit(detail.customerCredit[0] ? `${detail.customerCredit[0].sourceKind}:${detail.customerCredit[0].sourceId}` : ""); setDialog("apply"); }}>Use customer credit</SmallButton> : null}
      {open ? <SmallButton onClick={() => { setReason(""); setDialog("writeoff"); }}>Write off</SmallButton> : null}
      {inv.status !== "cancelled" && (inv.paidMinor ?? 0) === 0 && (inv.creditedMinor ?? 0) === 0 && !detail.readOnly ? <SmallButton onClick={() => { setReason(""); setDialog("cancel"); }}>Cancel invoice</SmallButton> : null}
    </>
  );

  const totalRows = [
    { label: "Subtotal (excl. VAT)", value: money(inv.subtotalMinor, cur) },
    ...detail.groups.filter((g) => g.vatMinor > 0 || !detail.legacyVat).map((g) => ({ label: g.rateBp > 0 ? `VAT ${g.rateBp / 100}%${g.taxCode ? "" : ""}` : `${taxShort(g.taxCode, codes)} (0%)`, value: money(g.vatMinor, cur) })),
    { label: "Total", value: money(inv.totalMinor, cur), strong: true },
    ...(inv.paidMinor ? [{ label: "Paid", value: `− ${money(inv.paidMinor, cur)}` }] : []),
    ...(inv.creditedMinor ? [{ label: "Credited", value: `− ${money(inv.creditedMinor, cur)}` }] : []),
    ...(inv.writtenOffMinor ? [{ label: "Written off", value: `− ${money(inv.writtenOffMinor, cur)}` }] : []),
    ...(!draft ? [{ label: "Still owed", value: money(inv.outstandingMinor, cur), strong: true }] : []),
  ];

  return (
    <Drawer
      open
      title={draft ? `Draft invoice for ${inv.customerName ?? inv.customerRef}` : `Invoice ${inv.number}`}
      subtitle={<><Status status={inv.status} /><span>{inv.customerName ?? inv.customerRef}</span><span>· Due {fmtDate(inv.dueAt)}</span>{inv.pendingAction ? <span>· Waiting on the {inv.pendingAction} approval issue</span> : null}<DeliveryNote status={inv.deliveryStatus} error={inv.deliveryError} /></>}
      onClose={onClose}
      actions={actions}
    >
      {detail.readOnly ? <Muted>Shared with you by a partner. Read only.</Muted> : null}
      {inv.futurePaidMinor ? (
        <Card title="A payment is dated in the future" tone="warn" strip>
          <Muted style={{ color: tokens.fg }}>{money(inv.futurePaidMinor, cur)} is dated {formatShortDate(inv.nextFuturePaidAt ?? null)}, after today. It counts from that day, so until then this invoice shows as {inv.outstandingMinor ? `owing ${money(inv.outstandingMinor, cur)}` : "open"}. Check the date against the bank statement.</Muted>
        </Card>
      ) : null}
      {inv.ledgerStatus === "rejected" ? (
        <Card title="Books">
          <Muted style={{ color: tokens.destructive }}>Accounting refused this invoice's journal: {inv.ledgerError ?? "no reason given"}.</Muted>
          <Row><SmallButton onClick={() => void act(() => call("billing.retry-ledger", { key: detail.ledgerKey }), "Journal sent again")}>Post again</SmallButton></Row>
        </Card>
      ) : null}

      <Card title="Lines">
        {detail.lines.length === 0 ? <Muted>No lines yet.</Muted> : (
          <div style={{ display: "grid", gap: 6 }}>
            {detail.lines.map((l) => editing === l.id ? (
              <ResponsiveGrid key={l.id} columns="3fr 70px 120px 150px auto" narrowColumns={2} spanFirst gap={6} alignItems="end">
                <Field label="Description"><Input value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
                <Field label="Qty"><Input value={edit.quantity} onChange={(e) => setEdit({ ...edit, quantity: e.target.value })} /></Field>
                <Field label={inv.pricesIncludeVat ? "Unit (incl.)" : "Unit (excl.)"}><Input value={edit.unit} onChange={(e) => setEdit({ ...edit, unit: e.target.value })} /></Field>
                <TaxCodeSelect value={edit.taxCode} onChange={(taxCode) => setEdit({ ...edit, taxCode })} allowDefault={detail.legacyVat ? `Invoice rate (${inv.taxRate ?? 0}%)` : undefined} />
                <Row>
                  <SmallButton variant="primary" onClick={() => void act(() => call("billing.update-line", { invoiceId: inv.id, lineId: l.id, description: edit.description, quantity: Number(edit.quantity), unitAmountMinor: toMinor(edit.unit), taxCode: edit.taxCode || null }).then(() => setEditing(null)), "Line changed")}>Save</SmallButton>
                  <SmallButton onClick={() => setEditing(null)}>Cancel</SmallButton>
                </Row>
              </ResponsiveGrid>
            ) : (
              <div key={l.id} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, padding: "8px 10px", borderRadius: 8, background: tokens.secondary, fontSize: 13 }}>
                <div style={{ display: "grid", gap: 2 }}>
                  <span>{l.description}</span>
                  <span style={{ fontSize: 12, color: tokens.muted }}>{l.quantity} × {money(l.unitAmountMinor, cur)} · {taxShort(l.taxCode, codes)}{l.fromTime ? " · from time" : ""}</span>
                </div>
                <div style={{ display: "grid", gap: 4, justifyItems: "end" }}>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>{money(inv.pricesIncludeVat ? l.grossMinor : l.netMinor, cur)}</span>
                  {editable ? <Row style={{ gap: 4 }}>
                    <SmallButton onClick={() => { setEditing(l.id); setEdit({ description: l.description, quantity: String(l.quantity), unit: minorToInput(l.unitAmountMinor), taxCode: l.taxCode ?? "" }); }}>Edit</SmallButton>
                    <SmallButton onClick={() => void act(() => call("billing.remove-line", { invoiceId: inv.id, lineId: l.id }), "Line removed")}>Remove</SmallButton>
                  </Row> : null}
                </div>
              </div>
            ))}
          </div>
        )}
        {editable ? (
          <ResponsiveGrid columns="3fr 70px 120px 150px auto" narrowColumns={2} spanFirst gap={6} alignItems="end">
            <Field label="Description"><Input value={line.description} onChange={(e) => setLine({ ...line, description: e.target.value })} placeholder="What was done" /></Field>
            <Field label="Qty"><Input value={line.quantity} onChange={(e) => setLine({ ...line, quantity: e.target.value })} /></Field>
            <Field label={inv.pricesIncludeVat ? "Unit (incl.)" : "Unit (excl.)"}><Input value={line.unit} onChange={(e) => setLine({ ...line, unit: e.target.value })} placeholder="0.00" /></Field>
            <TaxCodeSelect value={line.taxCode} onChange={(taxCode) => setLine({ ...line, taxCode })} allowDefault={detail.legacyVat && detail.lines.length > 0 ? `Invoice rate (${inv.taxRate ?? 0}%)` : `Default (${taxShort(inv.defaultTaxCode ?? null, codes)})`} />
            <SmallButton variant="primary" style={{ height: 36 }} disabled={busy} onClick={() => void act(async () => {
              await call("billing.add-line", { invoiceId: inv.id, description: line.description, quantity: Number(line.quantity || "1"), unitAmountMinor: toMinor(line.unit), ...(line.taxCode ? { taxCode: line.taxCode } : {}) });
              setLine({ description: "", quantity: "1", unit: "", taxCode: line.taxCode });
            }, "Line added")}>Add</SmallButton>
          </ResponsiveGrid>
        ) : null}
        <Totals rows={totalRows} />
      </Card>

      {editable ? (
        <Card title="Details">
          <InvoiceDetailsForm detail={detail} onSave={(patch) => act(() => call("billing.update-invoice", { invoiceId: inv.id, ...patch }), "Invoice saved")} />
        </Card>
      ) : inv.notes ? <Card title="Notes"><Muted style={{ whiteSpace: "pre-wrap", color: tokens.fg }}>{inv.notes}</Muted></Card> : null}

      {detail.pops.length > 0 ? (
        <Card title="Proof of payment">
          {detail.pops.map((pop) => (
            <Row key={pop.id} style={{ justifyContent: "space-between" }}>
              <span style={{ fontSize: 13 }}>{pop.source === "email" ? `Email from ${pop.fromEmail ?? "?"}` : "Upload"} · {fmtDate(pop.receivedAt)}{pop.amountMinor ? ` · says ${money(pop.amountMinor, cur)}` : ""}</span>
              <Row style={{ gap: 4 }}>
                <Status status={pop.status} />
                {pop.hasFile ? <SmallButton onClick={() => void call<{ url: string }>("billing.pop-file", { popId: pop.id }).then((r) => openUrl(r.url)).catch((e: unknown) => say(errorText(e)))}>View</SmallButton> : null}
                {pop.status === "pending" ? <>
                  <SmallButton variant="primary" onClick={() => void act(() => call("billing.confirm-pop", { popId: pop.id }), "Payment confirmed")}>Money is in</SmallButton>
                  <SmallButton onClick={() => void act(() => call("billing.reject-pop", { popId: pop.id, reason: "Not in the bank" }), "Proof of payment rejected")}>Reject</SmallButton>
                </> : null}
              </Row>
            </Row>
          ))}
        </Card>
      ) : null}

      {detail.payments.length > 0 || detail.credits.length > 0 ? (
        <Card title="Payments and credit">
          {detail.payments.map((p) => (
            <Row key={p.id} style={{ justifyContent: "space-between", fontSize: 13 }}>
              <span>{fmtDate(p.paidAt)} · {words(p.source)}{p.reference ? ` · ${p.reference}` : ""}{p.bankTxId ? " · matched to the bank" : ""}{p.paidAt && p.paidAt.slice(0, 10) > (snapshot.asOf ?? today()) ? <span style={{ color: tone("warn").fg, fontWeight: 600 }}> · dated after today</span> : null}</span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}><Money minor={p.amountMinor} currency={cur} kind="in" />{p.creditMinor > 0 ? ` (${money(p.creditMinor, cur)} to credit)` : ""}{p.journalNumber ? ` · ${p.journalNumber}` : ""}</span>
            </Row>
          ))}
          {detail.credits.map((c) => (
            <Row key={c.id} style={{ justifyContent: "space-between", fontSize: 13 }}>
              <span>{fmtDate(c.createdAt)} · {c.sourceKind === "credit_note" ? "Credit note" : c.sourceKind === "payment" ? "Customer credit" : "Written off"}</span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>{money(c.amountMinor, cur)}</span>
            </Row>
          ))}
        </Card>
      ) : null}

      <OnlinePayment detail={detail} cur={cur} busy={busy} act={act} onRefund={(linkId) => { setRefundLink(linkId); setAmount(""); setReason(""); setDialog("refund"); }} />

      {detail.creditNotes.length > 0 ? (
        <Card title="Credit notes">
          {detail.creditNotes.map((n) => (
            <Row key={n.id} style={{ justifyContent: "space-between", fontSize: 13 }}>
              <span>{n.number ?? "Credit note"} · {money(n.amountMinor, cur)}{n.reason ? ` · ${n.reason}` : ""}</span>
              <Row style={{ gap: 4 }}>
                <Status status={n.status} />
                <SmallButton onClick={() => void call<{ base64: string; filename: string }>("billing.credit-note-pdf", { creditNoteId: n.id }).then((r) => openBase64Pdf(r.base64, r.filename)).catch((e: unknown) => say(errorText(e)))}>PDF</SmallButton>
                {snapshot.features?.email ? <SmallButton onClick={() => void act(() => call("billing.send-credit-note", { creditNoteId: n.id }), "Credit note queued in the Mailbox")}>Email</SmallButton> : null}
              </Row>
            </Row>
          ))}
        </Card>
      ) : null}

      {detail.deliveries.length > 0 || detail.reminders.length > 0 ? (
        <Card title="Emails" icon={Mail} tone={detail.deliveries.some((d) => d.status === "failed") ? "bad" : undefined}>
          <Timeline dense items={emailTimeline(detail)} />
        </Card>
      ) : null}

      {inv.ledgerStatus && inv.ledgerStatus !== "rejected" ? <Muted>Books: {inv.ledgerStatus === "posted" ? `posted${inv.journalNumber ? ` as ${inv.journalNumber}` : ""}` : "waiting for Accounting"}</Muted> : null}

      <Modal open={dialog === "send"} title={draft ? `Send the invoice to ${inv.customerName ?? inv.customerRef}` : `Send ${inv.number}`} description="A person approves on a Paperclip issue. When it is done, the invoice is emailed with its PDF from the Mailbox." onClose={() => setDialog(null)} footer={<>
        <Button type="button" variant="secondary" onClick={() => setDialog(null)}>Cancel</Button>
        <Button type="button" disabled={busy} onClick={() => void act(() => call("billing.request-send", { invoiceId: inv.id, sendTo }), "Send approval issue opened")}>Ask for approval</Button>
      </>}>
        <Field label="Send to (comma-separated)"><Input value={sendTo} onChange={(e) => setSendTo(e.target.value)} placeholder="accounts@client.co.za" /></Field>
        {!snapshot.features?.email ? <Muted>Email is off in Billing settings: the invoice is marked sent when the issue is done.</Muted> : null}
        {!snapshot.features?.r2 ? <Muted>No private storage is set up, so the email carries the invoice details without a PDF.</Muted> : null}
      </Modal>

      <Modal open={dialog === "pay"} title="Record payment" description="Money already in the bank. A part payment leaves the invoice part paid; more than is owed becomes the customer's credit." onClose={() => setDialog(null)} footer={<>
        <Button type="button" variant="secondary" onClick={() => setDialog(null)}>Cancel</Button>
        <Button type="button" disabled={busy} onClick={() => void act(() => call("billing.record-payment", { invoiceId: inv.id, amountMinor: toMinor(amount), reference, paidAt, method: "eft" }), "Payment recorded")}>Record</Button>
      </>}>
        <Field label={`Amount (${cur})`}><Input value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Date paid"><Input type="date" value={paidAt} max={today()} onChange={(e) => setPaidAt(e.target.value)} /></Field>
        <Field label="Reference"><Input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
      </Modal>

      <Modal open={dialog === "pop"} title="Upload proof of payment" description="The invoice waits for a person to check the bank; nothing is recorded until then." onClose={() => setDialog(null)} footer={<Button type="button" variant="secondary" onClick={() => setDialog(null)}>Close</Button>}>
        <Field label={`Amount the customer says they paid (${cur})`}><Input value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <FilePicker label="Choose PDF or image" disabled={busy} onFile={(file) => void act(async () => {
          const up = await uploadFile(call, "pop", file);
          await call("billing.register-pop", { invoiceId: inv.id, key: up.key, fileName: up.fileName, mime: up.mime, ...(amount ? { amountMinor: toMinor(amount) } : {}) });
        }, "Proof of payment uploaded. A check issue was opened.")} />
      </Modal>

      <Modal open={dialog === "credit"} title="Credit note" description="Applied to what this invoice still owes; anything above stays with the customer as credit." onClose={() => setDialog(null)} footer={<>
        <Button type="button" variant="secondary" onClick={() => setDialog(null)}>Cancel</Button>
        <Button type="button" disabled={busy} onClick={() => void act(() => call("billing.create-credit-note", { invoiceId: inv.id, amountMinor: toMinor(amount), reason }), "Credit note issued")}>Issue credit note</Button>
      </>}>
        <Field label={`Amount incl. VAT (${cur})`}><Input value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Modal>

      <Modal open={dialog === "apply"} title="Use customer credit" onClose={() => setDialog(null)} footer={<>
        <Button type="button" variant="secondary" onClick={() => setDialog(null)}>Cancel</Button>
        <Button type="button" disabled={busy || !credit} onClick={() => void act(() => {
          const [sourceKind, sourceId] = [credit.slice(0, credit.indexOf(":")), credit.slice(credit.indexOf(":") + 1)];
          return call("billing.apply-credit", { invoiceId: inv.id, sourceKind, sourceId });
        }, "Credit applied")}>Apply</Button>
      </>}>
        <Field label="Credit">
          <Select value={credit} onChange={(e) => setCredit(e.target.value)}>
            {detail.customerCredit.map((c) => <option key={`${c.sourceKind}:${c.sourceId}`} value={`${c.sourceKind}:${c.sourceId}`}>{c.label} · {money(c.availableMinor, c.currency)} left</option>)}
          </Select>
        </Field>
      </Modal>

      <Modal open={dialog === "refund"} title="Record a refund" description="Money you paid back to the customer through the provider (Stripe's own refunds are recorded by themselves). The payment is reversed, the invoice owes it again and the books are updated." onClose={() => setDialog(null)} footer={<>
        <Button type="button" variant="secondary" onClick={() => setDialog(null)}>Cancel</Button>
        <Button type="button" disabled={busy || !toMinor(amount)} onClick={() => void act(() => call("billing.record-refund", { invoiceId: inv.id, provider: (detail.paymentLinks ?? []).find((l) => l.id === refundLink)?.provider, amountMinor: toMinor(amount), reason }), "Refund recorded")}>Record refund</Button>
      </>}>
        <Field label={`Amount refunded (${cur})`}><Input value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Modal>

      <Modal open={dialog === "writeoff"} title={`Write off ${money(inv.outstandingMinor, cur)}?`} description="Books what is still owed as a bad debt. Do this only when the customer will not pay." onClose={() => setDialog(null)} footer={<>
        <Button type="button" variant="secondary" onClick={() => setDialog(null)}>Cancel</Button>
        <Button type="button" disabled={busy} onClick={() => void act(() => call("billing.write-off", { invoiceId: inv.id, reason }), "Written off")}>Write off</Button>
      </>}>
        <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Modal>

      <Modal open={dialog === "cancel"} title={draft ? "Cancel this draft?" : `Cancel ${inv.number}?`} description={draft ? "The draft is kept as cancelled; its number is not reused." : "The invoice is voided and its journal reversed."} onClose={() => setDialog(null)} footer={<>
        <Button type="button" variant="secondary" onClick={() => setDialog(null)}>Keep it</Button>
        <Button type="button" disabled={busy} onClick={() => void act(() => call("billing.cancel-invoice", { invoiceId: inv.id, reason }), "Invoice cancelled")}>Cancel invoice</Button>
      </>}>
        <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Modal>
    </Drawer>
  );
}

const LINK_TONE: Record<PaymentLink["status"], "ok" | "info" | "warn" | "bad" | "neutral"> = { active: "info", paid: "ok", cancelled: "neutral", needs_attention: "warn", failed: "bad" };
const LINK_LABEL: Record<PaymentLink["status"], string> = { active: "Waiting to be paid", paid: "Paid", cancelled: "Withdrawn", needs_attention: "Needs a person", failed: "Could not be made" };

/** Online payment: the links, what was paid and refunded through them, and what a person can do. Nothing here moves money by itself. */
function OnlinePayment({ detail, cur, busy, act, onRefund }: { detail: InvoiceDetail; cur: string; busy: boolean; act: (work: () => Promise<unknown>, success: string) => Promise<boolean>; onRefund: (linkId: string) => void }) {
  const { call, snapshot, say } = useBilling();
  const links = detail.paymentLinks ?? [];
  const providers = snapshot.payments?.providers ?? [];
  const on = providers.filter((p) => p.enabled && p.key !== "mock");
  const inv = detail.invoice;
  const open = OPEN.has(inv.status);
  const refunds = detail.refunds ?? [];
  if (links.length === 0 && on.length === 0 && refunds.length === 0) return null;
  const copy = (url: string) => void navigator.clipboard?.writeText(url).then(() => say("Link copied")).catch(() => say(url));
  return (
    <Card title="Online payment" subtitle="A pay-online link goes in the invoice and reminder emails while a provider is on. The invoice is paid only when the provider confirms the money; EFT stays the default.">
      {links.length === 0 ? <Muted>No payment link yet. One is made when the invoice is sent{open ? ", or make one now." : "."}</Muted> : null}
      {links.map((link) => (
        <Row key={link.id} style={{ justifyContent: "space-between", fontSize: 13, gap: 8 }}>
          <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
            <strong>{link.label}</strong> · {money(link.amountMinor, link.currency)} · <Pill tone={LINK_TONE[link.status]} dot size="sm">{LINK_LABEL[link.status]}</Pill>
            {link.refundedMinor > 0 ? ` · ${money(link.refundedMinor, link.currency)} refunded` : ""}
            {link.feeMinor ? ` · fee ${money(link.feeMinor, link.currency)}` : link.status === "paid" && link.provider === "stripe" ? " · Stripe's fee is not in its notification: the Bookkeeper books it from the payout" : ""}
            {link.lastError ? <span style={{ color: tone("warn").fg }}> · {link.lastError}</span> : null}
          </span>
          <Row style={{ gap: 4 }}>
            {link.url ? <SmallButton onClick={() => copy(link.url!)}>Copy link</SmallButton> : null}
            {link.status === "active" ? <SmallButton disabled={busy} onClick={() => void act(() => call("billing.cancel-payment-link", { linkId: link.id }), "Payment link withdrawn")}>Withdraw</SmallButton> : null}
            {link.status === "paid" && link.amountMinor > link.refundedMinor ? <SmallButton disabled={busy} onClick={() => onRefund(link.id)}>Record refund</SmallButton> : null}
          </Row>
        </Row>
      ))}
      {refunds.map((r) => (
        <Row key={r.id} style={{ justifyContent: "space-between", fontSize: 13 }}>
          <span>{fmtDate(r.createdAt)} · Refund through {words(r.provider)}{r.reason ? ` · ${r.reason}` : ""}</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>− {money(r.amountMinor, cur)}</span>
        </Row>
      ))}
      {open && on.length > 0 && !links.some((l) => l.status === "active") ? (
        <Row><SmallButton variant="primary" disabled={busy} onClick={() => void act(() => call("billing.create-payment-link", { invoiceId: inv.id }), "Payment link made")}>Make a payment link</SmallButton></Row>
      ) : null}
    </Card>
  );
}

function InvoiceDetailsForm({ detail, onSave }: { detail: InvoiceDetail; onSave: (patch: Record<string, unknown>) => Promise<boolean> }) {
  const inv = detail.invoice;
  const [dueAt, setDueAt] = useState(dayInput(inv.dueAt));
  const [notes, setNotes] = useState(inv.notes ?? "");
  const [sendTo, setSendTo] = useState((inv.sendTo ?? []).map((a) => a.email).join(", "));
  const [inclusive, setInclusive] = useState(Boolean(inv.pricesIncludeVat));
  const [defaultCode, setDefaultCode] = useState(inv.defaultTaxCode ?? "");
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "grid", gridTemplateColumns: fluidColumns(180), gap: 10 }}>
        <Field label="Due date"><Input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} /></Field>
        <Field label="Prices">
          <Select value={inclusive ? "incl" : "excl"} onChange={(e) => setInclusive(e.target.value === "incl")}>
            <option value="excl">Exclude VAT</option>
            <option value="incl">Include VAT</option>
          </Select>
        </Field>
        <TaxCodeSelect label="VAT for new lines" value={defaultCode} onChange={setDefaultCode} allowDefault={`Invoice rate (${inv.taxRate ?? 0}%)`} />
      </div>
      <Field label={`Email to (empty = ${detail.recipients.map((r) => r.email).join(", ") || "no address found"})`}><Input value={sendTo} onChange={(e) => setSendTo(e.target.value)} placeholder="accounts@client.co.za" /></Field>
      <Field label="Notes on the invoice"><TextArea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <Row><SmallButton variant="primary" onClick={() => void onSave({ dueAt: dueAt || null, notes, sendTo, pricesIncludeVat: inclusive, defaultTaxCode: defaultCode || null })}>Save details</SmallButton></Row>
    </div>
  );
}
