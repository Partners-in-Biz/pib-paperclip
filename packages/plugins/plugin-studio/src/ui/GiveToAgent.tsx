/**
 * Give to agent: pick an agent that can run, write what it should do, send. The worker opens a normal issue assigned
 * to that agent with the instruction as written and a copy of the file it can open. Agents that run off this server
 * can't open the copy, so they're listed with the reason and can't be picked.
 */
import { useEffect, useState } from "react";
import { useHostNavigation, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, errorText, Field, Modal, PageMessage, Select, TextArea } from "@partnersinbiz/pib-plugin-ui";

export interface AgentChoice {
  id: string;
  name: string;
  title: string | null;
  canOpen: boolean;
  why: string | null;
}

export interface Given {
  issueId: string;
  identifier: string | null;
  title: string;
  agent: { id: string; name: string };
  woken: boolean;
  wakeError: string | null;
}

export const MAX_INSTRUCTION = 10_000;

export function issuePath(issue: { id: string; identifier: string | null }): string {
  return `/issues/${encodeURIComponent(issue.identifier ?? issue.id)}`;
}

/** The first agent that can open the file, or "" when none can. */
export function firstPickable(agents: AgentChoice[]): string {
  return agents.find((a) => a.canOpen)?.id ?? "";
}

export function GiveDialog({ open, companyId, assetId, assetName, onClose, onGiven }: {
  open: boolean;
  companyId: string;
  assetId: string;
  assetName: string;
  onClose: () => void;
  onGiven?: (given: Given) => void;
}) {
  const nav = useHostNavigation();
  const listAction = usePluginAction("give-agents");
  const giveAction = usePluginAction("give");
  const [agents, setAgents] = useState<AgentChoice[] | null>(null);
  const [agentId, setAgentId] = useState("");
  const [instruction, setInstruction] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [given, setGiven] = useState<Given | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setAgents(null);
    setGiven(null);
    setError(null);
    listAction({ companyId })
      .then((out) => {
        if (!live) return;
        const list = (out as { agents: AgentChoice[] }).agents ?? [];
        setAgents(list);
        setAgentId((current) => (list.some((a) => a.id === current && a.canOpen) ? current : firstPickable(list)));
      })
      .catch((err) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
  }, [open, companyId]);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const out = (await giveAction({ companyId, assetId, agentId, instruction })) as Given;
      setGiven(out);
      setInstruction("");
      onGiven?.(out);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const picked = agents?.find((a) => a.id === agentId);
  const blocked = agents?.filter((a) => !a.canOpen) ?? [];
  const canSend = !busy && Boolean(picked?.canOpen) && instruction.trim().length > 0 && instruction.length <= MAX_INSTRUCTION;
  return (
    <Modal
      open={open}
      title="Give to agent"
      description={`Opens a task for the agent with "${assetName}" and what you write below.`}
      onClose={onClose}
      footer={
        given ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button disabled={!canSend} onClick={() => void send()}>{busy ? "Sending…" : "Send"}</Button>
          </>
        )
      }
    >
      {error ? <PageMessage tone="danger" message={error} /> : null}
      {given ? (
        <div role="status" style={{ display: "grid", gap: 6, overflowWrap: "anywhere" }}>
          <span>
            Given to {given.agent.name}.{" "}
            <a {...nav.linkProps(issuePath({ id: given.issueId, identifier: given.identifier }))}>{given.identifier ?? "Open the task"}</a>
            {given.identifier ? `: ${given.title}` : null}
          </span>
          {given.woken ? null : <span style={{ color: "var(--muted-foreground)" }}>The agent wasn't woken{given.wakeError ? ` (${given.wakeError})` : ""}. It picks the task up on its next run.</span>}
        </div>
      ) : (
        <>
          {!agents && !error ? <span style={{ color: "var(--muted-foreground)" }}>Loading agents…</span> : null}
          {agents && agents.length === 0 ? <span>No agent can run right now.</span> : null}
          {agents && agents.length > 0 ? (
            <Field label="Agent">
              <Select value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Agent">
                {agentId ? null : <option value="">Pick an agent</option>}
                {agents.map((a) => (
                  <option key={a.id} value={a.id} disabled={!a.canOpen}>
                    {a.name}{a.title ? `, ${a.title}` : ""}{a.canOpen ? "" : " (can't open files)"}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {blocked.length > 0 ? (
            <details style={{ fontSize: 13, color: "var(--muted-foreground)" }}>
              <summary>Why {blocked.length === 1 ? "1 agent can't" : `${blocked.length} agents can't`} be picked</summary>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {blocked.map((a) => <li key={a.id} style={{ overflowWrap: "anywhere" }}>{a.why}</li>)}
              </ul>
            </details>
          ) : null}
          <Field label="What should the agent do with it?">
            <TextArea value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={5} maxLength={MAX_INSTRUCTION} placeholder="For example: write three Instagram captions for this photo and post them as a comment." />
          </Field>
        </>
      )}
    </Modal>
  );
}

/** The button plus its dialog, for places not inside a transformed parent (the library's asset panel). */
export function GiveButton({ companyId, assetId, assetName, onGiven }: { companyId: string; assetId: string; assetName: string; onGiven?: (given: Given) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>Give to agent</Button>
      <GiveDialog open={open} companyId={companyId} assetId={assetId} assetName={assetName} onClose={() => setOpen(false)} onGiven={onGiven} />
    </>
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
