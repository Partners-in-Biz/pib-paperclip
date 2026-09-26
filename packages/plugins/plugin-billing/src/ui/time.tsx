import { useEffect, useMemo, useState } from "react";
import { DataTable } from "@paperclipai/plugin-sdk/ui";
import { Button, EmptyState, Field, Input, Modal, Select } from "@partnersinbiz/pib-plugin-ui";
import { Card, ClientSelect, Muted, Row, SmallButton, fmtDate, minorToInput, money, toMinor, today, useBilling } from "./parts.js";

function hours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

export function TimeTab({ onOpenInvoice }: { onOpenInvoice: (id: string) => void }) {
  const { snapshot, call, run, scope } = useBilling();
  const entries = snapshot.time ?? [];
  const running = entries.find((e) => e.running);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [running?.id]);
  const [description, setDescription] = useState("");
  const [client, setClient] = useState(scope ? `${scope.kind}:${scope.id}` : "");
  const [rate, setRate] = useState(minorToInput(snapshot.defaults?.hourlyRateMinor ?? 0));
  const [logging, setLogging] = useState(false);
  const [minutes, setMinutes] = useState("60");
  const [date, setDate] = useState(today());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [billing, setBilling] = useState(false);
  const [invoiceId, setInvoiceId] = useState("");
  const unbilled = useMemo(() => entries.filter((e) => !e.running && e.billable && !e.invoiceId), [entries]);
  const drafts = snapshot.invoices.filter((i) => i.status === "draft" && i.deliveryStatus !== "queued");
  const clientParam = client || undefined;
  const common = () => ({ description, rateMinor: rate ? toMinor(rate) : 0, ...(clientParam ? { client: clientParam } : {}) });

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <Card title="Timer">
        {running ? (
          <Row style={{ justifyContent: "space-between" }}>
            <span style={{ fontSize: 14 }}>{running.description}{running.customerName ? ` · ${running.customerName}` : ""} · <strong>{hours(Math.max(0, Math.round((Date.now() - Date.parse(running.startedAt ?? "")) / 60_000)) || running.minutes)}</strong></span>
            <SmallButton variant="primary" onClick={() => void run(() => call("billing.stop-timer", { entryId: running.id }), "Timer stopped")}>Stop</SmallButton>
          </Row>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            <Row style={{ alignItems: "end" }}>
              <div style={{ flex: "1 1 260px", minWidth: 0 }}><Field label="What are you working on?"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field></div>
              <div style={{ flex: "0 1 120px", minWidth: 100 }}><Field label="Rate per hour"><Input value={rate} onChange={(e) => setRate(e.target.value)} inputMode="decimal" /></Field></div>
            </Row>
            {!scope ? <ClientSelect clients={snapshot.clients ?? []} value={client} onChange={setClient} allowEmpty /> : null}
            <Row>
              <Button type="button" onClick={() => void run(() => call("billing.start-timer", common()), "Timer started")}>Start timer</Button>
              <Button type="button" variant="secondary" onClick={() => setLogging(true)}>Log time</Button>
            </Row>
          </div>
        )}
      </Card>

      {unbilled.length > 0 ? (
        <Row style={{ justifyContent: "space-between" }}>
          <Muted>{unbilled.length} unbilled entr{unbilled.length === 1 ? "y" : "ies"} worth {money(unbilled.reduce((a, e) => a + e.amountMinor, 0), unbilled[0]?.currency ?? "ZAR")}.</Muted>
          <SmallButton variant="primary" disabled={selected.size === 0} onClick={() => { setInvoiceId(drafts[0]?.id ?? ""); setBilling(true); }}>Add {selected.size || ""} to an invoice</SmallButton>
        </Row>
      ) : null}

      {entries.length === 0 ? <EmptyState title="No time yet" description="Start a timer or log time. Billable time goes onto a draft invoice as hours × rate." /> : (
        <DataTable
          columns={[
            { key: "pick", header: "", width: "36px", render: (_v, row) => row.running || row.invoiceId || !row.billable ? null : (
              <input type="checkbox" aria-label="Select entry" checked={selected.has(String(row.id))} onChange={(e) => {
                const next = new Set(selected);
                if (e.target.checked) next.add(String(row.id)); else next.delete(String(row.id));
                setSelected(next);
              }} />
            ) },
            { key: "date", header: "Date" },
            { key: "description", header: "Work" },
            { key: "client", header: "Client" },
            { key: "time", header: "Time" },
            { key: "amount", header: "Amount" },
            { key: "state", header: "", render: (_v, row) => row.invoiceId ? <SmallButton onClick={() => onOpenInvoice(String(row.invoiceId))}>On invoice</SmallButton> : row.running ? "Running" : !row.invoiceId && !row.running ? <SmallButton onClick={() => void run(() => call("billing.delete-time-entry", { entryId: String(row.id) }), "Time entry deleted")}>Delete</SmallButton> : null },
          ]}
          rows={entries.map((e) => ({ ...e, pick: "", date: fmtDate(e.startedAt), client: e.customerName ?? "—", time: hours(e.minutes), amount: e.billable ? money(e.amountMinor, e.currency) : "Not billable", state: "" }))}
        />
      )}

      <Modal open={logging} title="Log time" onClose={() => setLogging(false)} footer={<>
        <Button type="button" variant="secondary" onClick={() => setLogging(false)}>Cancel</Button>
        <Button type="button" onClick={() => void run(async () => { await call("billing.log-time", { ...common(), minutes: Number(minutes), date }); setLogging(false); }, "Time logged")}>Log</Button>
      </>}>
        <Field label="Work"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Row>
          <Field label="Minutes"><Input value={minutes} onChange={(e) => setMinutes(e.target.value)} /></Field>
          <Field label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        </Row>
        <Field label="Rate per hour"><Input value={rate} onChange={(e) => setRate(e.target.value)} /></Field>
        {!scope ? <ClientSelect clients={snapshot.clients ?? []} value={client} onChange={setClient} allowEmpty /> : null}
      </Modal>

      <Modal open={billing} title="Add time to an invoice" description="One line per entry. Only drafts can take new lines." onClose={() => setBilling(false)} footer={<>
        <Button type="button" variant="secondary" onClick={() => setBilling(false)}>Cancel</Button>
        <Button type="button" disabled={!invoiceId} onClick={() => void run(async () => {
          await call("billing.bill-time", { invoiceId, entryIds: [...selected] });
          setSelected(new Set());
          setBilling(false);
          onOpenInvoice(invoiceId);
        }, "Time added to the invoice")}>Add</Button>
      </>}>
        <Field label="Draft invoice">
          <Select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
            <option value="">Choose a draft…</option>
            {drafts.map((i) => <option key={i.id} value={i.id}>{i.number} · {i.customerName ?? i.customerRef}</option>)}
          </Select>
        </Field>
        {drafts.length === 0 ? <Muted>Draft an invoice for the client first.</Muted> : null}
      </Modal>
    </div>
  );
}
