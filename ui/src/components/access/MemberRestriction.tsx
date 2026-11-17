import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MEMBER_RESTRICTION_MODES, type Agent, type MemberRestrictionMode } from "@paperclipai/shared";
import { AlertTriangle } from "lucide-react";
import { accessApi, type CompanyMember } from "@/api/access";
import { describeError } from "@/api/errors";
import { pluginsApi } from "@/api/plugins";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Per-person access state, the company switch and the per-member controls on the Access page
 * (PAR-12608 4.2, 4.7). The page shows the state in words so an owner never reads a stored flag
 * as protection.
 */

const MODE_LABELS: Record<MemberRestrictionMode, string> = {
  off: "Off",
  report: "Report only",
  enforce: "Enforce",
};

/**
 * The state in words. An unknown mode (a viewer who cannot read the switch, or the switch failed to
 * load) reads plain "flag set": a deliberate fourth wording beyond the spec 4.2 table, because the
 * page cannot honestly claim either "restricted" or "not enforced".
 */
export function memberRestrictionStateLabel(mode: MemberRestrictionMode | undefined, forcedOff: boolean) {
  if (forcedOff) return "flag set, not enforced";
  if (!mode) return "flag set";
  return mode === "enforce" ? "restricted" : "flag set, not enforced";
}

export function KillSwitchBanner() {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-xl bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        Restriction is switched off for the whole server. Flags and lists stay stored, but no company enforces them
        until the server variable is unset and the server restarts.
      </span>
    </div>
  );
}

/** The stored switch and its 7-day count; shared by the switch and the row labels. */
export function useMemberRestrictionMode(companyId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.access.memberRestrictionMode(companyId ?? ""),
    queryFn: () => accessApi.getMemberRestrictionMode(companyId!),
    enabled: !!companyId,
    staleTime: 30_000,
  });
}

export function MemberRestrictionSwitch({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const modeQuery = useMemberRestrictionMode(companyId);
  const [draft, setDraft] = useState<MemberRestrictionMode | null>(null);
  // Enforce takes effect at once for every flagged member, so it asks once more.
  const [confirmEnforce, setConfirmEnforce] = useState(false);
  const current = modeQuery.data?.mode;
  const selected = draft ?? current ?? "off";
  const save = useMutation({
    mutationFn: (mode: MemberRestrictionMode) => accessApi.setMemberRestrictionMode(companyId, mode),
    onSuccess: (state) => {
      queryClient.setQueryData(queryKeys.access.memberRestrictionMode(companyId), state);
      setDraft(null);
      setConfirmEnforce(false);
      pushToast({ title: `Restriction switch set to ${MODE_LABELS[state.mode]}`, tone: "success" });
    },
    onError: (error) => {
      pushToast({ title: "Failed to change the restriction switch", body: describeError(error).body, tone: "error" });
    },
  });

  if (modeQuery.isError) {
    return <p className="text-sm text-destructive">Could not load the restriction switch: {describeError(modeQuery.error).body}</p>;
  }

  const denied = modeQuery.data?.deniedLast7Days;
  return (
    <section aria-label="Member restriction switch" className="space-y-3 rounded-xl border border-border px-4 py-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">Member restriction</h2>
        <p className="text-sm text-muted-foreground">
          Off ignores every flag. Report only records what would be refused and lets it through. Enforce applies the flags.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div role="radiogroup" aria-label="Restriction mode" className="inline-flex flex-wrap gap-1 rounded-lg border border-border p-1">
          {MEMBER_RESTRICTION_MODES.map((mode) => (
            <Button
              key={mode}
              type="button"
              size="sm"
              role="radio"
              aria-checked={selected === mode}
              variant={selected === mode ? "default" : "ghost"}
              disabled={modeQuery.isLoading || save.isPending}
              onClick={() => {
                setDraft(mode === current ? null : mode);
                setConfirmEnforce(false);
              }}
            >
              {MODE_LABELS[mode]}
            </Button>
          ))}
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!draft || save.isPending}
          onClick={() => {
            if (!draft) return;
            if (draft === "enforce" && !confirmEnforce) setConfirmEnforce(true);
            else save.mutate(draft);
          }}
        >
          {save.isPending ? "Saving…" : confirmEnforce ? "Yes, enforce" : "Apply"}
        </Button>
        <span className="text-sm text-muted-foreground" data-testid="restriction-denied-count">
          {denied === undefined ? "…" : `${denied} would-refuse entr${denied === 1 ? "y" : "ies"} in the last 7 days`}
        </span>
      </div>
      {confirmEnforce ? (
        <p role="status" className="text-sm text-destructive">
          Enforce restricts every flagged member now. Click Yes, enforce to confirm.
        </p>
      ) : null}
    </section>
  );
}

