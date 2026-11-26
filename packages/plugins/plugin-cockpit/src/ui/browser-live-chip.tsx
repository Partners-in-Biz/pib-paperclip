/**
 * "Watch live" chip (PAR-14752): shown on an issue, and on an agent's chat issue, while that agent has a live browser
 * session. It polls `browser.live.sessions` every 5 s while the tab is visible. Nothing renders for a person who may
 * not watch (the action refuses or answers no sessions), so a non-admin sees no chip. It logs nothing.
 */
import { useEffect, useState } from "react";
import type { PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import { Button } from "@partnersinbiz/pib-plugin-ui";
import { useCockpitAction } from "./actions.js";
import { BrowserLiveDrawer } from "./browser-live-drawer.js";

export const LIVE_CHIP_POLL_MS = 5_000;

interface LiveSession { agentId: string; identity: string; issue: string | null }
interface IssueFacts { identifier: string | null; conversationAgentId: string | null }

/** Which session belongs here: the issue's own, else (an agent chat) the chat agent's. Pure, for tests. */
export function pickSession(sessions: readonly LiveSession[], issue: IssueFacts | null): LiveSession | null {
  if (!issue) return null;
  return (
    sessions.find((s) => issue.identifier !== null && s.issue === issue.identifier) ??
    (issue.conversationAgentId ? sessions.find((s) => s.agentId === issue.conversationAgentId) : undefined) ??
    null
  );
}

function useIssueFacts(issueId: string | null): IssueFacts | null {
  const [facts, setFacts] = useState<IssueFacts | null>(null);
  useEffect(() => {
    if (!issueId) return;
    let stopped = false;
    fetch(`/api/issues/${encodeURIComponent(issueId)}`, { credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : null))
      .then((issue: { identifier?: unknown; conversationAgentId?: unknown } | null) => {
        if (stopped || !issue) return;
        setFacts({
          identifier: typeof issue.identifier === "string" ? issue.identifier : null,
          conversationAgentId: typeof issue.conversationAgentId === "string" ? issue.conversationAgentId : null,
        });
      })
      .catch(() => {});
    return () => { stopped = true; };
  }, [issueId]);
  return facts;
}

function useLiveSessions(enabled: boolean): LiveSession[] {
  const read = useCockpitAction("browser.live.sessions");
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === "visible") {
        try {
          const result = (await read({})) as { sessions?: LiveSession[] } | null;
          if (!stopped) setSessions(Array.isArray(result?.sessions) ? result.sessions : []);
        } catch {
          // Refused (not an owner or admin) or unreachable: no chip, and no more polling for a refused person.
          if (!stopped) setSessions([]);
          stopped = true;
          return;
        }
      }
      timer = setTimeout(() => void tick(), LIVE_CHIP_POLL_MS);
    };
    void tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
    // `read` changes identity every render; the loop reads it once per start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  return sessions;
}

export function BrowserLiveChipBody({ context }: PluginWidgetProps) {
  const companyId = context.companyId;
  const issue = useIssueFacts(context.entityType === "issue" ? context.entityId : null);
  const sessions = useLiveSessions(Boolean(companyId && issue));
  const [open, setOpen] = useState(false);
  const match = pickSession(sessions, issue);
  // Keep the viewer open on the identity it was opened with even if the session ends under it.
  const [identity, setIdentity] = useState<string | null>(null);
  if (!companyId) return null;
  return (
    <>
      {match ? (
        <Button type="button" variant="secondary" onClick={() => { setIdentity(match.identity); setOpen(true); }}>Watch live</Button>
      ) : null}
      <BrowserLiveDrawer open={open} companyId={companyId} identity={identity} onClose={() => setOpen(false)} />
    </>
  );
}
