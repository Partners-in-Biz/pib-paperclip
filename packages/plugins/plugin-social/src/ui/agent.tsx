/**
 * The Social agent card. The plugin never creates its agent: "Hire Social
 * agent" opens a New task popup with the hire request, and "Use an existing
 * agent" links one the company already has. The plugin wires whichever agent
 * is linked (tool access, weekly routine, failed-post issues).
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { StatusBadge, useHostContext, useHostNavigation, usePluginAction, type StatusBadgeVariant } from "@paperclipai/plugin-sdk/ui";
import { Button, Field, Modal, NewTaskDialog, Select, errorText, tokens, type TaskAssigneeOption } from "@partnersinbiz/pib-plugin-ui";
import { Banner, Card, Code, ignore, Muted, Row, SmallButton } from "./parts.js";
import type { AgentOption, HireOptions, HireRecord, LinkedBy, RunAction, SocialAgent } from "./types.js";

const SKILL_SLUGS = ["pib-social-publish", "pib-social-content"];

const AGENT_TONE: Record<string, StatusBadgeVariant> = {
  active: "ok",
  idle: "ok",
  running: "info",
  paused: "warning",
  pending_approval: "warning",
  error: "error",
};

/** Renders `code` spans in step lines. */
function Inline({ text }: { text: string }) {
  const parts = text.split("`");
  return <>{parts.map((part, i) => (i % 2 === 1 ? <Code key={i}>{part}</Code> : <span key={i}>{part}</span>))}</>;
}

function statusLabel(status: string | null): string {
  return (status ?? "unknown").replace(/_/g, " ");
}

function linkedByText(linkedBy: LinkedBy): string {
  if (linkedBy === "auto") return "Linked automatically from the hire task.";
  if (linkedBy === "manual") return "Linked by hand.";
  if (linkedBy === "managed") return "Set up before hiring moved to tasks.";
  return "";
}

function looksSocial(agent: AgentOption): boolean {
  return /social/i.test(`${agent.name} ${agent.title ?? ""}`);
}

interface Notice {
  title: string;
  lines: string[];
  hire?: HireRecord;
}