export function MemberRestrictionSummary({
  member,
  mode,
  forcedOff,
  agents,
}: {
  member: CompanyMember;
  mode: MemberRestrictionMode | undefined;
  forcedOff: boolean;
  /** The company's agents; when given, listed agents that cannot run for him are counted. */
  agents?: Agent[];
}) {
  if (!member.restricted) return <span className="whitespace-nowrap text-muted-foreground">Full access</span>;
  const label = memberRestrictionStateLabel(mode, forcedOff);
  const plugins = member.restrictedPluginKeys?.length ?? 0;
  const agentIds = member.restrictedAgentIds ?? [];
  const unusable = agents
    ? agentIds.filter((id) => !agentRestrictionMarks(agents.find((agent) => agent.id === id), agents).usable).length
    : 0;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Badge variant={label === "restricted" ? "default" : "outline"} className="w-fit whitespace-nowrap">{label}</Badge>
      <span className="whitespace-nowrap text-xs text-muted-foreground">
        {plugins} plugin{plugins === 1 ? "" : "s"}, {agentIds.length} agent{agentIds.length === 1 ? "" : "s"}
      </span>
      {unusable > 0 ? (
        <span className="whitespace-nowrap text-xs text-destructive">
          {unusable} listed agent{unusable === 1 ? "" : "s"} not usable
        </span>
      ) : null}
    </div>
  );
}

/** Adapters that give the agent a shell on the server (the set the agent routes guard as local). */
export function adapterHasServerShell(adapterType: string) {
  return adapterType === "process" || adapterType === "paperclip_runner" || adapterType.endsWith("_local");
}

const UNUSABLE_AGENT_STATUSES = new Set(["paused", "terminated", "pending_approval"]);

export type AgentRestrictionMarks = { usable: boolean; risky: boolean; marks: string[] };

/**
 * The marks of 4.7 beside an agent: what makes listing it risky, and why it cannot run for him.
 * `agent` undefined means the id matches no agent of this company (deleted, or never one of ours).
 */
export function agentRestrictionMarks(agent: Agent | undefined, agents: Agent[]): AgentRestrictionMarks {
  if (!agent) return { usable: false, risky: false, marks: ["no longer an agent of this company"] };
  const usable = !UNUSABLE_AGENT_STATUSES.has(agent.status);
  const marks: string[] = usable ? [] : [`not usable: ${agent.status.replace("_", " ")}`];
  const configures = agent.permissions?.canCreateAgents === true;
  if (configures) marks.push("may configure other agents");
  const reports = agents.filter((other) => other.reportsTo === agent.id).length;
  if (reports > 0) marks.push(`${reports} agent${reports === 1 ? " reports" : "s report"} to it`);
  marks.push(agent.adapterType);
  const shell = adapterHasServerShell(agent.adapterType);
  if (shell) marks.push("shell on the server");
  return { usable, risky: configures || shell, marks };
}

type ChoiceRow = { id: string; label: string; marks: string[]; warn: boolean; stale: boolean };

