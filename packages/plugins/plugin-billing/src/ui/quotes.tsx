import { useEffect, useMemo, useState } from "react";
import { DataTable } from "@paperclipai/plugin-sdk/ui";
import { Button, EmptyState, Field, Input, ResponsiveGrid, Toolbar, errorText, tokens } from "@partnersinbiz/pib-plugin-ui";
import { NewDocumentModal } from "./invoices.js";
import { Card, DeliveryNote, Drawer, Muted, Row, SmallButton, Status, TaxCodeSelect, Totals, dayInput, fmtDate, money, openBase64Pdf, taxShort, toMinor, useBilling } from "./parts.js";
import type { QuoteDetail } from "./types.js";

export function QuotesTab({ onOpenInvoice }: { onOpenInvoice: (id: string) => void }) {
  const { snapshot, scope, clientName } = useBilling();
  const quotes = snapshot.quotes ?? [];
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const q = search.trim().toLowerCase();
  const rows = useMemo(() => quotes.filter((quote) => !q || `${quote.number} ${quote.status} ${quote.customerName ?? ""}`.toLowerCase().includes(q)), [quotes, q]);
  const newButton = <Button type="button" onClick={() => setCreating(true)}>+ Draft quote</Button>;
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search quotes…">{newButton}</Toolbar>
      {quotes.length === 0 ? (
        <EmptyState title={scope ? `No quotes for ${clientName} yet` : "No quotes yet"} description="Draft a quote, send it for approval, then convert it to an invoice when the customer accepts." action={newButton} />
      ) : (
        <DataTable
          columns={[
            { key: "number", header: "Number" },
            { key: "status", header: "Status", render: (value) => <Status status={String(value)} /> },
            { key: "customer", header: "Customer" },
            { key: "total", header: "Total" },
            { key: "valid", header: "Valid until" },
            { key: "id", header: "", width: "80px", render: (_value, row) => <SmallButton onClick={() => setOpenId(String(row.id))}>Open</SmallButton> },
          ]}
          rows={rows.map((quote) => ({ ...quote, customer: quote.customerName ?? quote.customerRef, total: money(quote.totalMinor, quote.currency), valid: fmtDate(quote.validUntil) }))}
          emptyMessage="No quotes match."
        />
      )}
      <NewDocumentModal kind="quote" open={creating} onClose={() => setCreating(false)} onCreated={(id) => setOpenId(id)} />
      {openId ? <QuoteDrawer quoteId={openId} onClose={() => setOpenId(null)} onOpenInvoice={(id) => { setOpenId(null); onOpenInvoice(id); }} /> : null}
    </div>
  );
}

