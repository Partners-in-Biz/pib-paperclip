import { useState } from "react";
import { DataTable } from "@paperclipai/plugin-sdk/ui";
import { Button, Field, Input, Modal, Select } from "@partnersinbiz/pib-plugin-ui";
import { Card, ClientSelect, Muted, Row, SmallButton, Status, TaxCodeSelect, fmtDate, money, toMinor, today, useBilling, words } from "./parts.js";

const PERIODS = ["monthly", "quarterly", "yearly"];

export function RetainersTab({ onOpenInvoice }: { onOpenInvoice: (id: string) => void }) {
  const { snapshot, call, run, scope, clientName } = useBilling();
  const plans = snapshot.retainers?.plans ?? [];
  const subs = snapshot.retainers?.subscriptions ?? [];
  const recurring = snapshot.recurring ?? [];
  const numberOf = (id: string) => snapshot.invoices.find((i) => i.id === id)?.number ?? "invoice";
  const [planOpen, setPlanOpen] = useState(false);
  const [subOpen, setSubOpen] = useState(false);
  const [plan, setPlan] = useState({ name: "", price: "", period: "monthly", taxCode: snapshot.defaults?.taxCode ?? "za_std_15", currency: snapshot.defaults?.currency ?? "ZAR" });
  const [sub, setSub] = useState({ client: scope ? `${scope.kind}:${scope.id}` : "", planId: "", description: "", price: "", period: "monthly", startAt: today(), autoSend: false });
  const [recurringOpen, setRecurringOpen] = useState(false);
  const [rec, setRec] = useState({ templateInvoiceId: "", frequency: "monthly", nextRunAt: today(), autoSend: false });

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <Card title="Subscriptions" actions={<SmallButton variant="primary" onClick={() => setSubOpen(true)}>+ Put a client on a retainer</SmallButton>}>
        <Muted>Each period a draft invoice is created for a person to send, unless the subscription is set to send on its own.</Muted>
        {subs.length === 0 ? <Muted>{scope ? `${clientName} has no retainer.` : "No retainers yet."}</Muted> : (
          <DataTable
            columns={[
              { key: "customer", header: "Client" },
              { key: "description", header: "Retainer" },
              { key: "price", header: "Price" },
              { key: "status", header: "Status", render: (value) => <Status status={String(value)} /> },
              { key: "next", header: "Next invoice" },
              { key: "id", header: "", width: "220px", render: (_v, row) => {
                const s = subs.find((x) => x.id === row.id)!;
                return (
                  <Row style={{ gap: 4 }}>
                    {s.status === "active" ? <SmallButton onClick={() => void run(() => call("billing.set-subscription-status", { subscriptionId: s.id, status: "paused" }), "Retainer paused")}>Pause</SmallButton> : null}
                    {s.status === "paused" ? <SmallButton onClick={() => void run(() => call("billing.set-subscription-status", { subscriptionId: s.id, status: "active" }), "Retainer resumed")}>Resume</SmallButton> : null}
                    {s.status !== "cancelled" ? <SmallButton onClick={() => void run(() => call("billing.set-subscription-status", { subscriptionId: s.id, status: "cancelled" }), "Retainer cancelled")}>Cancel</SmallButton> : null}
                  </Row>
                );
              } },
            ]}
            rows={subs.map((s) => ({ ...s, customer: s.customerName ?? s.customerRef, price: `${money(s.priceMinor, s.currency)} ${words(s.period).toLowerCase()}${s.autoSend ? " · sends itself" : ""}`, next: s.status === "active" ? fmtDate(s.nextInvoiceAt) : "—" }))}
          />
        )}
      </Card>

      {!scope ? (
        <Card title="Plans" actions={<SmallButton onClick={() => setPlanOpen(true)}>+ New plan</SmallButton>}>
          {plans.length === 0 ? <Muted>No plans yet. A plan is a standard retainer (name, price, period).</Muted> : plans.map((p) => (
            <Row key={p.id} style={{ justifyContent: "space-between", fontSize: 13 }}>
              <span>{p.name} · {money(p.priceMinor, p.currency)} {p.period}{p.active ? "" : " · retired"}</span>
              <SmallButton onClick={() => void run(() => call("billing.update-plan", { planId: p.id, active: !p.active }), p.active ? "Plan retired" : "Plan active again")}>{p.active ? "Retire" : "Reuse"}</SmallButton>
            </Row>
          ))}
        </Card>
      ) : null}

      <Card title="Recurring invoices" actions={<SmallButton onClick={() => { setRec({ ...rec, templateInvoiceId: snapshot.invoices[0]?.id ?? "" }); setRecurringOpen(true); }}>+ Repeat an invoice</SmallButton>}>
        {recurring.length === 0 ? <Muted>No recurring invoices. Any invoice can repeat monthly, quarterly or yearly; every field and line is copied.</Muted> : recurring.map((r) => (
          <Row key={r.id} style={{ justifyContent: "space-between", fontSize: 13 }}>
            <span>Copy of <SmallButton onClick={() => onOpenInvoice(r.templateInvoiceId)}>{numberOf(r.templateInvoiceId)}</SmallButton> · {r.frequency} · next {fmtDate(r.nextRunAt)}{r.autoSend ? " · sends itself" : ""}{r.endsAt ? ` · until ${fmtDate(r.endsAt)}` : ""}</span>
            <Row style={{ gap: 4 }}>
              <Status status={r.isActive ? "active" : "paused"} />
              <SmallButton onClick={() => void run(() => call(r.isActive ? "billing.pause-recurring" : "billing.resume-recurring", { recurringId: r.id }), r.isActive ? "Paused" : "Resumed")}>{r.isActive ? "Pause" : "Resume"}</SmallButton>
              <SmallButton onClick={() => void run(() => call("billing.update-recurring", { recurringId: r.id, autoSend: !r.autoSend }), r.autoSend ? "New invoices stay drafts" : "New invoices send themselves")}>{r.autoSend ? "Stop auto-send" : "Auto-send"}</SmallButton>
            </Row>
          </Row>
        ))}
      </Card>

      <Modal open={planOpen} title="New retainer plan" onClose={() => setPlanOpen(false)} footer={<>
        <Button type="button" variant="secondary" onClick={() => setPlanOpen(false)}>Cancel</Button>
        <Button type="button" onClick={() => void run(async () => { await call("billing.create-plan", { name: plan.name, priceMinor: toMinor(plan.price), period: plan.period, taxCode: plan.taxCode, currency: plan.currency }); setPlanOpen(false); }, "Plan created")}>Create</Button>
      </>}>
        <Field label="Name"><Input value={plan.name} onChange={(e) => setPlan({ ...plan, name: e.target.value })} placeholder="Growth retainer" /></Field>
        <Row>
          <Field label="Price (excl. VAT)"><Input value={plan.price} onChange={(e) => setPlan({ ...plan, price: e.target.value })} /></Field>
          <Field label="Every"><Select value={plan.period} onChange={(e) => setPlan({ ...plan, period: e.target.value })}>{PERIODS.map((p) => <option key={p} value={p}>{words(p)}</option>)}</Select></Field>
        </Row>
        <TaxCodeSelect value={plan.taxCode} onChange={(taxCode) => setPlan({ ...plan, taxCode })} />
      </Modal>

      <Modal open={subOpen} title="Put a client on a retainer" onClose={() => setSubOpen(false)} footer={<>
        <Button type="button" variant="secondary" onClick={() => setSubOpen(false)}>Cancel</Button>
        <Button type="button" onClick={() => void run(async () => {
          await call("billing.create-subscription", { client: sub.client, ...(sub.planId ? { planId: sub.planId } : {}), ...(sub.description ? { description: sub.description } : {}), ...(sub.price ? { priceMinor: toMinor(sub.price) } : {}), period: sub.period, startAt: sub.startAt, autoSend: sub.autoSend });
          setSubOpen(false);
        }, "Retainer started")}>Start</Button>
      </>}>
        {!scope ? <ClientSelect clients={snapshot.clients ?? []} value={sub.client} onChange={(client) => setSub({ ...sub, client })} /> : null}
        <Field label="Plan">
          <Select value={sub.planId} onChange={(e) => { const p = plans.find((x) => x.id === e.target.value); setSub({ ...sub, planId: e.target.value, period: p?.period ?? sub.period }); }}>
            <option value="">Custom</option>
            {plans.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name} · {money(p.priceMinor, p.currency)} {p.period}</option>)}
          </Select>
        </Field>
        <Field label="Description on the invoice"><Input value={sub.description} onChange={(e) => setSub({ ...sub, description: e.target.value })} placeholder={sub.planId ? "The plan's name" : "Monthly retainer"} /></Field>
        <Row>
          <Field label={sub.planId ? "Price (empty = plan price)" : "Price (excl. VAT)"}><Input value={sub.price} onChange={(e) => setSub({ ...sub, price: e.target.value })} /></Field>
          <Field label="Every"><Select value={sub.period} onChange={(e) => setSub({ ...sub, period: e.target.value })}>{PERIODS.map((p) => <option key={p} value={p}>{words(p)}</option>)}</Select></Field>
        </Row>
        <Field label="First invoice on"><Input type="date" value={sub.startAt} onChange={(e) => setSub({ ...sub, startAt: e.target.value })} /></Field>
        <Field label="New invoices">
          <Select value={sub.autoSend ? "send" : "draft"} onChange={(e) => setSub({ ...sub, autoSend: e.target.value === "send" })}>
            <option value="draft">Stay drafts for a person to send</option>
            <option value="send">Email themselves (no approval)</option>
          </Select>
        </Field>
      </Modal>

      <Modal open={recurringOpen} title="Repeat an invoice" onClose={() => setRecurringOpen(false)} footer={<>
        <Button type="button" variant="secondary" onClick={() => setRecurringOpen(false)}>Cancel</Button>
        <Button type="button" disabled={!rec.templateInvoiceId} onClick={() => void run(async () => { await call("billing.create-recurring", rec); setRecurringOpen(false); }, "Recurring invoice scheduled")}>Schedule</Button>
      </>}>
        <Field label="Invoice to copy">
          <Select value={rec.templateInvoiceId} onChange={(e) => setRec({ ...rec, templateInvoiceId: e.target.value })}>
            {snapshot.invoices.filter((i) => !i.shared).map((i) => <option key={i.id} value={i.id}>{i.number} · {i.customerName ?? i.customerRef} · {money(i.totalMinor, i.currency)}</option>)}
          </Select>
        </Field>
        <Row>
          <Field label="Every"><Select value={rec.frequency} onChange={(e) => setRec({ ...rec, frequency: e.target.value })}>{PERIODS.map((p) => <option key={p} value={p}>{words(p)}</option>)}</Select></Field>
          <Field label="Next invoice on"><Input type="date" value={rec.nextRunAt} onChange={(e) => setRec({ ...rec, nextRunAt: e.target.value })} /></Field>
        </Row>
        <Field label="New invoices">
          <Select value={rec.autoSend ? "send" : "draft"} onChange={(e) => setRec({ ...rec, autoSend: e.target.value === "send" })}>
            <option value="draft">Stay drafts for a person to send</option>
            <option value="send">Email themselves (no approval)</option>
          </Select>
        </Field>
      </Modal>
    </div>
  );
}
