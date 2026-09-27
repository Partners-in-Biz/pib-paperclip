/**
 * The optional Payroll Clerk card: hire it through a task, or link an agent
 * the company already has. Linking (by hand or automatically after a hire)
 * also attaches the pib-payroll skill for the person viewing the page, since
 * the plugin worker cannot change an agent's skills.
 */
import { useState } from "react";
import { useHostContext, useHostNavigation, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Bot, Button, Field, Modal, SectionCard, Select, tokens } from "@partnersinbiz/pib-plugin-ui";
import { HIRE_STALE_DAYS, ROLE_SKILL_PURPOSE, ROLE_SKILLS, dropSkillAsks, roleView } from "./role-skills.js";
import { useRoleSkills } from "./use-role-skills.js";

export interface ClerkAgent {
  id: string;
  name: string;
  title?: string | null;
  role?: string | null;
  status: string;
}

/** `hireStatus` from the kit (payroll.load → hire). */
export interface ClerkHire {
  agent: ClerkAgent | null;
  linkedBy?: "auto" | "manual" | "managed" | null;
  hire: { issueId: string; identifier: string | null; status?: "open" | "linked" | "cancelled"; createdAt?: string } | null;
  candidates?: ClerkAgent[];
}

type RunFn = <T>(work: () => Promise<T>, success?: string) => Promise<T | null>;

const small = { height: 28, fontSize: 12 } as const;
const text = { margin: 0, fontSize: 13 } as const;

function detail(a: ClerkAgent): string {
  return a.title && a.title !== a.name ? ` · ${a.title}` : "";
}

