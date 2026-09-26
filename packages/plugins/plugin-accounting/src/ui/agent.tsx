import { useState, type ReactNode } from "react";
import { useHostContext, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, Field, Modal, NewTaskDialog, Select, errorText, tokens, type TaskAssigneeOption } from "@partnersinbiz/pib-plugin-ui";
import { Banner, IssueLink, small, words } from "./shared.js";

export interface HireAgent {
  id: string;
  name: string;
  title: string | null;
  role: string | null;
  status: string;
}

export interface HireRecord {
  issueId: string;
  identifier: string | null;
  status: "open" | "linked" | "cancelled";
  createdAt: string;
  issueStatus?: string | null;
  assigneeName?: string | null;
}

export interface HireView {
  agent: HireAgent | null;
  linkedBy: "auto" | "manual" | "managed" | null;
  hire: HireRecord | null;
  candidates: HireAgent[];
}

interface HireOptions {
  draft: { title: string; description: string };
  agents: HireAgent[];
  defaultAssigneeAgentId: string | null;
  status: HireView;
}

const LOCAL_BOARD_USER_ID = "local-board";
const CLOSED = ["done", "cancelled"];

function detail(a: HireAgent): string | null {
  return a.title && a.title !== a.name ? a.title : a.role ? words(a.role) : null;
}

