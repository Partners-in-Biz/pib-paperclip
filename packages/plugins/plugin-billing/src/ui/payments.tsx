import { useState } from "react";
import { DataTable } from "@paperclipai/plugin-sdk/ui";
import { Button, EmptyState, Field, Input, Modal, Select, errorText } from "@partnersinbiz/pib-plugin-ui";
import { Card, Muted, Row, SmallButton, Status, fmtDate, minorToInput, money, openBase64Pdf, openUrl, today, toMinor, useBilling, words } from "./parts.js";
import type { Pop } from "./types.js";

const BASIS: Record<string, string> = {
  number: "invoice number",
  thread: "reply to our invoice",
  sender: "sender's only open invoice",
  upload: "uploaded",
  manual: "picked by a person",
  none: "not matched",
};

export function PaymentsTab({ onOpenInvoice }: { onOpenInvoice: (id: string) => void }) {
  const { snapshot, call, run, say, scope } = useBilling();
  const pops = snapshot.pops ?? [];
  const pending = pops.filter((p) => p.status === "pending");
  const done = pops.filter((p) => p.status !== "pending").slice(0, 50);
  const [confirming, setConfirming] = useState<Pop | null>(null);
  const [invoiceId, setInvoiceId] = useState("");
  const [amount, setAmount] = useState("");
  const [paidAt, setPaidAt] = useState(today());
  const openInvoices = snapshot.invoices.filter((i) => ["sent", "viewed", "overdue", "partially_paid", "payment_pending_verification"].includes(i.status));
  const currencyOf = (id: string | null) => snapshot.invoices.find((i) => i.id === id)?.currency ?? snapshot.defaults?.currency ?? "ZAR";

  const view = (pop: Pop) => void call<{ url: string }>("billing.pop-file", { popId: pop.id }).then((r) => openUrl(r.url)).catch((e: unknown) => say(errorText(e)));

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <Card title={`Proof of payment to check (${pending.length})`}>
        <Muted>Proofs of payment come in by email (the Mailbox) or by upload. Billing never records money from a proof alone: check the bank, then confirm or reject.</Muted>
        {pending.length === 0 ? <Muted>Nothing to check.</Muted> : (
          <DataTable
            columns={[
              { key: "received", header: "Received" },
              { key: "from", header: "From" },
              { key: "invoice", header: "Invoice", render: (_v, row) => row.invoiceId ? <SmallButton onClick={() => onOpenInvoice(String(row.invoiceId))}>{String(row.invoiceNumber ?? "Open")}</SmallButton> : <span>Not matched</span> },
              { key: "matched", header: "Matched by" },
              { key: "id", header: "", width: "260px", render: (_v, row) => {
                const pop = pending.find((p) => p.id === row.id)!;
                return (
                  <Row style={{ gap: 4 }}>
                    {pop.hasFile ? <SmallButton onClick={() => view(pop)}>View</SmallButton> : null}
                    <SmallButton variant="primary" onClick={() => {
                      setConfirming(pop);
                      setInvoiceId(pop.invoiceId ?? "");
                      const inv = snapshot.invoices.find((i) => i.id === pop.invoiceId);
                      setAmount(minorToInput(pop.amountMinor ?? inv?.outstandingMinor ?? 0));
                      setPaidAt(today());
                    }}>Money is in</SmallButton>
                    <SmallButton onClick={() => void run(() => call("billing.reject-pop", { popId: pop.id, reason: "Not in the bank" }), "Proof of payment rejected")}>Reject</SmallButton>
                  </Row>
                );
              } },
            ]}
            rows={pending.map((pop) => ({
              ...pop,
              received: fmtDate(pop.receivedAt),
              from: pop.source === "email" ? `${pop.fromName ? `${pop.fromName} ` : ""}${pop.fromEmail ?? ""}${pop.subject ? ` — ${pop.subject}` : ""}` : "Upload",
              matched: BASIS[pop.matchBasis ?? "none"] ?? pop.matchBasis ?? "",
            }))}
          />
        )}
      </Card>

      {done.length > 0 ? (
        <Card title="Checked">
          {done.map((pop) => (
            <Row key={pop.id} style={{ justifyContent: "space-between", fontSize: 13 }}>
              <span>{fmtDate(pop.receivedAt)} · {pop.fromEmail ?? "Upload"}{pop.invoiceNumber ? ` · ${pop.invoiceNumber}` : ""}{pop.rejectReason ? ` · ${pop.rejectReason}` : ""}</span>
              <Status status={pop.status} />
            </Row>
          ))}
        </Card>
      ) : null}

      <Card title="Credit notes">
        {(snapshot.creditNotes ?? []).length === 0 ? <Muted>No credit notes yet. Issue one from a sent invoice.</Muted> : (
          <DataTable
            columns={[
              { key: "number", header: "Number" },
              { key: "invoice", header: "Invoice" },
              { key: "amount", header: "Amount" },
              { key: "status", header: "Status", render: (value) => <Status status={String(value)} /> },
              { key: "id", header: "", width: "150px", render: (_v, row) => (
                <Row style={{ gap: 4 }}>
                  <SmallButton onClick={() => void call<{ base64: string; filename: string }>("billing.credit-note-pdf", { creditNoteId: String(row.id) }).then((r) => openBase64Pdf(r.base64, r.filename)).catch((e: unknown) => say(errorText(e)))}>PDF</SmallButton>
                  <SmallButton onClick={() => onOpenInvoice(String(row.invoiceId))}>Invoice</SmallButton>
                </Row>
              ) },
            ]}
            rows={(snapshot.creditNotes ?? []).map((n) => ({ ...n, number: n.number ?? "—", invoice: n.invoiceNumber ?? "", amount: money(n.amountMinor, n.currency ?? "ZAR") }))}
          />
        )}
      </Card>

      {scope ? <ClientMoney /> : null}

      <Modal open={Boolean(confirming)} title="Confirm the payment" description="Records the money against the invoice. More than is owed stays with the customer as credit." onClose={() => setConfirming(null)} footer={<>
        <Button type="button" variant="secondary" onClick={() => setConfirming(null)}>Cancel</Button>
        <Button type="button" onClick={() => void run(async () => {
          await call("billing.confirm-pop", { popId: confirming!.id, invoiceId: invoiceId || null, amountMinor: toMinor(amount), paidAt });
          setConfirming(null);
        }, "Payment confirmed")}>Confirm</Button>
      </>}>
        <Field label="Invoice">
          <Select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
            <option value="">Choose the invoice…</option>
            {openInvoices.map((i) => <option key={i.id} value={i.id}>{i.number} · {i.customerName ?? i.customerRef} · {money(i.outstandingMinor ?? 0, i.currency)} owed</option>)}
          </Select>
        </Field>
        <Field label={`Amount in the bank (${currencyOf(invoiceId || null)})`}><Input value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Date it cleared"><Input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} /></Field>
      </Modal>
    </div>
  );
}