function QuoteDrawer({ quoteId, onClose, onOpenInvoice }: { quoteId: string; onClose: () => void; onOpenInvoice: (id: string) => void }) {
  const { call, snapshot, run, say } = useBilling();
  const [detail, setDetail] = useState<QuoteDetail | null>(null);
  const [line, setLine] = useState({ description: "", quantity: "1", unit: "", taxCode: "" });
  const [validUntil, setValidUntil] = useState("");
  const [busy, setBusy] = useState(false);

  async function reload() {
    const next = await call<QuoteDetail>("billing.quote-detail", { quoteId });
    setDetail(next);
    setValidUntil(dayInput(next.quote.validUntil));
  }
  useEffect(() => {
    reload().catch((error: unknown) => say(errorText(error)));
  }, [quoteId]);

  async function act(work: () => Promise<unknown>, success: string) {
    setBusy(true);
    await run(async () => {
      await work();
      await reload();
    }, success);
    setBusy(false);
  }

  if (!detail) return <Drawer open title="Quote" onClose={onClose}><Muted>Loading…</Muted></Drawer>;
  const qt = detail.quote;
  const draft = qt.status === "draft";
  const editable = draft && qt.deliveryStatus !== "queued";
  const cur = qt.currency;
  const codes = snapshot.taxCodes;
  return (
    <Drawer
      open
      title={`Quote ${qt.number}`}
      subtitle={<><Status status={qt.status} /><span>{qt.customerName ?? qt.customerRef}</span><span>· Valid until {fmtDate(qt.validUntil)}</span>{qt.pendingAction ? <span>· Waiting on the send approval issue</span> : null}<DeliveryNote status={qt.deliveryStatus} error={qt.deliveryError} /></>}
      onClose={onClose}
      actions={<>
        <SmallButton onClick={() => void call<{ base64: string; filename: string }>("billing.document-pdf", { kind: "quote", id: qt.id }).then((r) => openBase64Pdf(r.base64, r.filename)).catch((e: unknown) => say(errorText(e)))}>Preview PDF</SmallButton>
        {(draft || qt.status === "sent") && !qt.pendingAction && qt.deliveryStatus !== "queued" ? <SmallButton variant="primary" disabled={busy || qt.totalMinor <= 0} onClick={() => void act(() => call("billing.request-quote-send", { quoteId: qt.id }), "Send approval issue opened")}>Request send</SmallButton> : null}
        {qt.deliveryStatus === "failed" ? <SmallButton onClick={() => void act(() => call("billing.retry-send", { kind: "quote", id: qt.id }), "Email queued again")}>Retry email</SmallButton> : null}
        {["draft", "sent", "expired", "declined"].includes(qt.status) ? <SmallButton onClick={() => void act(() => call("billing.set-quote-status", { quoteId: qt.id, status: "accepted" }), "Marked accepted")}>Accepted</SmallButton> : null}
        {["draft", "sent", "accepted"].includes(qt.status) ? <SmallButton onClick={() => void act(() => call("billing.set-quote-status", { quoteId: qt.id, status: "declined" }), "Marked declined")}>Declined</SmallButton> : null}
        {qt.status === "accepted" ? <SmallButton variant="primary" onClick={() => void run(async () => {
          const result = await call<{ invoice: { id: string } }>("billing.convert-quote", { quoteId: qt.id });
          onOpenInvoice(result.invoice.id);
        }, "Converted to a draft invoice")}>Convert to invoice</SmallButton> : null}
        {qt.convertedInvoiceId ? <SmallButton onClick={() => onOpenInvoice(qt.convertedInvoiceId!)}>Open invoice</SmallButton> : null}
      </>}
    >
      <Card title="Lines">
        {detail.lines.length === 0 ? <Muted>No lines yet.</Muted> : detail.lines.map((l) => (
          <div key={l.id} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, padding: "8px 10px", borderRadius: 8, background: tokens.secondary, fontSize: 13 }}>
            <div style={{ display: "grid", gap: 2 }}>
              <span>{l.description}</span>
              <span style={{ fontSize: 12, color: tokens.muted }}>{l.quantity} × {money(l.unitAmountMinor, cur)} · {taxShort(l.taxCode, codes)}</span>
            </div>
            <div style={{ display: "grid", gap: 4, justifyItems: "end" }}>
              <span>{money(qt.pricesIncludeVat ? l.grossMinor : l.netMinor, cur)}</span>
              {editable ? <SmallButton onClick={() => void act(() => call("billing.remove-quote-line", { quoteId: qt.id, lineId: l.id }), "Line removed")}>Remove</SmallButton> : null}
            </div>
          </div>
        ))}
        {editable ? (
          <ResponsiveGrid columns="3fr 70px 120px 150px auto" narrowColumns={2} spanFirst gap={6} alignItems="end">
            <Field label="Description"><Input value={line.description} onChange={(e) => setLine({ ...line, description: e.target.value })} /></Field>
            <Field label="Qty"><Input value={line.quantity} onChange={(e) => setLine({ ...line, quantity: e.target.value })} /></Field>
            <Field label={qt.pricesIncludeVat ? "Unit (incl.)" : "Unit (excl.)"}><Input value={line.unit} onChange={(e) => setLine({ ...line, unit: e.target.value })} placeholder="0.00" /></Field>
            <TaxCodeSelect value={line.taxCode} onChange={(taxCode) => setLine({ ...line, taxCode })} allowDefault={`Default (${taxShort(qt.defaultTaxCode ?? null, codes)})`} />
            <SmallButton variant="primary" style={{ height: 36 }} disabled={busy} onClick={() => void act(async () => {
              await call("billing.add-quote-line", { quoteId: qt.id, description: line.description, quantity: Number(line.quantity || "1"), unitAmountMinor: toMinor(line.unit), ...(line.taxCode ? { taxCode: line.taxCode } : {}) });
              setLine({ description: "", quantity: "1", unit: "", taxCode: line.taxCode });
            }, "Line added")}>Add</SmallButton>
          </ResponsiveGrid>
        ) : null}
        <Totals rows={[
          { label: "Subtotal (excl. VAT)", value: money(qt.subtotalMinor, cur) },
          { label: "VAT", value: money(qt.vatMinor, cur) },
          { label: "Total", value: money(qt.totalMinor, cur), strong: true },
        ]} />
      </Card>
      {editable ? (
        <Card title="Details">
          <Row style={{ alignItems: "end" }}>
            <Field label="Valid until"><Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} /></Field>
            <SmallButton variant="primary" style={{ height: 36 }} onClick={() => void act(() => call("billing.update-quote", { quoteId: qt.id, validUntil: validUntil || null }), "Quote saved")}>Save</SmallButton>
          </Row>
        </Card>
      ) : null}
      {detail.deliveries.length > 0 ? (
        <Card title="Emails">
          {detail.deliveries.map((d) => <Muted key={d.key}>{d.subject} · {d.status === "sent" ? `sent ${fmtDate(d.sentAt)}` : d.status === "failed" ? `failed: ${d.error ?? ""}` : "queued"}</Muted>)}
        </Card>
      ) : null}
      <Muted>Email goes to {detail.recipients.map((r) => r.email).join(", ") || "nobody yet: no email address was found for this customer"}.</Muted>
    </Drawer>
  );
}