/** The Bookkeeper card: hire through a task, link an existing agent, re-sync. */
export function BookkeeperPanel({ hire, refresh, onMessage }: { hire: HireView | null; refresh: () => Promise<void>; onMessage: (m: string) => void }) {
  const host = useHostContext();
  const loadOptions = usePluginAction("accounting.hire-options");
  const startHire = usePluginAction("accounting.start-hire");
  const linkAgent = usePluginAction("accounting.link-agent");
  const unlinkAgent = usePluginAction("accounting.unlink-agent");
  const resync = usePluginAction("accounting.resync-agent");
  const [busy, setBusy] = useState("");
  const [hireOptions, setHireOptions] = useState<HireOptions | null>(null);
  const [linkOptions, setLinkOptions] = useState<HireOptions | null>(null);
  const [linkId, setLinkId] = useState("");
  const [steps, setSteps] = useState<{ title: string; steps: string[]; instructions: string[] } | null>(null);

  async function run(kind: string, fn: () => Promise<void>) {
    setBusy(kind);
    onMessage("");
    try {
      await fn();
    } catch (error) {
      onMessage(errorText(error));
    } finally {
      setBusy("");
    }
  }

  const agent = hire?.agent ?? null;
  const openRequest = !agent && hire?.hire?.status === "open" ? hire.hire : null;
  const me = host.userId && host.userId !== LOCAL_BOARD_USER_ID ? host.userId : null;
  const assignees: TaskAssigneeOption[] = [
    ...(me ? [{ kind: "user" as const, id: me, name: "Me" }] : []),
    ...(hireOptions?.agents ?? []).map((a) => ({ kind: "agent" as const, id: a.id, name: a.name, detail: detail(a), status: a.status })),
  ];
  const openLink = () =>
    run("link", async () => {
      const options = (await loadOptions({})) as HireOptions;
      setLinkId(options.status.candidates[0]?.id ?? "");
      setLinkOptions(options);
    });
  const actions = (buttons: ReactNode) => <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>{buttons}</div>;

  let banner: ReactNode;
  if (!hire) banner = null;
  else if (agent) {
    banner = (
      <Banner tone={agent.status === "paused" || agent.status === "pending_approval" ? "warn" : "info"}>
        <span>
          <strong>Bookkeeper: {agent.name}</strong> ({words(agent.status)})
          {hire.linkedBy ? <span style={{ color: tokens.muted }}> · {hire.linkedBy === "auto" ? "linked from the hire task" : "linked by hand"}</span> : null}
        </span>
        {agent.status === "paused" ? <span>Open Agents → {agent.name}, check its adapter has a working model key, then click Resume.</span> : null}
        {agent.status === "pending_approval" ? <span>Approve the hire in Approvals, then resume the agent.</span> : null}
        {actions(
          <>
            <Button type="button" variant="secondary" style={small} disabled={busy !== ""} onClick={() => void run("resync", async () => {
              const r = (await resync({})) as { agent: { name: string }; steps: string[]; instructions: string[] };
              setSteps({ title: `Re-synced ${r.agent.name}`, steps: r.steps, instructions: r.instructions });
              await refresh();
            })}>{busy === "resync" ? "Re-syncing…" : "Re-sync"}</Button>
            <Button type="button" variant="secondary" style={small} disabled={busy !== ""} onClick={() => void openLink()}>Change agent</Button>
          </>,
        )}
      </Banner>
    );
  } else if (openRequest) {
    const closed = CLOSED.includes(openRequest.issueStatus ?? "");
    banner = (
      <Banner tone={closed ? "warn" : "info"}>
        <span>
          <strong>Hire request <IssueLink id={openRequest.issueId} identifier={openRequest.identifier} label={openRequest.identifier ?? "hire task"} /></strong>{" "}
          {closed ? `is ${words(openRequest.issueStatus)}, but no Bookkeeper was linked. Link it, or open a new hire task.` : `is open (${openRequest.assigneeName ? `assigned to ${openRequest.assigneeName}` : "not assigned yet"}). The plugin links the new agent when it appears.`}
        </span>
        {hire.candidates.length > 1 ? <span>More than one new agent looks like the Bookkeeper ({hire.candidates.map((c) => c.name).join(", ")}). Pick one with Link agent.</span> : null}
        {actions(
          <>
            <Button type="button" variant="secondary" style={small} disabled={busy !== ""} onClick={() => void openLink()}>Link agent</Button>
            <Button type="button" variant="secondary" style={small} disabled={busy !== ""} onClick={() => void run("hire", async () => setHireOptions((await loadOptions({})) as HireOptions))}>Open a new hire task</Button>
          </>,
        )}
      </Banner>
    );
  } else {
    banner = (
      <Banner>
        <span>
          <strong>No Bookkeeper yet.</strong> Hire Bookkeeper opens a hire task with the agent's spec for whoever hires for this company. The Bookkeeper reconciles the bank, categorises lines and runs the month-end checklist; a person still approves anything that posts or locks.
        </span>
        {actions(
          <>
            <Button type="button" style={small} disabled={busy !== ""} onClick={() => void run("hire", async () => setHireOptions((await loadOptions({})) as HireOptions))}>{busy === "hire" ? "Opening…" : "Hire Bookkeeper"}</Button>
            <Button type="button" variant="secondary" style={small} disabled={busy !== ""} onClick={() => void openLink()}>Link an existing agent</Button>
          </>,
        )}
      </Banner>
    );
  }

  return (
    <>
      {banner}
      {steps ? (
        <Banner>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <strong style={{ minWidth: 0 }}>{steps.title}</strong>
            <button type="button" onClick={() => setSteps(null)} style={{ border: "none", background: "transparent", color: tokens.muted, cursor: "pointer", minWidth: 32, flexShrink: 0 }} aria-label="Dismiss">×</button>
          </div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>{steps.steps.map((s) => <li key={s}>{s}</li>)}</ul>
          {steps.instructions.length ? <ol style={{ margin: 0, paddingLeft: 18 }}>{steps.instructions.map((s) => <li key={s}>{s}</li>)}</ol> : null}
        </Banner>
      ) : null}
      <NewTaskDialog
        open={!!hireOptions}
        prefix={host.companyPrefix}
        initialTitle={hireOptions?.draft.title ?? ""}
        initialDescription={hireOptions?.draft.description ?? ""}
        assignees={assignees}
        defaultAssignee={hireOptions?.defaultAssigneeAgentId ? `agent:${hireOptions.defaultAssigneeAgentId}` : undefined}
        note="Give it to the agent that hires for this company (usually the CEO), or to yourself. When the new agent appears, Accounting links it and grants its tools."
        onClose={() => setHireOptions(null)}
        onCreate={async (task) => {
          await startHire(task);
          setHireOptions(null);
          await refresh();
        }}
      />
      {linkOptions ? (
        <Modal
          open
          title={agent ? "Change Bookkeeper" : "Link Bookkeeper"}
          description="Pick the agent that keeps the books. Accounting gives it tool access and sends it bank and month-end work. The agent's own settings are not changed."
          onClose={() => setLinkOptions(null)}
          footer={
            <>
              {agent ? (
                <Button type="button" variant="secondary" disabled={busy !== ""} onClick={() => void run("link", async () => {
                  await unlinkAgent({});
                  setLinkOptions(null);
                  onMessage("The Bookkeeper was unlinked. The agent itself was not changed.");
                  await refresh();
                })}>Unlink</Button>
              ) : null}
              <Button type="button" variant="secondary" onClick={() => setLinkOptions(null)}>Cancel</Button>
              <Button type="button" disabled={!linkId || busy !== ""} onClick={() => void run("link", async () => {
                const r = (await linkAgent({ agentId: linkId })) as { agent: HireAgent; steps: string[]; instructions: string[] };
                setLinkOptions(null);
                setSteps({ title: `Linked ${r.agent.name} as the Bookkeeper`, steps: r.steps, instructions: r.instructions });
                await refresh();
              })}>{busy === "link" ? "Linking…" : "Link agent"}</Button>
            </>
          }
        >
          <Field label="Agent">
            <Select value={linkId} onChange={(e) => setLinkId(e.target.value)}>
              <option value="">Choose an agent…</option>
              {linkOptions.agents.map((a) => (
                <option key={a.id} value={a.id}>{`${a.name}${detail(a) ? ` · ${detail(a)}` : ""}${a.status === "paused" ? " (paused)" : ""}`}</option>
              ))}
            </Select>
          </Field>
          <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted }}>The agent needs the <code>pib-bookkeeping</code> skill attached (Agents → agent → Skills).</p>
        </Modal>
      ) : null}
    </>
  );
}