function ChoiceList({
  legend,
  rows,
  selected,
  onToggle,
  empty,
}: {
  legend: string;
  rows: ChoiceRow[];
  selected: string[];
  onToggle: (id: string) => void;
  empty: string;
}) {
  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="text-sm font-medium">{legend}</legend>
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">{empty}</p> : null}
      {rows.map((row) => (
        <label key={row.id} data-choice={row.id} className="flex min-w-0 items-start gap-2 text-sm">
          <Checkbox
            className="mt-0.5"
            checked={selected.includes(row.id)}
            onCheckedChange={() => onToggle(row.id)}
            aria-label={row.label}
          />
          <span className="min-w-0 flex-1">
            <span className="block break-words">{row.label}</span>
            {row.marks.length > 0 ? (
              <span className={`block break-words text-xs ${row.warn || row.stale ? "text-destructive" : "text-muted-foreground"}`}>
                {row.marks.join(" · ")}
              </span>
            ) : null}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** The flag, the plugin list and the agent list of one member, saved in one PUT (4.2). */
export function MemberRestrictionDialog({
  companyId,
  member,
  agents,
  onClose,
}: {
  companyId: string;
  member: CompanyMember | null;
  agents: Agent[];
  onClose: () => void;
}) {
  if (!member) return null;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-(--sz-calc-18) max-w-2xl flex-col">
        <MemberRestrictionForm key={member.id} companyId={companyId} member={member} agents={agents} onClose={onClose} />
      </DialogContent>
    </Dialog>
  );
}

function MemberRestrictionForm({
  companyId,
  member,
  agents,
  onClose,
}: {
  companyId: string;
  member: CompanyMember;
  agents: Agent[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  // Seeded once per opened member, so a members refetch does not wipe edits in progress.
  const [restricted, setRestricted] = useState(member.restricted ?? false);
  const [pluginKeys, setPluginKeys] = useState<string[]>(member.restrictedPluginKeys ?? []);
  const [agentIds, setAgentIds] = useState<string[]>(member.restrictedAgentIds ?? []);
  const pluginsQuery = useQuery({ queryKey: queryKeys.plugins.all, queryFn: () => pluginsApi.list() });
  const save = useMutation({
    mutationFn: () => accessApi.setMemberRestriction(companyId, member.id, { restricted, pluginKeys, agentIds }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.companyMembers(companyId) });
      pushToast({ title: "Member access saved", tone: "success" });
      onClose();
    },
    onError: (error) => {
      pushToast({ title: "Failed to save member access", body: describeError(error).body, tone: "error" });
    },
  });
  const toggle = (set: (update: (list: string[]) => string[]) => void) => (id: string) =>
    set((list) => (list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id]));

  const installed = (pluginsQuery.data ?? []).filter((plugin) => plugin.status !== "uninstalled");
  // Stored entries the server would refuse come first, checked, so the owner removes them on purpose.
  const pluginRows: ChoiceRow[] = [
    ...pluginKeys
      .filter((key) => !installed.some((plugin) => plugin.pluginKey === key))
      .map((key) => ({ id: key, label: key, marks: ["no longer installed"], warn: true, stale: true })),
    ...installed.map((plugin) => ({
      id: plugin.pluginKey,
      label: plugin.manifestJson?.displayName ?? plugin.pluginKey,
      marks: [],
      warn: false,
      stale: false,
    })),
  ];
  // Only agents of this company can be chosen, whatever the agents list holds.
  const companyAgents = agents.filter((agent) => agent.companyId === companyId);
  const agentRows: ChoiceRow[] = [
    ...agentIds.filter((id) => !companyAgents.some((agent) => agent.id === id)),
    ...companyAgents.map((agent) => agent.id),
  ].map((id) => {
    const agent = companyAgents.find((entry) => entry.id === id);
    const { usable, risky, marks } = agentRestrictionMarks(agent, companyAgents);
    return { id, label: agent?.name ?? id, marks, warn: risky || !usable, stale: !agent };
  });
  const staleChecked = [...pluginRows, ...agentRows].filter((row) => row.stale).length;
  const displayName = member.user?.name || member.user?.email || member.principalId;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Member access</DialogTitle>
        <DialogDescription className="break-words">
          What {displayName} may use while restricted. The lists are stored with the flag off too.
        </DialogDescription>
      </DialogHeader>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto">
        <label className="flex items-center gap-2 text-sm font-medium">
          <Checkbox checked={restricted} onCheckedChange={(value) => setRestricted(value === true)} aria-label="Restricted member" />
          Restricted member
        </label>
        {pluginsQuery.isLoading ? <p className="text-sm text-muted-foreground">Loading plugins…</p> : null}
        {pluginsQuery.isError ? (
          <p className="text-sm text-destructive">Could not load plugins: {describeError(pluginsQuery.error).body}</p>
        ) : null}
        {pluginsQuery.isSuccess ? (
          <ChoiceList
            legend="Plugins open to this member"
            rows={pluginRows}
            selected={pluginKeys}
            onToggle={toggle(setPluginKeys)}
            empty="No plugins installed."
          />
        ) : null}
        <ChoiceList
          legend="Agents this member may instruct"
          rows={agentRows}
          selected={agentIds}
          onToggle={toggle(setAgentIds)}
          empty="This company has no agents."
        />
      </div>
      {staleChecked > 0 ? (
        <p className="text-sm text-destructive">Untick the entries marked no longer installed or no longer an agent of this company to save.</p>
      ) : null}
      <DialogFooter className="sm:justify-between">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending || !pluginsQuery.isSuccess || staleChecked > 0}>
          {save.isPending ? "Saving…" : "Save access"}
        </Button>
      </DialogFooter>
    </>
  );
}
