/**
 * The optional Payroll Clerk box. The clerk is hired, picked, changed or
 * removed in Setup → Team; the Payroll page shows this box only when
 * something is wrong with it: a hire open without an agent, the clerk
 * paused, in error or waiting for approval, or `pib-payroll` missing. No
 * clerk at all is fine (the role is optional). The page still attaches the
 * pib-payroll skill for the person viewing it, since the worker cannot.
 */
import type { CSSProperties } from "react";
import { useHostContext, useHostNavigation, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, tokens, tone } from "@partnersinbiz/pib-plugin-ui";
import { ROLE_SKILL_PURPOSE, ROLE_SKILLS, TEAM_SETUP_HREF, agentProblem, stillMissing } from "./role-skills.js";
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

/** "Fix in Setup": a small primary link (the host only styles its own class names). */
const fixLink: CSSProperties = { display: "inline-flex", alignItems: "center", height: 28, padding: "0 10px", borderRadius: 8, background: tokens.primary, color: tokens.primaryFg, fontSize: 12, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" };

export function ClerkBox({ hire, run }: { hire: ClerkHire | null; run: RunFn }) {
  const host = useHostContext();
  const navigation = useHostNavigation();
  const syncSkills = usePluginAction("payroll.sync-skills");
  const agent = hire?.agent ?? null;
  const skills = useRoleSkills({ companyId: host.companyId, agent, skills: ROLE_SKILLS, purpose: ROLE_SKILL_PURPOSE });
  if (!hire) return null;
  const problem = agentProblem({
    agent,
    // Older payroll state has no status: a hire record counts as open.
    hire: hire.hire ? { status: hire.hire.status ?? "open", createdAt: hire.hire.createdAt, identifier: hire.hire.identifier } : null,
    missingSkills: agent ? stillMissing({ checked: skills.checked, attached: Boolean(skills.note?.ok), attachFailed: skills.missing }) : [],
    candidates: hire.candidates?.length ?? 0,
  });
  if (!problem) return null;

  const attach = () =>
    void run(async () => {
      const note = await skills.attach();
      if (note && !note.ok) throw new Error(note.line);
      return note;
    }, "Attached the Payroll Clerk's skills.");
  const resync = () => void run(() => syncSkills({}), "Re-synced the pib-payroll skill.");
  const t = tone(problem.tone);

  return (
    <div role="status" style={{ display: "grid", gap: 8, padding: "10px 12px", borderRadius: 10, border: `1px solid ${t.border}`, borderLeft: `3px solid ${t.solid}`, background: tokens.bg, minWidth: 0 }}>
      <span style={{ fontSize: 13, lineHeight: 1.45, overflowWrap: "anywhere" }}>{problem.text}</span>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <a {...navigation.linkProps(TEAM_SETUP_HREF)} style={fixLink}>Fix in Setup</a>
        {problem.skills ? (
          <>
            <Button type="button" variant="secondary" style={small} disabled={skills.busy} onClick={attach}>{skills.busy ? "Attaching…" : "Attach skills"}</Button>
            <Button type="button" variant="secondary" style={small} disabled={skills.busy} onClick={resync}>Re-sync</Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