/** Client workspace: unused credit, statement, reminder opt-out. */
function ClientMoney() {
  const { snapshot, call, run, say, scope, clientName } = useBilling();
  const [from, setFrom] = useState(new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(today());
  const credit = snapshot.customerCredit ?? [];
  if (!scope) return null;
  const client = `${scope.kind}:${scope.id}`;
  return (
    <>
      <Card title="Customer credit">
        {credit.length === 0 ? <Muted>{clientName} has no unused credit.</Muted> : credit.map((c) => (
          <Row key={`${c.sourceKind}:${c.sourceId}`} style={{ justifyContent: "space-between", fontSize: 13 }}>
            <span>{words(c.sourceKind === "payment" ? "overpayment" : "credit note")} · {c.label} · {fmtDate(c.at)}</span>
            <span>{money(c.availableMinor, c.currency)} left</span>
          </Row>
        ))}
        {credit.length > 0 ? <Muted>Use it from an unpaid invoice: open the invoice → Use customer credit.</Muted> : null}
      </Card>
      <Card title="Statement">
        <Row style={{ alignItems: "end" }}>
          <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <SmallButton style={{ height: 36 }} onClick={() => void call<{ base64: string; filename: string }>("billing.statement-pdf", { client, from, to }).then((r) => openBase64Pdf(r.base64, r.filename)).catch((e: unknown) => say(errorText(e)))}>Preview</SmallButton>
          {snapshot.features?.email ? <SmallButton style={{ height: 36 }} variant="primary" onClick={() => void run(() => call("billing.send-statement", { client, from, to }), "Statement queued in the Mailbox")}>Email statement</SmallButton> : null}
        </Row>
      </Card>
      <Card title="Payment reminders">
        <Row style={{ justifyContent: "space-between" }}>
          <Muted>{snapshot.dunningOptOut ? `${clientName} gets no payment reminders.` : snapshot.features?.dunning ? `${clientName} gets the reminder stages set in Billing settings.` : "Reminders are off in Billing settings."}</Muted>
          <SmallButton onClick={() => void run(() => call("billing.set-dunning-optout", { client, optOut: !snapshot.dunningOptOut }), snapshot.dunningOptOut ? "Reminders on for this client" : "No more reminders for this client")}>{snapshot.dunningOptOut ? "Send reminders again" : "Stop reminders"}</SmallButton>
        </Row>
      </Card>
    </>
  );
}

export function PaymentsEmpty() {
  return <EmptyState title="No payments yet" description="Payments appear when a person confirms a proof of payment, records one, or Accounting matches a bank line." />;
}
