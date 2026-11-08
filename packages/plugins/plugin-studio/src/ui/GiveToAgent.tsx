/**
 * Give to agent (PAR-8138): the host's New Task popup, prefilled from the asset. The worker checks the client and copies
 * the file (`give-prepare`), the person edits the task, picks the agent and sends; Studio then links the task to the
 * asset (`give-record`). Closing the popup creates nothing and removes the copy (`give-discard`).
 */
import { useMemo } from "react";
import { useHostNavigation, useHostNewIssue } from "@paperclipai/plugin-sdk/ui";
import { useStudioAction } from "./action.js";
import { GiveToAgentButton } from "@partnersinbiz/pib-plugin-ui";
import { popupDefaults, withDiscard, type GivePrefill } from "./give-popup.js";

export function issuePath(issue: { id: string; identifier: string | null }): string {
  return `/issues/${encodeURIComponent(issue.identifier ?? issue.id)}`;
}

/** Give to agent for one asset. Each instance owns its own request; the popup is the host's, so it can sit anywhere. */
export function GiveButton({ companyId, assetId, purpose, label, onGiven, onError }: { companyId: string; assetId: string; /** Adds a brief to the task (give.ts GIVE_PURPOSES). */ purpose?: string; label?: string; onGiven?: (out: { message: string; warning: string | null }) => void; onError?: (message: string) => void }) {
  const host = useHostNewIssue();
  const prepare = useStudioAction("give-prepare");
  const record = useStudioAction("give-record");
  const discard = useStudioAction("give-discard");
  // One give at a time per button (the button is disabled while busy), so one ref-like slot is enough.
  const slot = useMemo(() => ({ giveId: null as string | null }), []);
  const newIssue = useMemo(
    () => withDiscard(host, () => slot.giveId, (giveId) => discard({ companyId, assetId, giveId })),
    [host, slot, discard, companyId, assetId],
  );
  return (
    <GiveToAgentButton
      newIssue={newIssue}
      {...(label ? { label } : {})}
      prepare={async () => {
        slot.giveId = null;
        const out = (await prepare({ companyId, assetId, ...(purpose ? { purpose } : {}) })) as GivePrefill;
        slot.giveId = out.giveId;
        return popupDefaults(out);
      }}
      record={async (issue) => {
        const out = (await record({ companyId, assetId, giveId: slot.giveId, issueId: issue.id })) as { message: string; warning: string | null };
        slot.giveId = null;
        return out;
      }}
      onDone={(out) => onGiven?.({ message: out.message, warning: out.warning })}
      onError={(message) => onError?.(message)}
    />
  );
}

/** Issues this asset was given to, for the asset detail. */
export function GivenList({ items }: { items: Array<{ id: string; identifier: string | null; title: string | null; status: string | null; agentName: string | null }> }) {
  const nav = useHostNavigation();
  if (items.length === 0) return <span>—</span>;
  return (
    <ul style={{ margin: 0, paddingLeft: 16, display: "grid", gap: 2 }}>
      {items.map((i) => (
        <li key={i.id} style={{ overflowWrap: "anywhere" }}>
          <a {...nav.linkProps(issuePath(i))}>{i.identifier ?? "Task"}</a>
          {i.agentName ? ` to ${i.agentName}` : ""}
          {i.status ? ` · ${i.status.replace(/_/g, " ")}` : ""}
        </li>
      ))}
    </ul>
  );
}
