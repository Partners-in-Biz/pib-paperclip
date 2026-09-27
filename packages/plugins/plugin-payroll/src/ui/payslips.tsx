/**
 * Payslips: made when a pay run is locked. Download or email each one (a
 * row on a phone opens the same two actions).
 */
import { useEffect, useState } from "react";
import { DataTable, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, CompactRows, EmptyState, Modal, errorText, formatDate, formatDateTime, formatShortDate, tokens, useIsNarrow } from "@partnersinbiz/pib-plugin-ui";
import { payslipStatusLabel } from "./series.js";
import { download, Muted, small, StatusPill } from "./shared.js";
import type { PayslipRow, RunFn, TabId } from "./types.js";

export function PayslipsTab({ run, setMessage, go }: { run: RunFn; setMessage: (m: string) => void; go: (tab: TabId) => void }) {
  const list = usePluginAction("payroll.payslips");
  const downloadSlip = usePluginAction("payroll.download-payslip");
  const email = usePluginAction("payroll.email-payslips");
  const narrow = useIsNarrow();
  const [rows, setRows] = useState<PayslipRow[] | null>(null);
  const [open, setOpen] = useState<PayslipRow | null>(null);
  async function refresh() {
    setRows(((await list({})) as { payslips: PayslipRow[] }).payslips);
  }
  useEffect(() => {
    refresh().catch((error: unknown) => setMessage(errorText(error)));
  }, []);

  const canDownload = (p: PayslipRow) => !(p.status === "pending" || (p.status === "failed" && !p.emailedTo));
  const canEmail = (p: PayslipRow) => !(p.status === "pending" || p.status === "sending");
  const downloadNow = (p: PayslipRow) => void run(async () => download((await downloadSlip({ payslipId: p.id })) as { url: string; fileName: string }));
  const emailNow = (p: PayslipRow) => void run(async () => { await email({ runId: p.runId, payslipIds: [p.id] }); await refresh(); }, "Queued for email");

  if (!rows) return <Muted>Loading payslips…</Muted>;
  if (!rows.length) {
    return (
      <EmptyState
        title="No payslips yet"
        description="Payslips are made when a pay run is locked."
        action={<Button type="button" variant="secondary" onClick={() => go("runs")}>Open pay runs</Button>}
      />
    );
  }
  return (
    <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
      {narrow ? (
        <CompactRows
          label="Payslips"
          rows={rows}
          title={(p) => p.employee ?? p.number}
          meta={(p) => [p.payDate ? `Paid ${formatShortDate(p.payDate)}` : null, p.run].filter(Boolean).join(" · ")}
          trailing={(p) => <StatusPill status={p.status} label={payslipStatusLabel(p.status)} />}
          onOpen={(p) => setOpen(p)}
        />
      ) : (
        <DataTable
          columns={[
            { key: "employee", header: "Employee", render: (_v, row) => { const p = row as unknown as PayslipRow; return <div><div style={{ fontWeight: 600 }}>{p.employee ?? "–"}</div><div style={{ fontSize: 12, color: tokens.muted }}>{p.number}</div></div>; } },
            { key: "runText", header: "Pay run" },
            { key: "payText", header: "Pay date" },
            { key: "status", header: "Status", render: (v) => <StatusPill status={String(v)} label={payslipStatusLabel(String(v))} /> },
            { key: "emailedTo", header: "Emailed to" },
            {
              key: "id",
              header: "",
              width: "200px",
              render: (_v, row) => {
                const p = row as unknown as PayslipRow;
                return (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <Button type="button" variant="secondary" style={small} disabled={!canDownload(p)} onClick={() => downloadNow(p)}>Download</Button>
                    <Button type="button" variant="secondary" style={small} disabled={!canEmail(p)} onClick={() => emailNow(p)}>{p.status === "sent" ? "Email again" : "Email"}</Button>
                  </div>
                );
              },
            },
          ]}
          rows={rows.map((p) => ({ ...p, runText: p.run ?? "–", payText: p.payDate ? formatDate(p.payDate) : "–" })) as unknown as Array<Record<string, unknown>>}
        />
      )}

      <Modal open={Boolean(open)} title={open ? `Payslip for ${open.employee ?? open.number}` : ""} description={open ? [open.number, open.payDate ? `paid ${formatDate(open.payDate)}` : null].filter(Boolean).join(" · ") : undefined} onClose={() => setOpen(null)} footer={open ? (
        <>
          <Button type="button" variant="secondary" disabled={!canEmail(open)} onClick={() => { const p = open; setOpen(null); emailNow(p); }}>{open.status === "sent" ? "Email again" : "Email"}</Button>
          <Button type="button" disabled={!canDownload(open)} onClick={() => { const p = open; setOpen(null); downloadNow(p); }}>Download</Button>
        </>
      ) : undefined}>
        {open ? (
          <div style={{ display: "grid", gap: 6, fontSize: 13 }}>
            <div><StatusPill status={open.status} label={payslipStatusLabel(open.status)} /></div>
            {open.emailedTo ? <span>Emailed to {open.emailedTo}{open.emailedAt ? ` on ${formatDateTime(open.emailedAt)}` : ""}</span> : null}
            {open.error ? <span style={{ color: tokens.muted }}>{open.error}</span> : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
