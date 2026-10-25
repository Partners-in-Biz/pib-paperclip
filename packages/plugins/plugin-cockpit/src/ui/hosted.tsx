/**
 * Cockpit → Hosted clients (owner company only): per hosted company and month, the notional spend,
 * runs, done issues and agents, read from `hosted-usage.load`. Counts and cost only. Any other
 * company gets `allowed: false` and sees no tab, no sidebar row and a "not available" page.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, EmptyState, Field, Select, TriangleAlert, errorText, tokens } from "@partnersinbiz/pib-plugin-ui";
import type { HostedUsageList, HostedUsageListed } from "../hosted-usage.js";
import { Card, Muted } from "./components.js";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** `2026-10-01` to `October 2026`. */
export function monthLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(month);
  return m ? `${MONTH_NAMES[Number(m[2]) - 1] ?? m[2]} ${m[1]}` : month;
}

/** The months the page loads (this one and the five before), newest first. */
export function monthOptions(now: Date): string[] {
  // SAST is UTC+2 all year, as the roll-up's months.
  const local = new Date(now.getTime() + 2 * 3_600_000);
  return [0, 1, 2, 3, 4, 5].map((back) => new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - back, 1)).toISOString().slice(0, 10));
}

/** Notional USD, e.g. `$1,234.56`. */
export function formatUsd(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const th: CSSProperties = { textAlign: "left", fontSize: 11.5, fontWeight: 600, color: tokens.muted, padding: "8px 10px", borderBottom: `1px solid ${tokens.border}`, whiteSpace: "nowrap" };
const td: CSSProperties = { fontSize: 12.5, padding: "10px", borderBottom: `1px solid ${tokens.border}`, verticalAlign: "top" };
const num: CSSProperties = { ...td, textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };

/** The page without loading: also what the tests and the visual checks render. */
export function HostedBody({ rows, months, month, onMonth }: { rows: HostedUsageListed[]; months: string[]; month: string; onMonth: (month: string) => void }) {
  const shown = rows.filter((r) => r.month === month);
  const computedAt = shown.reduce((latest, r) => (r.computedAt > latest ? r.computedAt : latest), "");
  return (
    <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
      <Card title="Hosted clients" subtitle="Spend is notional USD (what the runs would cost at list price), not an invoice. Agents is a snapshot from the last recompute, not the month's average.">
        <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
          <div style={{ maxWidth: 260 }}>
            <Field label="Month">
              <Select value={month} onChange={(e) => onMonth(e.target.value)}>
                {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
              </Select>
            </Field>
          </div>
          {shown.length === 0 ? (
            <Muted>No hosted usage recorded for {monthLabel(month)}.</Muted>
          ) : (
            <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch", minWidth: 0 }}>
              <table style={{ width: "100%", minWidth: 520, borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={th}>Company</th>
                    <th style={{ ...th, textAlign: "right" }}>Spend (USD, notional)</th>
                    <th style={{ ...th, textAlign: "right" }}>Runs</th>
                    <th style={{ ...th, textAlign: "right" }}>Done issues</th>
                    <th style={{ ...th, textAlign: "right" }}>Agents</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={`${r.month}:${r.hostedCompanyId}`}>
                      <td style={{ ...td, overflowWrap: "anywhere", minWidth: 140 }}>{r.companyName || "Unnamed company"}</td>
                      <td style={num}>{formatUsd(r.notionalUsd)}</td>
                      <td style={num}>{r.runs.toLocaleString("en-US")}</td>
                      <td style={num}>{r.doneIssues.toLocaleString("en-US")}</td>
                      <td style={num}>{r.agents.toLocaleString("en-US")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {computedAt ? <Muted>Last recomputed {computedAt.slice(0, 16).replace("T", " ")} UTC.</Muted> : null}
        </div>
      </Card>
    </div>
  );
}

export type HostedState = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; list: HostedUsageList };

const NOT_AVAILABLE: HostedState = { status: "ready", list: { allowed: false, rows: [] } };

/** What was loaded and for which company. */
export interface HostedHeld {
  companyId: string;
  state: HostedState;
}

/** The state to show for `companyId`: anything held for another company counts as still loading, never as that company's data. */
export function hostedStateFor(held: HostedHeld | null, companyId: string | null | undefined): HostedState {
  if (!companyId) return NOT_AVAILABLE;
  return held && held.companyId === companyId ? held.state : { status: "loading" };
}

/**
 * Loads the last six months for `companyId`; `reload` after a refresh. Every company calls it (the
 * answer is the gate: only the owner gets `allowed`). A response is kept only while its company is
 * still the current one, and a state held for another company is never shown.
 */
export function useHostedUsage(companyId: string | null | undefined, refreshKey = 0): { state: HostedState; reload: () => Promise<void> } {
  const load = usePluginAction("hosted-usage.load");
  const [held, setHeld] = useState<HostedHeld | null>(null);
  const current = useRef(companyId);
  current.current = companyId;
  const reload = useCallback(async () => {
    if (!companyId) return;
    let state: HostedState;
    try {
      state = { status: "ready", list: (await load({})) as HostedUsageList };
    } catch (err) {
      state = { status: "error", error: errorText(err) };
    }
    if (current.current === companyId) setHeld({ companyId, state });
  }, [load, companyId]);
  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);
  return { state: hostedStateFor(held, companyId), reload };
}

/** Whether the owner-only entries (tab, sidebar row) show for this state. */
export function hostedAllowed(state: HostedState): boolean {
  return state.status === "ready" && state.list.allowed;
}

/** The view for a loaded state: the table when allowed, the "not available" page when not. */
export function HostedView({ state, now, onRetry }: { state: HostedState; now: Date; onRetry: () => void }) {
  const months = monthOptions(now);
  const [month, setMonth] = useState(months[0]!);
  if (state.status === "loading") return <Muted>Loading hosted clients…</Muted>;
  if (state.status === "error") {
    return <EmptyState tone="bad" icon={TriangleAlert} title="Hosted clients could not load" description={state.error} action={<Button type="button" variant="secondary" onClick={onRetry}>Try again</Button>} />;
  }
  if (!state.list.allowed) return <EmptyState title="Not available" description="Hosted clients is only available in the Partners in Biz company." />;
  return <HostedBody rows={state.list.rows} months={months} month={month} onMonth={setMonth} />;
}
