import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MEMBER_RESTRICTION_MODES, type Agent, type MemberRestrictionMode } from "@paperclipai/shared";
import { AlertTriangle } from "lucide-react";
import { accessApi, type CompanyMember } from "@/api/access";
import { pluginsApi } from "@/api/plugins";
import { describeError } from "@/api/errors";
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
 * Per-person access controls on the Access page (PAR-12608 4.2, 4.7). The page
 * shows the state in words so an owner never reads a stored flag as protection.
 */

const MODE_LABELS: Record<MemberRestrictionMode, string> = {
  off: "Off",
  report: "Report only",
  enforce: "Enforce",
};

export function memberRestrictionStateLabel(mode: MemberRestrictionMode | undefined, forcedOff: boolean) {
  return mode === "enforce" && !forcedOff ? "restricted" : "flag set, not enforced";
}

/** True when the agent's adapter runs a shell on the server itself. */
export function adapterHasServerShell(adapterType: string) {
  return adapterType === "process" || (adapterType ?? "").endsWith("_local");
}

/** The marks of 4.7 for one agent: what makes listing it risky, or why it is not usable. */
export function agentRestrictionMarks(agent: Agent | undefined, agents: Agent[]) {
  if (!agent || agent.status === "terminated" || agent.status === "paused" || agent.status === "pending_approval") {
    return { usable: false, marks: ["not usable"] };
  }
  const marks: string[] = [];
  if (agent.permissions?.canCreateAgents) marks.push("may configure other agents");
  const reports = agents.filter((other) => other.reportsTo === agent.id).length;
  if (reports > 0) marks.push(`${reports} agent${reports === 1 ? " reports" : "s report"} to it`);
  marks.push(agent.adapterType);
  if (adapterHasServerShell(agent.adapterType)) marks.push("shell on the server");
  return { usable: true, marks };
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
  const current = modeQuery.data?.mode;
  const selected = draft ?? current ?? "off";
  const save = useMutation({
    mutationFn: (mode: MemberRestrictionMode) => accessApi.setMemberRestrictionMode(companyId, mode),
    onSuccess: (state) => {
      queryClient.setQueryData(queryKeys.access.memberRestrictionMode(companyId), state);
      setDraft(null);
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
              onClick={() => setDraft(mode === current ? null : mode)}
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
          onClick={() => draft && save.mutate(draft)}
        >
          {save.isPending ? "Saving…" : "Apply"}
        </Button>
        <span className="text-sm text-muted-foreground" data-testid="restriction-denied-count">
          {denied === undefined ? "…" : `${denied} would-refuse entr${denied === 1 ? "y" : "ies"} in the last 7 days`}
        </span>
      </div>
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
  agents: Agent[];
}) {
  if (!member.restricted) return <span className="text-muted-foreground">Full access</span>;
  const label = memberRestrictionStateLabel(mode, forcedOff);
  const plugins = member.restrictedPluginKeys?.length ?? 0;
  const agentIds = member.restrictedAgentIds ?? [];
  const unusable = agentIds.filter((id) => !agentRestrictionMarks(agents.find((a) => a.id === id), agents).usable).length;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Badge variant={label === "restricted" ? "default" : "outline"} className="w-fit">{label}</Badge>
      <span className="text-xs text-muted-foreground">
        {plugins} plugin{plugins === 1 ? "" : "s"}, {agentIds.length} agent{agentIds.length === 1 ? "" : "s"}
      </span>
      {unusable > 0 ? <span className="text-xs text-destructive">{unusable} listed agent{unusable === 1 ? "" : "s"} not usable</span> : null}
    </div>
  );
}

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
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [restricted, setRestricted] = useState(false);
  const [pluginKeys, setPluginKeys] = useState<string[]>([]);
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const pluginsQuery = useQuery({
    queryKey: queryKeys.plugins.all,
    queryFn: () => pluginsApi.list(),
    enabled: !!member,
  });
  useEffect(() => {
    if (!member) return;
    setRestricted(member.restricted ?? false);
    setPluginKeys(member.restrictedPluginKeys ?? []);
    setAgentIds(member.restrictedAgentIds ?? []);
  }, [member]);
  const save = useMutation({
    mutationFn: () => accessApi.setMemberRestriction(companyId, member!.id, { restricted, pluginKeys, agentIds }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.companyMembers(companyId) });
      pushToast({ title: "Member access saved", tone: "success" });
      onClose();
    },
    onError: (error) => {
      pushToast({ title: "Failed to save member access", body: describeError(error).body, tone: "error" });
    },
  });
  const toggle = (list: string[], set: (next: string[]) => void, value: string) =>
    set(list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]);
  const plugins = (pluginsQuery.data ?? []).filter((plugin) => plugin.status !== "uninstalled");
  // Listed ids that match no agent of this company stay visible so they can be removed.
  const missingAgentIds = agentIds.filter((id) => !agents.some((agent) => agent.id === id));
  if (!member) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Member access</DialogTitle>
          <DialogDescription>
            Choose what {member.user?.name || member.user?.email || member.principalId} may use when restricted.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-(--sz-60vh) space-y-5 overflow-y-auto">
          <label className="flex items-center gap-2 text-sm font-medium">
            <Checkbox checked={restricted} onCheckedChange={(value) => setRestricted(value === true)} />
            Restricted member
          </label>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Plugins open to this member</legend>
            {pluginsQuery.isLoading ? <p className="text-sm text-muted-foreground">Loading plugins…</p> : null}
            {!pluginsQuery.isLoading && plugins.length === 0 ? <p className="text-sm text-muted-foreground">No plugins installed.</p> : null}
            {plugins.map((plugin) => (
              <label key={plugin.pluginKey} className="flex min-w-0 items-center gap-2 text-sm">
                <Checkbox checked={pluginKeys.includes(plugin.pluginKey)} onCheckedChange={() => toggle(pluginKeys, setPluginKeys, plugin.pluginKey)} />
                <span className="truncate">{plugin.manifestJson?.displayName ?? plugin.pluginKey}</span>
              </label>
            ))}
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Agents this member may instruct</legend>
            {agents.length === 0 ? <p className="text-sm text-muted-foreground">This company has no agents.</p> : null}
            {[...agents.map((agent) => agent.id), ...missingAgentIds].map((id) => {
              const agent = agents.find((entry) => entry.id === id);
              const { usable, marks } = agentRestrictionMarks(agent, agents);
              return (
                <label key={id} className="flex min-w-0 items-start gap-2 text-sm">
                  <Checkbox className="mt-0.5" checked={agentIds.includes(id)} onCheckedChange={() => toggle(agentIds, setAgentIds, id)} />
                  <span className="min-w-0">
                    <span className="block truncate">{agent?.name ?? id}</span>
                    <span className={`block break-words text-xs ${usable && !marks.includes("shell on the server") ? "text-muted-foreground" : "text-destructive"}`}>
                      {marks.join(" · ")}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save access"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
