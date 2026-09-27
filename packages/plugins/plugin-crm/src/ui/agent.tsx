/**
 * The Account Manager box. The agent is hired, picked, changed or removed in
 * Setup → Team; the CRM page shows this box only when something is wrong,
 * with one line and "Fix in Setup".
 */
import { useState, type CSSProperties, type ReactNode } from "react";
import { useHostContext, useHostNavigation, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, errorText, tokens, tone } from "@partnersinbiz/pib-plugin-ui";
import { EXTRA_SKILLS, ROLE_SKILL_PURPOSE, ROLE_SKILLS, TEAM_SETUP_HREF, agentProblem, stillMissing } from "./role-skills.js";
import { useRoleSkills } from "./use-role-skills.js";

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
  /** CRM role skills the worker saw missing on the agent. */
  missingSkills?: string[];
}

const small: CSSProperties = { height: 28, fontSize: 12, padding: "0 10px" };

/** "Fix in Setup": a small primary link (the host only styles its own class names). */
const fixLink: CSSProperties = { display: "inline-flex", alignItems: "center", height: 28, padding: "0 10px", borderRadius: 8, background: tokens.primary, color: tokens.primaryFg, fontSize: 12, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" };

function Banner({ tone: t = "info", children }: { tone?: "warn" | "info" | "ok" | "bad"; children: ReactNode }) {
  const colors = t === "info" ? null : tone(t);
  return (
    <div role="status" style={{ fontSize: 13, lineHeight: 1.5, padding: "10px 14px", borderRadius: 10, border: `1px solid ${colors ? colors.border : tokens.border}`, borderLeft: `3px solid ${colors ? colors.solid : tokens.border}`, background: colors ? colors.soft : tokens.secondary, display: "grid", gap: 4, minWidth: 0, overflowWrap: "anywhere" }}>
      {children}
    </div>
  );
}

/**
 * Nothing while the Account Manager works. One line and "Fix in Setup" when
 * there is none, a hire is open, it is paused, in error or waiting for
 * approval, or a role skill is missing (then Attach skills and Re-sync fix it
 * here).
 */
export function AccountManagerBox({ hire, refresh, onMessage }: { hire: HireView | null | undefined; refresh: () => Promise<void>; onMessage: (m: string) => void }) {
  const host = useHostContext();
  const nav = useHostNavigation();
  const resync = usePluginAction("crm.resync-agent");
  const [resyncing, setResyncing] = useState(false);
  const agent = hire?.agent ?? null;
  // The page attaches the role skills (and the extras that exist) for the person viewing: a plugin worker cannot.
  const skills = useRoleSkills({ companyId: host.companyId, agent, skills: ROLE_SKILLS, extras: EXTRA_SKILLS, purpose: ROLE_SKILL_PURPOSE, onAttached: () => void refresh().catch(() => undefined) });
  if (!hire) return null;
  const problem = agentProblem({
    agent,
    hire: hire.hire,
    missingSkills: agent ? stillMissing({ checked: skills.checked, attached: Boolean(skills.note?.ok), attachFailed: skills.missing, workerMissing: hire.missingSkills }) : [],
    candidates: hire.candidates.length,
  });
  if (!problem) return null;

  async function doResync() {
    setResyncing(true);
    onMessage("");
    try {
      const r = (await resync({})) as { agent: { name: string }; instructions: string[] };
      onMessage([`Re-synced ${r.agent.name}.`, ...r.instructions].join(" "));
      await refresh();
    } catch (error) {
      onMessage(errorText(error));
    } finally {
      setResyncing(false);
    }
  }

  async function doAttach() {
    onMessage("");
    const note = await skills.attach();
    if (note) onMessage(note.line);
  }

  const busy = resyncing || skills.busy;
  return (
    <Banner tone={problem.tone}>
      <span>{problem.text}</span>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 4 }}>
        <a {...nav.linkProps(TEAM_SETUP_HREF)} style={fixLink}>Fix in Setup</a>
        {problem.skills ? (
          <>
            <Button type="button" variant="secondary" style={small} disabled={busy} onClick={() => void doAttach()}>{skills.busy ? "Attaching…" : "Attach skills"}</Button>
            <Button type="button" variant="secondary" style={small} disabled={busy} onClick={() => void doResync()}>{resyncing ? "Re-syncing…" : "Re-sync"}</Button>
          </>
        ) : null}
      </div>
    </Banner>
  );
}
