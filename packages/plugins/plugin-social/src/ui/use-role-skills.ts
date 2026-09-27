import { useCallback, useEffect, useRef, useState } from "react";
import { attachIfMissing, attachOnLink, type RoleSkill, type SkillNote } from "./role-skills.js";

/**
 * Keeps the linked agent's role skills attached for the person viewing the
 * page: once per agent per page visit it attaches what is missing and keeps a
 * short note. `afterLink` does the same right after a manual link and returns
 * the line to show with the link result.
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
  const [attached, setAttached] = useState<string[]>([]);

  useEffect(() => {
    if (!companyId || !agentId || handled.current.has(agentId)) return;
    handled.current.add(agentId);
    void attachIfMissing({ agentId, agentName, companyId, skills }).then((result) => {
      if (!result) return;
      setNote({ agentId, ...result });
      if (result.ok) {
        setAttached((prev) => [...prev, agentId]);
        onAttached.current?.();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, agentId]);

  /** Call before the link action, so the page-load attach does not run twice for it. */
  const claim = useCallback((id: string) => {
    handled.current.add(id);
  }, []);
  /** The link failed: let the page-load attach handle this agent later. */
  const release = useCallback((id: string) => {
    handled.current.delete(id);
  }, []);
  const afterLink = useCallback(
    async (id: string, name: string): Promise<SkillNote> => {
      handled.current.add(id);
      const result = await attachOnLink({ agentId: id, agentName: name, companyId, skills, purpose });
      if (result.ok) setAttached((prev) => [...prev, id]);
      return result;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [companyId],
  );

  return {
    /** The page-load note for the agent linked now (null when nothing happened). */
    note: note && note.agentId === agentId ? note : null,
    dismiss: () => setNote(null),
    /** True once this page attached the skills to that agent. */
    attachedTo: (id: string | null | undefined) => Boolean(id && attached.includes(id)),
    claim,
    release,
    afterLink,
  };
}