export function AgentCard({ agent, run, ownPage }: { agent: SocialAgent; run: RunAction; ownPage: boolean }) {
  const host = useHostContext();
  const navigation = useHostNavigation();
  const loadOptions = usePluginAction("social.hire-options");
  const [options, setOptions] = useState<HireOptions | null>(null);
  const [optionsError, setOptionsError] = useState("");
  const [dialog, setDialog] = useState(false);
  const [picker, setPicker] = useState<"link" | "change" | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  // Stable, so the dialogs do not refocus their first field on every render.
  const closeDialog = useCallback(() => setDialog(false), []);
  const closePicker = useCallback(() => setPicker(null), []);

  const linked = Boolean(agent.agentId);
  const openHire = !linked && agent.hire?.status === "open" ? agent.hire : null;

  const fetchOptions = useCallback(async (): Promise<HireOptions | null> => {
    try {
      const data = (await loadOptions({})) as HireOptions;
      setOptions(data);
      setOptionsError("");
      return data;
    } catch (error) {
      setOptionsError(errorText(error));
      return null;
    }
  }, [loadOptions]);

  // Without a linked agent, load the team so an existing social agent can be offered right away.
  useEffect(() => {
    if (!ownPage || linked) return;
    void fetchOptions();
  }, [ownPage, linked, agent.hire?.issueId]);

  const issueLink = (hire: HireRecord, children?: ReactNode) => (
    <a {...navigation.linkProps(`/issues/${hire.identifier ?? hire.issueId}`)} style={{ color: tokens.fg, textDecoration: "underline" }}>
      {children ?? hire.identifier ?? "the hire task"}
    </a>
  );
  const agentLink = (path: string, children: ReactNode) => (
    <a {...navigation.linkProps(`/agents/${agent.agentId}${path}`)} style={{ color: tokens.fg, textDecoration: "underline" }}>{children}</a>
  );

  const openDialog = async () => {
    setNotice(null);
    if (!options && !(await fetchOptions())) return;
    setDialog(true);
  };
  const openPicker = async (mode: "link" | "change") => {
    setNotice(null);
    setPicker(mode);
    if (!options) await fetchOptions();
  };

  const assignees: TaskAssigneeOption[] = useMemo(() => {
    const list: TaskAssigneeOption[] = (options?.agents ?? []).map((a) => ({ kind: "agent", id: a.id, name: a.name, detail: a.title ?? a.role, status: a.status }));
    if (host.userId) list.unshift({ kind: "user", id: host.userId, name: "Me" });
    return list;
  }, [options, host.userId]);

  const suggested = useMemo(() => (options?.agents ?? []).filter((a) => a.id !== agent.agentId && looksSocial(a)), [options, agent.agentId]);

  const createHire = async (task: { title: string; description: string; assigneeAgentId: string | null; assigneeUserId: string | null }) => {
    const hire = (await run("social.start-hire", task, "Hire task created")) as HireRecord;
    setDialog(false);
    setOptions(null);
    const who = task.assigneeAgentId
      ? options?.agents.find((a) => a.id === task.assigneeAgentId)?.name ?? "the agent"
      : task.assigneeUserId ? "you" : null;
    setNotice({
      title: "Hire task created",
      hire,
      lines: [
        who ? `Assigned to ${who}.` : "No assignee yet, so it is parked in Backlog.",
        "The Social plugin links the new agent automatically when it appears and comments on the task.",
      ],
    });
  };

  const linkAgent = async (agentId: string) => {
    setBusy(true);
    try {
      const res = (await run("social.link-agent", { agentId }, "Agent linked")) as { agent: AgentOption; steps: string[] };
      setPicker(null);
      setOptions(null);
      setNotice({ title: `${res.agent.name} is now the Social agent`, lines: res.steps });
    } catch {
      // run() already showed the error
    } finally {
      setBusy(false);
    }
  };

  const unlink = async () => {
    if (!window.confirm(`Stop using ${agent.name ?? "this agent"} as the Social agent? The agent itself is not changed.`)) return;
    setBusy(true);
    try {
      await run("social.unlink-agent", {}, "Agent unlinked");
      setPicker(null);
      setOptions(null);
    } catch {
      // shown by run()
    } finally {
      setBusy(false);
    }
  };

  const resync = () => {
    setBusy(true);
    setNotice(null);
    run("social.activate-agent", {})
      .then((res) => setNotice({ title: "Re-synced", lines: (res as { steps?: string[] }).steps ?? [] }))
      .catch(ignore)
      .finally(() => setBusy(false));
  };

  // ── client workspace: read-only line ──────────────────────────────────────
  if (!ownPage) {
    return (
      <Card>
        <strong style={{ fontSize: 13 }}>Social agent</strong>
        <Muted>
          {linked
            ? <>{agent.name} ({statusLabel(agent.status)}) handles this client's social work, scoped to this client.</>
            : <>No Social agent yet. Set one up on the <a {...navigation.linkProps("/social")} style={{ color: tokens.fg, textDecoration: "underline" }}>own Social page</a>.</>}
        </Muted>
      </Card>
    );
  }

  const noticeBox = notice ? (
    <Banner tone="info" title={notice.title}>
      {notice.hire ? <div>Task: {issueLink(notice.hire, `${notice.hire.identifier ? `${notice.hire.identifier} · ` : ""}${notice.hire.title}`)}</div> : null}
      {notice.lines.map((line, i) => <div key={i}>• <Inline text={line} /></div>)}
    </Banner>
  ) : null;

  let body: ReactNode;
  if (linked) {
    const paused = agent.status === "paused" || agent.status === "pending_approval";
    body = (
      <>
        <Row style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <div style={{ display: "grid", gap: 4 }}>
            <strong style={{ fontSize: 13 }}>Social agent</strong>
            <Row>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{agentLink("", agent.name ?? "Agent")}</span>
              <StatusBadge label={statusLabel(agent.status)} status={AGENT_TONE[agent.status ?? ""] ?? "pending"} />
            </Row>
            <Muted>{linkedByText(agent.linkedBy)} It gets the Social tools, the weekly planning routine and failed-post issues.</Muted>
          </div>
          <Row>
            <Button type="button" variant="secondary" disabled={busy} onClick={resync}>Re-sync</Button>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => void openPicker("change")}>Change agent</Button>
          </Row>
        </Row>
        {paused ? (
          <Banner tone="warn" title={agent.status === "pending_approval" ? "Waiting for approval" : "Paused"}>
            {agent.status === "pending_approval"
              ? <>Approve the hire under Approvals, then {agentLink("", "open the agent")} and click Resume.</>
              : <>{agentLink("", "Open the agent")} and click Resume once its adapter has a working model key. The weekly routine's trigger stays off until you enable it.</>}
          </Banner>
        ) : null}
        {agent.missingSkills.length ? (
          <Banner tone="warn" title="Attach the social skills">
            {agent.name} does not have {agent.missingSkills.map((slug, i) => <span key={slug}>{i ? " and " : ""}<Code>{slug}</Code></span>)} yet.
            {" "}Attach {agent.missingSkills.length === 1 ? "it" : "them"} on the agent's {agentLink("/skills", "Skills tab")}; the plugin cannot attach skills to an agent it did not create.
          </Banner>
        ) : null}
      </>
    );
  } else if (openHire) {
    body = (
      <>
        <Row style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <div style={{ display: "grid", gap: 4, maxWidth: 640 }}>
            <strong style={{ fontSize: 13 }}>Social agent: hire in progress</strong>
            <Muted>
              Hire task {issueLink(openHire, `${openHire.identifier ? `${openHire.identifier} · ` : ""}${openHire.title}`)} is open.
              {" "}The plugin links the new agent automatically when it appears (an agent with the social skills or the name Social Media Manager), then sets it up.
            </Muted>
          </div>
          <Row>
            <Button type="button" variant={agent.candidates.length ? "primary" : "secondary"} disabled={busy} onClick={() => void openPicker("link")}>Link agent</Button>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => void openDialog()}>Open a new hire task</Button>
          </Row>
        </Row>
        {agent.candidates.length > 1 ? (
          <Banner tone="info" title="More than one new agent matches">
            {agent.candidates.map((c) => c.name).join(", ")}. Pick the right one with Link agent.
          </Banner>
        ) : null}
        {suggested.length ? <Muted>Or use an agent you already have: {suggested.map((a) => a.name).join(", ")} (Link agent).</Muted> : null}
      </>
    );
  } else {
    body = (
      <>
        <div style={{ display: "grid", gap: 4, maxWidth: 680 }}>
          <strong style={{ fontSize: 13 }}>Social agent</strong>
          <Muted>
            No agent does the Social work yet. Hire one the way you hire every agent: a task with the full spec (name, role, adapter, skills, budget, instructions) goes to whoever hires for the company.
            {" "}Or use an agent you already have. The plugin then grants it the Social tools, assigns it the weekly planning routine and sends it failed-post issues.
          </Muted>
        </div>
        {suggested.length ? (
          <Banner tone="info" title="Already on your team">
            {suggested.map((a) => (
              <Row key={a.id} style={{ marginTop: 4 }}>
                <span><strong style={{ color: tokens.fg }}>{a.name}</strong>{a.title && a.title !== a.name ? ` · ${a.title}` : ""} ({statusLabel(a.status)})</span>
                <SmallButton disabled={busy} onClick={() => void linkAgent(a.id)}>Use this agent</SmallButton>
              </Row>
            ))}
          </Banner>
        ) : null}
        <Row>
          <Button type="button" disabled={busy} onClick={() => void openDialog()}>Hire Social agent</Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => void openPicker("link")}>Use an existing agent</Button>
        </Row>
      </>
    );
  }

  return (
    <Card>
      {body}
      {noticeBox}
      {optionsError && (dialog || picker) ? <Muted style={{ color: tokens.destructive }}>{optionsError}</Muted> : null}
      {options ? (
        <NewTaskDialog
          open={dialog}
          prefix={host.companyPrefix}
          heading="New task"
          initialTitle={options.draft.title}
          initialDescription={options.draft.description}
          assignees={assignees}
          defaultAssignee={options.defaultAssigneeAgentId ? `agent:${options.defaultAssigneeAgentId}` : undefined}
          onClose={closeDialog}
          onCreate={createHire}
          note={<>Give it to whoever hires agents for the company (usually the CEO agent), or to yourself. When the new agent appears, the Social plugin links it and sets it up.</>}
        />
      ) : null}
      <LinkPicker
        open={picker !== null}
        mode={picker ?? "link"}
        options={options}
        candidates={agent.candidates}
        currentId={agent.agentId}
        canUnlink={linked && agent.linkedBy !== "managed"}
        busy={busy}
        onClose={closePicker}
        onLink={(id) => void linkAgent(id)}
        onUnlink={() => void unlink()}
      />
    </Card>
  );
}

