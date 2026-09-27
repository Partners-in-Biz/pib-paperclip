/**
 * "Who approves pay runs" on the Pay runs tab: a people picker (names, with
 * the email as the muted detail) that saves `approval.defaultApproverUserId`
 * into Payroll's own settings through the host config API. Saving needs an
 * instance admin; anyone else gets one plain sentence and the old value stays.
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Button, Pill, ShieldCheck, tokens, tone, useIsNarrow } from "@partnersinbiz/pib-plugin-ui";
import { approverName, approverOptions, approverWarning, saveErrorText, withDefaultApprover, type DirectoryPerson } from "./approver.js";
import { fetchPayrollConfig, HostRequestError, savePayrollConfig } from "./host-api.js";
import { Muted, Notice, small } from "./shared.js";
import type { Snapshot } from "./types.js";

const NOT_SAVED = "Save the Payroll settings (employer details) first, then choose the approver here.";

export function ApproverCard({ s, people, peopleFailed, companyId, onSaved }: {
  s: Snapshot;
  /** The company's people (null while loading). */
  people: DirectoryPerson[] | null;
  peopleFailed: boolean;
  companyId: string | null | undefined;
  /** Refreshes the snapshot and the setup status, then shows `message`. */
  onSaved: (message: string) => Promise<void>;
}) {
  const narrow = useIsNarrow();
  const current = s.settings.defaultApproverUserId ?? null;
  const options = useMemo(() => approverOptions(people ?? [], { me: s.me, runs: s.runs }), [people, s.me, s.runs]);
  const [editing, setEditing] = useState(!current);
  const [choice, setChoice] = useState(current ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setChoice(current ?? "");
    if (!current) setEditing(true);
  }, [current]);

  const currentOption = options.find((o) => o.userId === current) ?? null;
  const chosen = options.find((o) => o.userId === choice) ?? null;
  const warning = approverWarning(editing ? chosen : currentOption);

  async function save() {
    if (!companyId || !choice || busy) return;
    setBusy(true);
    setError("");
    let config: Record<string, unknown>;
    try {
      const read = await fetchPayrollConfig(companyId);
      // Never create the settings with only an approver in them: that would look like saved settings without the employer details.
      if (!read.saved || Object.keys(read.config).length === 0) {
        setError(NOT_SAVED);
        setBusy(false);
        return;
      }
      config = read.config;
    } catch {
      setError("Couldn't read the Payroll settings. Try again.");
      setBusy(false);
      return;
    }
    try {
      // The full saved settings go back with only the approver changed (secret refs included).
      await savePayrollConfig(companyId, withDefaultApprover(config, choice));
      setEditing(false);
      const who = chosen?.isYou ? "You approve" : `${chosen?.name ?? "They"} approves`;
      await onSaved(`Saved. ${who} pay runs from now on.`);
    } catch (err) {
      const status = err instanceof HostRequestError ? err.status : 0;
      setError(saveErrorText(status));
      if (status === 401 || status === 403) {
        // Not allowed: keep the old value.
        setChoice(current ?? "");
        if (current) setEditing(false);
      }
    } finally {
      setBusy(false);
    }
  }

  const box: CSSProperties = {
    display: "grid",
    gap: 10,
    padding: narrow ? 12 : 14,
    borderRadius: 12,
    border: `1px solid ${current ? tokens.border : tone("warn").border}`,
    background: tokens.card,
    minWidth: 0,
  };

  if (!editing) {
    return (
      <div style={{ ...box, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <ShieldCheck size={16} aria-hidden="true" style={{ color: tokens.muted, flexShrink: 0 }} />
        <div style={{ flex: "1 1 220px", minWidth: 0, fontSize: 13, lineHeight: 1.45 }}>
          <span style={{ color: tokens.muted }}>Pay runs are approved by </span>
          <strong>{people === null && !peopleFailed ? "…" : approverName(current, people, s.me)}</strong>
          {currentOption?.isYou && currentOption.name !== "You" ? <span style={{ color: tokens.muted }}> (you)</span> : null}
          {currentOption?.detail ? <span style={{ color: tokens.muted }}> · {currentOption.detail}</span> : null}
          {warning ? <div style={{ fontSize: 12.5, color: tone("warn").fg, marginTop: 4 }}>{warning}</div> : null}
          {error ? <div role="alert" style={{ fontSize: 12.5, color: tone("bad").fg, marginTop: 4 }}>{error}</div> : null}
        </div>
        <Button
          type="button"
          variant="secondary"
          style={small}
          onClick={() => {
            setChoice(current ?? "");
            setError("");
            setEditing(true);
          }}
        >
          Change
        </Button>
      </div>
    );
  }

  return (
    <section aria-label="Who approves pay runs" style={box}>
      <div style={{ display: "grid", gap: 2 }}>
        <strong style={{ fontSize: 14 }}>Who approves pay runs</strong>
        <Muted style={{ fontSize: 12.5 }}>Every pay run is approved by someone who didn't prepare it. Pick the person who usually approves; they get an approval task for each run.</Muted>
      </div>
      {people === null && !peopleFailed ? <Muted>Loading the people in this company…</Muted> : null}
      {peopleFailed ? <Notice tone="warn">Couldn't load the people in this company. Reload the page to try again.</Notice> : null}
      {options.length ? (
        <div role="radiogroup" aria-label="Approver" style={{ display: "grid", gap: 6 }}>
          {options.map((o) => {
            const selected = choice === o.userId;
            return (
              <label
                key={o.userId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  minHeight: 44,
                  padding: "6px 10px",
                  borderRadius: 10,
                  border: `1px solid ${selected ? tokens.ring : tokens.border}`,
                  background: selected ? tokens.secondary : tokens.bg,
                  cursor: "pointer",
                  minWidth: 0,
                }}
              >
                <input type="radio" name="payroll-approver" value={o.userId} checked={selected} onChange={() => setChoice(o.userId)} style={{ flexShrink: 0 }} />
                <span style={{ display: "grid", minWidth: 0, flex: "1 1 auto" }}>
                  <span style={{ fontSize: 13.5, fontWeight: 600, overflowWrap: "anywhere" }}>{o.name}{o.isYou && o.name !== "You" ? " (you)" : ""}</span>
                  {o.detail ? <span style={{ fontSize: 12, color: tokens.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.detail}</span> : null}
                </span>
                {o.preparedRuns ? <Pill tone="warn" size="sm">Prepares pay runs</Pill> : null}
              </label>
            );
          })}
        </div>
      ) : people && !people.length ? (
        <Muted>Nobody is a member of this company yet. Invite a board member in Company settings, then pick them here.</Muted>
      ) : null}
      {warning ? <div style={{ fontSize: 12.5, color: tone("warn").fg, lineHeight: 1.45 }}>{warning}</div> : null}
      {!s.settings.saved ? <Muted style={{ fontSize: 12.5 }}>{NOT_SAVED}</Muted> : null}
      {error ? <div role="alert" style={{ fontSize: 12.5, color: tone("bad").fg }}>{error}</div> : null}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button type="button" disabled={!choice || choice === current || busy || !companyId || !s.settings.saved} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</Button>
        {current ? (
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setEditing(false);
              setChoice(current);
              setError("");
            }}
          >
            Cancel
          </Button>
        ) : null}
      </div>
    </section>
  );
}
