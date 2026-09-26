import { useEffect, useMemo, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, Field, Input, Section, Select } from "@partnersinbiz/pib-plugin-ui";
import type { LoadResult } from "./overview.js";
import { centsToInput, Muted, rand, Row, small, Table, Td, toCents, useRunner } from "./shared.js";

function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
}

interface ForecastRow {
  month: string;
  openingMinor: number;
  receiptsMinor: number;
  paymentsMinor: number;
  recurringMinor: number;
  manualMinor: number;
  closingMinor: number;
}

interface ForecastResult {
  recurringCostsMinor: number;
  basedOn: { from: string; to: string };
  rows: ForecastRow[];
  manualLines: Array<{ id: string; month: string; description: string; amountMinor: number; repeat: string; untilMonth: string | null }>;
}

export function BudgetsTab({ data, onMessage }: { data: LoadResult; onMessage: (m: string) => void }) {
  const loadBudgets = usePluginAction("accounting.budgets");
  const saveBudgets = usePluginAction("accounting.save-budgets");
  const loadForecast = usePluginAction("accounting.forecast");
  const saveLine = usePluginAction("accounting.save-forecast-line");
  const deleteLine = usePluginAction("accounting.delete-forecast-line");
  const { busy, run } = useRunner(onMessage);
  const thisMonth = new Date().toISOString().slice(0, 7);
  const [fromMonth, setFromMonth] = useState(thisMonth);
  const [cells, setCells] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [months, setMonths] = useState(3);
  const [forecast, setForecast] = useState<ForecastResult | null>(null);
  const [line, setLine] = useState({ month: thisMonth, description: "", amount: "", repeat: "none", untilMonth: "" });

  const budgetMonths = useMemo(() => Array.from({ length: 12 }, (_, i) => addMonths(fromMonth, i)), [fromMonth]);
  const plAccounts = data.accounts.filter((a) => a.active && (a.type === "income" || a.type === "expense"));

  async function refreshBudgets(from = fromMonth) {
    const r = (await loadBudgets({ fromMonth: from, toMonth: addMonths(from, 11) })) as { budgets: Array<{ accountCode: string; month: string; amountMinor: number }> };
    setCells(Object.fromEntries(r.budgets.map((b) => [`${b.accountCode}|${b.month}`, centsToInput(b.amountMinor)])));
    setDirty(new Set());
  }
  async function refreshForecast(n = months) {
    setForecast((await loadForecast({ months: n })) as ForecastResult);
  }
  useEffect(() => {
    void run("load", async () => {
      await refreshBudgets();
      await refreshForecast();
    });
  }, []);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Section
        title="Budgets"
        actions={
          <Row>
            <Field label="First month"><Input type="month" value={fromMonth} onChange={(e) => { setFromMonth(e.target.value); void run("load", () => refreshBudgets(e.target.value)); }} /></Field>
            <Button type="button" disabled={dirty.size === 0 || busy !== ""} onClick={() => void run("save", async () => {
              const budgets = [...dirty].map((key) => {
                const [accountCode, month] = key.split("|") as [string, string];
                return { accountCode, month, amountMinor: toCents(cells[key] ?? "") ?? 0 };
              });
              await saveBudgets({ budgets });
              setDirty(new Set());
            }, "Budgets saved.")}>Save budgets</Button>
          </Row>
        }
      >
        <Muted>Income and costs per month, in rand. Budget vs actual is under Reports.</Muted>
        <div style={{ overflowX: "auto" }}>
          <Table head={["Account", ...budgetMonths.map((m) => ({ label: m, right: true }))]}>
            {plAccounts.map((a) => (
              <tr key={a.id}>
                <Td>{`${a.code} ${a.name}`}</Td>
                {budgetMonths.map((m) => {
                  const key = `${a.code}|${m}`;
                  return (
                    <Td key={m} right>
                      <input
                        value={cells[key] ?? ""}
                        onChange={(e) => {
                          setCells({ ...cells, [key]: e.target.value });
                          setDirty(new Set(dirty).add(key));
                        }}
                        style={{ width: 80, textAlign: "right", fontSize: 12, border: "1px solid var(--input)", borderRadius: 6, background: "var(--background)", color: "var(--foreground)", padding: "3px 5px" }}
                      />
                    </Td>
                  );
                })}
              </tr>
            ))}
          </Table>
        </div>
      </Section>

      <Section
        title="Cash-flow forecast"
        actions={
          <Select value={String(months)} onChange={(e) => { setMonths(Number(e.target.value)); void run("load", () => refreshForecast(Number(e.target.value))); }}>
            {[3, 6, 12].map((n) => <option key={n} value={n}>{n} months</option>)}
          </Select>
        }
      >
        {forecast ? (
          <>
            <Muted>
              Open receivables and payables by due date (overdue ones in the first month), recurring costs estimated at {rand(forecast.recurringCostsMinor)} a month (average of {forecast.basedOn.from} to {forecast.basedOn.to}, less what is already in payables), plus the lines below.
            </Muted>
            <Table head={["Month", { label: "Opening", right: true }, { label: "Receipts", right: true }, { label: "Payments", right: true }, { label: "Recurring", right: true }, { label: "Other", right: true }, { label: "Closing", right: true }]}>
              {forecast.rows.map((r) => (
                <tr key={r.month}>
                  <Td>{r.month}</Td>
                  <Td right>{rand(r.openingMinor)}</Td>
                  <Td right>{rand(r.receiptsMinor)}</Td>
                  <Td right>{rand(-r.paymentsMinor)}</Td>
                  <Td right>{rand(-r.recurringMinor)}</Td>
                  <Td right>{rand(r.manualMinor)}</Td>
                  <Td right strong>{rand(r.closingMinor)}</Td>
                </tr>
              ))}
            </Table>
            <strong style={{ fontSize: 13 }}>Other expected cash (negative for money out)</strong>
            {forecast.manualLines.length ? (
              <Table head={["Month", "Description", { label: "Amount", right: true }, "Repeats", ""]}>
                {forecast.manualLines.map((l) => (
                  <tr key={l.id}>
                    <Td>{l.month}</Td>
                    <Td>{l.description}</Td>
                    <Td right>{rand(l.amountMinor)}</Td>
                    <Td>{l.repeat === "monthly" ? `monthly${l.untilMonth ? ` until ${l.untilMonth}` : ""}` : "once"}</Td>
                    <Td><Button type="button" variant="secondary" style={small} onClick={() => void run("del", async () => { await deleteLine({ id: l.id }); await refreshForecast(); })}>Remove</Button></Td>
                  </tr>
                ))}
              </Table>
            ) : null}
            <Row>
              <Field label="Month"><Input type="month" value={line.month} onChange={(e) => setLine({ ...line, month: e.target.value })} /></Field>
              <Field label="Description"><Input value={line.description} onChange={(e) => setLine({ ...line, description: e.target.value })} placeholder="Provisional tax" /></Field>
              <Field label="Amount (R)"><Input value={line.amount} onChange={(e) => setLine({ ...line, amount: e.target.value })} placeholder="-25000" /></Field>
              <Field label="Repeats">
                <Select value={line.repeat} onChange={(e) => setLine({ ...line, repeat: e.target.value })}>
                  <option value="none">Once</option>
                  <option value="monthly">Monthly</option>
                </Select>
              </Field>
              {line.repeat === "monthly" ? <Field label="Until"><Input type="month" value={line.untilMonth} onChange={(e) => setLine({ ...line, untilMonth: e.target.value })} /></Field> : null}
              <Button type="button" variant="secondary" disabled={!line.description.trim() || !line.amount || busy !== ""} onClick={() => void run("line", async () => {
                await saveLine({ month: line.month, description: line.description, amountMinor: toCents(line.amount), repeat: line.repeat, untilMonth: line.untilMonth || null });
                setLine({ ...line, description: "", amount: "" });
                await refreshForecast();
              }, "Added.")}>Add</Button>
            </Row>
          </>
        ) : <Muted>Loading…</Muted>}
      </Section>
    </div>
  );
}