function LinkPicker({ open, mode, options, candidates, currentId, canUnlink, busy, onClose, onLink, onUnlink }: {
  open: boolean;
  mode: "link" | "change";
  options: HireOptions | null;
  candidates: AgentOption[];
  currentId: string | null;
  canUnlink: boolean;
  busy: boolean;
  onClose: () => void;
  onLink: (agentId: string) => void;
  onUnlink: () => void;
}) {
  const groups = useMemo(() => {
    const all = (options?.agents ?? []).filter((a) => a.id !== currentId);
    const candidateIds = new Set(candidates.map((c) => c.id));
    const matches = all.filter((a) => candidateIds.has(a.id));
    const social = all.filter((a) => !candidateIds.has(a.id) && looksSocial(a));
    const rest = all.filter((a) => !candidateIds.has(a.id) && !looksSocial(a));
    return { matches, social, rest, all };
  }, [options, candidates, currentId]);
  const first = groups.matches[0]?.id ?? groups.social[0]?.id ?? "";
  const [selected, setSelected] = useState(first);
  useEffect(() => {
    if (open) setSelected(first);
  }, [open, first]);
  const chosen = groups.all.find((a) => a.id === selected) ?? null;
  const missing = chosen ? chosen.missingSkills ?? SKILL_SLUGS : [];
  const option = (a: AgentOption) => (
    <option key={a.id} value={a.id}>{a.name}{a.title && a.title !== a.name ? ` · ${a.title}` : ""}{a.status === "paused" ? " (paused)" : ""}</option>
  );

  return (
    <Modal
      open={open}
      title={mode === "change" ? "Change the Social agent" : "Use an existing agent"}
      description="The agent you pick gets the Social plugin tools, the weekly planning routine and new failed-post issues. Nothing else about it changes."
      onClose={onClose}
      footer={(
        <>
          {canUnlink ? <Button type="button" variant="secondary" disabled={busy} onClick={onUnlink} style={{ marginRight: "auto" }}>Unlink current agent</Button> : null}
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button type="button" disabled={busy || !selected} onClick={() => onLink(selected)}>{busy ? "Linking…" : "Link agent"}</Button>
        </>
      )}
    >
      {!options ? <Muted>Loading agents…</Muted> : groups.all.length === 0 ? <Muted>No other agents in this company yet. Hire one instead.</Muted> : (
        <Field label="Agent">
          <Select value={selected} onChange={(event) => setSelected(event.target.value)} disabled={busy}>
            <option value="">Choose an agent…</option>
            {groups.matches.length ? <optgroup label="Matches the hire">{groups.matches.map(option)}</optgroup> : null}
            {groups.social.length ? <optgroup label="Social agents">{groups.social.map(option)}</optgroup> : null}
            {groups.rest.length ? <optgroup label="Other agents">{groups.rest.map(option)}</optgroup> : null}
          </Select>
        </Field>
      )}
      {chosen && missing.length ? (
        <Banner tone="warn" title="Skills to attach after linking">
          {chosen.name} does not have {missing.map((slug, i) => <span key={slug}>{i ? " and " : ""}<Code>{slug}</Code></span>)}.
          {" "}Attach {missing.length === 1 ? "it" : "them"} on the agent's Skills tab so it knows how to use the Social tools. The plugin cannot attach skills to an agent it did not create.
        </Banner>
      ) : null}
      {chosen && !missing.length ? <Muted>{chosen.name} already has both social skills.</Muted> : null}
    </Modal>
  );
}
