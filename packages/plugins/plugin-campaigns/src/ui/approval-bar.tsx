/**
 * The approval bar at the top of the campaign screen (plan PAR-9192 rev 2,
 * section 5.1): who it goes to, who it is sent as, every step as it will be
 * sent, the check results, and Approve and launch / Send back. A client
 * campaign also needs the client's yes: a link and a tick, or Approve stays
 * grey and the bar says what is missing. Approve sends the audience hash this
 * screen showed, so a changed audience is refused instead of launched.
 */
import { useState } from "react";
import { Button, CircleAlert, Input, Pill, TextArea, tokens, tone } from "@partnersinbiz/pib-plugin-ui";
import { approveMissing, namesLine, orderedSteps } from "../detail.js";
import type { CampaignDetailData } from "./detail.js";

export interface ApproveInput { audienceHash: string; audienceCount: number; clientYesRef?: string; clientYesSeen?: boolean }

export function ApprovalBar({ data, busy, onApprove, onSendBack }: {
  data: CampaignDetailData;
  busy: boolean;
  onApprove: (input: ApproveInput) => void;
  onSendBack: (note: string) => void;
}) {
  const { campaign, audience } = data;
  // One of our own brands is approved like an own campaign: no client's written yes.
  const isClient = Boolean(campaign.client) && !campaign.ownBrand;
  const [yesRef, setYesRef] = useState(campaign.clientYes?.ref ?? "");
  const [yesSeen, setYesSeen] = useState(false);
  const [sendingBack, setSendingBack] = useState(false);
  const [note, setNote] = useState("");
  const failed = Boolean(campaign.launchError);
  const errors = data.preflight?.errors ?? [];
  const warnings = data.preflight?.warnings ?? [];
  const missing = approveMissing({ isClient, yesRef, yesSeen, audienceHash: audience?.hash ?? null, checkErrors: errors.length });
  const steps = orderedSteps(campaign.steps);
  const names = audience ? namesLine(audience.firstNames ?? [], audience.willGet) : "";
  const label = { fontSize: 12, fontWeight: 650, color: tokens.muted } as const;

  function approve() {
    if (!audience?.hash || missing.length) return;
    onApprove({ audienceHash: audience.hash, audienceCount: audience.willGet, ...(isClient ? { clientYesRef: yesRef.trim(), clientYesSeen: yesSeen } : {}) });
  }

  return (
    <section aria-label="Approval" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 12, padding: 14, borderRadius: 12, border: `1px solid ${tone(failed ? "bad" : "warn").border}`, background: tone(failed ? "bad" : "warn").soft, minWidth: 0 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 14 }}>{failed ? "Approved, but it could not launch" : "Waiting for your approval"}</strong>
        {campaign.client ? <Pill tone="info" title={campaign.client.name ?? undefined}>{`For ${campaign.client.name ?? "a client"}`}</Pill> : null}
      </div>
      {failed ? (
        <p role="alert" style={{ margin: 0, fontSize: 13, lineHeight: 1.45, color: tokens.fg, overflowWrap: "anywhere" }}>
          <strong>Why: </strong>{campaign.launchError}{isClient ? "" : " Fix that, then click Launch."}
        </p>
      ) : null}

      <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "minmax(80px, auto) minmax(0, 1fr)", gap: "8px 12px", fontSize: 13, lineHeight: 1.45 }}>
        <dt style={label}>Goes to</dt>
        <dd style={{ margin: 0, minWidth: 0, overflowWrap: "anywhere" }}>
          {audience ? (
            <>
              <strong>{audience.willGet} {audience.willGet === 1 ? "person" : "people"}</strong>
              {names ? `: ${names}` : ""}
              {!isClient && audience.customers ? <span style={{ color: tone("warn").fg }}>{` · ${audience.customers} ${audience.customers === 1 ? "is a current client" : "are current clients"}`}</span> : null}
            </>
          ) : "The audience could not be read just now."}
        </dd>
        <dt style={label}>Sent as</dt>
        <dd style={{ margin: 0, minWidth: 0, overflowWrap: "anywhere" }}>{data.sender?.sentAs ?? "No sender set up yet"}</dd>
        <dt style={label}>Steps</dt>
        <dd style={{ margin: 0, minWidth: 0 }}>
          <ol style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 2 }}>
            {steps.map((step) => (
              <li key={step.position} style={{ overflowWrap: "anywhere" }}>
                <span style={{ color: tokens.muted }}>{step.timing}: </span>
                {stepTitle(step.a)}{step.b ? <span style={{ color: tokens.muted }}>{` · B: ${stepTitle(step.b)}`}</span> : null}
              </li>
            ))}
          </ol>
          <span style={{ fontSize: 12, color: tokens.muted }}>Each one in full is below.</span>
        </dd>
        <dt style={label}>Checks</dt>
        <dd style={{ margin: 0, minWidth: 0, overflowWrap: "anywhere" }}>
          {errors.length === 0 && warnings.length === 0 ? "All checks pass." : (
            <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 2 }}>
              {errors.map((finding, index) => <li key={`e${index}`} style={{ color: tone("bad").fg }}>Fix: {finding.message}</li>)}
              {warnings.map((finding, index) => <li key={`w${index}`} style={{ color: tokens.muted }}>Check: {finding.message}</li>)}
            </ul>
          )}
        </dd>
      </dl>

      {isClient ? (
        <fieldset style={{ margin: 0, padding: 0, border: 0, display: "grid", gap: 8, minWidth: 0 }}>
          <legend style={{ ...label, padding: 0, marginBottom: 6 }}>Client's yes</legend>
          <Input aria-label="Where the client said yes" placeholder="Link to the comment or email where the client said yes" style={{ boxSizing: "border-box" }} value={yesRef} onChange={(event) => setYesRef(event.target.value)} />
          <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
            <input type="checkbox" checked={yesSeen} onChange={(event) => setYesSeen(event.target.checked)} style={{ marginTop: 3 }} />
            I have seen the client's written yes
          </label>
        </fieldset>
      ) : null}

      {missing.length ? (
        <p style={{ margin: 0, display: "flex", gap: 6, alignItems: "flex-start", fontSize: 12.5, color: tokens.fg, overflowWrap: "anywhere" }}>
          <CircleAlert size={14} aria-hidden="true" style={{ color: tone("warn").solid, flexShrink: 0, marginTop: 2 }} />
          <span>{`Approve is off until there is ${missing.join(", and ")}.`}</span>
        </p>
      ) : null}

      {sendingBack ? (
        <div style={{ display: "grid", gap: 8 }}>
          <TextArea aria-label="What to change" placeholder="What should change? The agent gets this note." rows={3} value={note} onChange={(event) => setNote(event.target.value)} />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button type="button" variant="secondary" onClick={() => setSendingBack(false)}>Cancel</Button>
            <Button type="button" disabled={busy || !note.trim()} title={note.trim() ? undefined : "A note is required"} onClick={() => onSendBack(note.trim())}>Send back</Button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button type="button" disabled={busy || missing.length > 0} title={missing.length ? `Add ${missing.join(" and ")} first` : undefined} onClick={approve}>
            {failed && !isClient ? "Launch" : "Approve and launch"}
          </Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => setSendingBack(true)}>Send back</Button>
        </div>
      )}
    </section>
  );
}

function stepTitle(step: { subject: string; body: string; channel?: string }): string {
  if (step.channel === "sms" || step.channel === "whatsapp") return `${step.channel === "sms" ? "SMS" : "WhatsApp"}: ${step.body.slice(0, 60)}${step.body.length > 60 ? "…" : ""}`;
  return step.subject || "(no subject)";
}
