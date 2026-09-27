import { useCallback, useEffect, useRef, useState } from "react";
import { attachIfMissing, attachRoleSkills, type RoleSkill, type SkillNote } from "./role-skills.js";

/**
 * Keeps the linked agent's role skills attached for the person viewing the
 * page: once per agent per page visit it attaches what is missing (the page
 * runs as the board user; a plugin worker cannot). `missing` says a skill is
 * still missing afterwards, and `attach()` tries again (the agent box's
 * Attach skills button).
 */
export function useRoleSkills(input: {
  companyId: string | null | undefined;
  agent: { id: string; name: string | null } | null;
  skills: RoleSkill[];
  purpose: string;
  onAttached?: () => void;
}) {
  const { companyId, agent, skills, purpose } = input;
  const agentId = agent?.id ?? null;
  const agentName = agent?.name || "The agent";
  const handled = useRef(new Set<string>());
  const onAttached = useRef(input.onAttached);
  onAttached.current = input.onAttached;
  const [note, setNote] = useState<(SkillNote & { agentId: string }) | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!companyId || !agentId || handled.current.has(agentId)) return;
    handled.current.add(agentId);
    void attachIfMissing({ agentId, agentName, companyId, skills })
      .catch(() => null)
      .then((result) => {
        setChecked((prev) => [...prev, agentId]);
        if (!result) return;
        setNote({ agentId, ...result });
        if (result.ok) onAttached.current?.();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, agentId]);

  const attach = useCallback(async (): Promise<SkillNote | null> => {
    if (!agentId) return null;
    setBusy(true);
    try {
      const result = await attachRoleSkills({ agentId, agentName, companyId, skills, purpose });
      setNote({ agentId, ...result });
      if (result.ok) onAttached.current?.();
      return result;
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, agentId, agentName]);

  const current = note && note.agentId === agentId ? note : null;
  return {
    /** What the page did about this agent's skills (null when nothing was missing). */
    note: current,
    /** The page-load check for this agent has finished. */
    checked: Boolean(agentId && checked.includes(agentId)),
    /** A role skill is still missing: the page could not attach it. */
    missing: Boolean(current && !current.ok),
    /** Attach skills is running. */
    busy,
    /** Attach the role's skills now; resolves with what happened. */
    attach,
  };
}