export function ClerkCard({ hire, run }: { hire: ClerkHire | null; run: RunFn }) {
  const host = useHostContext();
  const navigation = useHostNavigation();
  const hireOptions = usePluginAction("payroll.hire-options");
  const startHire = usePluginAction("payroll.start-hire");
  const linkAgent = usePluginAction("payroll.link-agent");
  const unlinkAgent = usePluginAction("payroll.unlink-agent");
  const [picker, setPicker] = useState<{ agents: ClerkAgent[]; selected: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ title: string; lines: string[] } | null>(null);

  const agent = hire?.agent ?? null;
  // Hire only with no agent linked and no hire task open (no duplicate hires). Older payroll state has no status: treat a hire record as open.
  const role = roleView({ agentId: agent?.id, hire: hire?.hire ? { status: hire.hire.status ?? "open", createdAt: hire.hire.createdAt } : null });
  const openHire = role.mode === "hiring" ? hire?.hire ?? null : null;
  const skills = useRoleSkills({ companyId: host.companyId, agent, skills: ROLE_SKILLS, purpose: ROLE_SKILL_PURPOSE });

  const openHireTask = () =>
    void run(async () => {
      const options = (await hireOptions({})) as { defaultAssigneeAgentId: string | null };
      return startHire({ assigneeAgentId: options.defaultAssigneeAgentId ?? undefined });
    }, "Hire request opened");

  const openPicker = async () => {
    setResult(null);
    setBusy(true);
    const options = await run(async () => (await hireOptions({})) as { agents: ClerkAgent[]; status?: { candidates?: ClerkAgent[] } });
    setBusy(false);
    if (!options) return;
    const agents = options.agents.filter((a) => a.id !== agent?.id);
    setPicker({ agents, selected: options.status?.candidates?.[0]?.id ?? "" });
  };

  const link = async (agentId: string) => {
    setBusy(true);
    skills.claim(agentId);
    const r = await run(async () => (await linkAgent({ agentId })) as { agent: ClerkAgent; steps: string[] }, "Payroll Clerk linked");
    if (!r) {
      skills.release(agentId);
      setBusy(false);
      return;
    }
    setPicker(null);
    const skill = await skills.afterLink(r.agent.id, r.agent.name);
    setResult({ title: `Linked ${r.agent.name} as the Payroll Clerk`, lines: [...(skill.ok ? dropSkillAsks(r.steps, ROLE_SKILLS) : r.steps), skill.line] });
    setBusy(false);
  };

  const unlink = async () => {
    setBusy(true);
    const r = await run(() => unlinkAgent({}), "Payroll Clerk unlinked. The agent itself was not changed.");
    setBusy(false);
    if (r) setPicker(null);
  };

  const issueHref = openHire ? `/issues/${openHire.identifier ?? openHire.issueId}` : "";

  return (
    <SectionCard title="Payroll Clerk (optional agent)" icon={Bot}>
      <div style={{ display: "grid", gap: 8 }}>
        {agent ? (
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <p style={{ ...text, maxWidth: 620 }}>
              Linked: <strong>{agent.name}</strong> ({agent.status.replace(/_/g, " ")}). It prepares pay runs and checks variances. It never approves runs or sees personal details.
            </p>
            <Button type="button" variant="secondary" style={small} disabled={busy} onClick={() => void openPicker()}>Change agent</Button>
          </div>
        ) : openHire ? (
          <div style={{ display: "grid", gap: 6 }}>
            <p style={text}>
              Hire task <a {...navigation.linkProps(issueHref)} style={{ color: tokens.fg, fontWeight: 600 }}>{openHire.identifier ?? "open"}</a> is open. The plugin links the new agent automatically when it appears.
            </p>
            {role.stale ? <p style={{ ...text, color: tokens.muted }}>It has been open for more than {HIRE_STALE_DAYS} days. If nobody is working on it, open a new hire task.</p> : null}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Button type="button" variant="secondary" style={small} disabled={busy} onClick={() => void openPicker()}>Link agent</Button>
              {role.canRehire ? <Button type="button" variant="secondary" style={small} disabled={busy} onClick={openHireTask}>Open a new hire task</Button> : null}
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <p style={{ ...text, color: tokens.muted, maxWidth: 620 }}>An agent can prepare each month's run, enter hours and bonuses, and explain changes against last month. A board member still approves and locks.</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Button type="button" variant="secondary" disabled={busy} onClick={openHireTask}>Hire Payroll Clerk</Button>
              <Button type="button" variant="secondary" disabled={busy} onClick={() => void openPicker()}>Use an existing agent</Button>
            </div>
          </div>
        )}
        {skills.note ? <p style={{ ...text, fontSize: 12.5, color: skills.note.ok ? tokens.muted : tokens.fg }}>{skills.note.line}</p> : null}
        {result ? (
          <div style={{ display: "grid", gap: 4, fontSize: 12.5 }}>
            <strong>{result.title}</strong>
            <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>{result.lines.map((line) => <li key={line}>{line}</li>)}</ul>
          </div>
        ) : null}
      </div>
      {picker ? (
        <Modal
          open
          title={agent ? "Change Payroll Clerk" : "Use an existing agent"}
          description="The agent you pick gets the Payroll tools (masked data only) and the pib-payroll skill. It never approves, locks or sees personal details. Nothing else about it changes."
          onClose={() => setPicker(null)}
          footer={
            <>
              {agent && hire?.linkedBy !== "managed" ? <Button type="button" variant="secondary" disabled={busy} onClick={() => void unlink()}>Unlink</Button> : null}
              <Button type="button" variant="secondary" disabled={busy} onClick={() => setPicker(null)}>Cancel</Button>
              <Button type="button" disabled={busy || !picker.selected} onClick={() => void link(picker.selected)}>{busy ? "Linking…" : "Link agent"}</Button>
            </>
          }
        >
          {picker.agents.length === 0 ? (
            <p style={{ ...text, color: tokens.muted }}>No other agents in this company yet. Hire one instead.</p>
          ) : (
            <Field label="Agent">
              <Select value={picker.selected} onChange={(event) => setPicker({ ...picker, selected: event.target.value })} disabled={busy}>
                <option value="">Choose an agent…</option>
                {picker.agents.map((a) => <option key={a.id} value={a.id}>{`${a.name}${detail(a)}${a.status === "paused" ? " (paused)" : ""}`}</option>)}
              </Select>
            </Field>
          )}
          <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted }}>Linking attaches the <code>pib-payroll</code> skill to the agent for you (its other skills stay).</p>
        </Modal>
      ) : null}
    </SectionCard>
  );
}
