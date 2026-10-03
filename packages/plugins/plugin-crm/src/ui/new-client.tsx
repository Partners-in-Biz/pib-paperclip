/**
 * "What is left to set up" for a client: the checklist `crm.start-new-client`
 * computes from the CRM's records (project, git workspace, branch rule, profile,
 * services, lead form, brand kit, one step per service). Loaded on demand.
 */
import { useState } from "react";
import { Button, ListChecks, Pill, SectionCard, tokens } from "@partnersinbiz/pib-plugin-ui";
import { STATE_LABEL, stateTone, type ChecklistResult } from "./checklist-view.js";

const muted = { margin: 0, fontSize: 12.5, color: tokens.muted, lineHeight: 1.45 } as const;

export function NewClientCard({ onLoad }: { onLoad: () => Promise<ChecklistResult | null> }) {
  const [result, setResult] = useState<ChecklistResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    setResult(await onLoad());
    setBusy(false);
  }

  return (
    <SectionCard
      title="What is left to set up"
      icon={ListChecks}
      subtitle="Project and git workspace, the development branch rule, profile, services, lead form, brand kit and one step per service, read from the CRM's records."
      actions={<Button type="button" variant="secondary" style={{ height: 28, fontSize: 12 }} disabled={busy} onClick={() => void load()}>{busy ? "Checking…" : result ? "Check again" : "Check"}</Button>}
    >
      {result ? (
        <div style={{ display: "grid", gap: 10 }}>
          <p style={muted}>{result.next}</p>
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 8 }}>
            {result.checklist.map((row) => (
              <li key={row.key} style={{ display: "grid", gap: 3, padding: 10, borderRadius: 10, border: `1px solid ${tokens.border}`, minWidth: 0 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <Pill size="sm" tone={stateTone(row.state)} dot>{STATE_LABEL[row.state]}</Pill>
                  <strong style={{ fontSize: 13, overflowWrap: "anywhere" }}>{row.title}</strong>
                  <span style={{ fontSize: 12, color: tokens.muted, marginLeft: "auto" }}>{row.owner}</span>
                </div>
                {row.state !== "done" ? <p style={muted}>{row.detail ? `${row.detail} ` : ""}{row.how}</p> : row.detail ? <p style={muted}>{row.detail}</p> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p style={muted}>Press Check to see what is still open for this client and who does it.</p>
      )}
    </SectionCard>
  );
}
