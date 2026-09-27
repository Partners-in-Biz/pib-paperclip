/**
 * The Social agent box. The agent is hired, picked, changed or removed in
 * Setup → Team; this page shows the box only when something is wrong (no
 * agent, a hire still open, the agent paused, in error or waiting for
 * approval, or a social skill missing), with one line and "Fix in Setup".
 * A missing skill can also be fixed right here (Attach skills, Re-sync).
 */
import { useState, type CSSProperties } from "react";
import { useHostContext, useHostNavigation, usePluginToast } from "@paperclipai/plugin-sdk/ui";
import { tokens } from "@partnersinbiz/pib-plugin-ui";
import { Banner, ignore, Row, SmallButton } from "./parts.js";
import type { RunAction, SocialAgent } from "./types.js";
import { ROLE_SKILL_PURPOSE, ROLE_SKILLS, TEAM_SETUP_HREF, agentProblem, stillMissing } from "./role-skills.js";
import { useRoleSkills } from "./use-role-skills.js";

/** "Fix in Setup": a small primary link (the host only styles its own class names). */
const fixLink: CSSProperties = { display: "inline-flex", alignItems: "center", height: 28, padding: "0 10px", borderRadius: 8, background: tokens.primary, color: tokens.primaryFg, fontSize: 12, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" };

export function AgentBox({ agent, run, ownPage }: { agent: SocialAgent; run: RunAction; ownPage: boolean }) {
  const host = useHostContext();
  const navigation = useHostNavigation();
  const toast = usePluginToast();
  const [resyncing, setResyncing] = useState(false);
  // Own page only: the page attaches the social skills to the linked agent for the person viewing (a plugin worker cannot).
  const skills = useRoleSkills({
    companyId: host.companyId,
    agent: ownPage && agent.agentId ? { id: agent.agentId, name: agent.name } : null,
    skills: ROLE_SKILLS,
    purpose: ROLE_SKILL_PURPOSE,
  });
  const missing = ownPage && agent.agentId
    ? stillMissing({ checked: skills.checked, attached: Boolean(skills.note?.ok), attachFailed: skills.missing, workerMissing: agent.missingSkills })
    : [];
  const problem = agentProblem({
    agent: agent.agentId ? { name: agent.name, status: agent.status } : null,
    // Client workspaces do not load the hire; the own page does.
    hire: ownPage ? agent.hire : null,
    missingSkills: missing,
    candidates: agent.candidates.length,
  });
  if (!problem) return null;

  const attach = async () => {
    const note = await skills.attach();
    if (note) toast({ title: note.ok ? "Skills attached" : "Skills not attached", body: note.line, tone: note.ok ? "success" : "error", ttlMs: note.ok ? 4000 : 9000 });
  };
  const resync = () => {
    setResyncing(true);
    run("social.activate-agent", {}, "Re-synced the Social agent")
      .catch(ignore)
      .finally(() => setResyncing(false));
  };
  const busy = resyncing || skills.busy;

  return (
    <Banner tone={problem.tone === "bad" ? "error" : problem.tone} title="Social agent">
      <div style={{ display: "grid", gap: 8 }}>
        <span>{problem.text}</span>
        <Row>
          <a {...navigation.linkProps(TEAM_SETUP_HREF)} style={fixLink}>Fix in Setup</a>
          {problem.skills ? (
            <>
              <SmallButton disabled={busy} onClick={() => void attach()}>{skills.busy ? "Attaching…" : "Attach skills"}</SmallButton>
              <SmallButton disabled={busy} onClick={resync}>{resyncing ? "Re-syncing…" : "Re-sync"}</SmallButton>
            </>
          ) : null}
        </Row>
      </div>
    </Banner>
  );
}
