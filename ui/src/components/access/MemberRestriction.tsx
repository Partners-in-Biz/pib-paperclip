import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MEMBER_RESTRICTION_MODES, type MemberRestrictionMode } from "@paperclipai/shared";
import { AlertTriangle } from "lucide-react";
import { accessApi, type CompanyMember } from "@/api/access";
import { describeError } from "@/api/errors";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Per-person access state and the company switch on the Access page (PAR-12608 4.2). The page
 * shows the state in words so an owner never reads a stored flag as protection.
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
}: {
  member: CompanyMember;
  mode: MemberRestrictionMode | undefined;
  forcedOff: boolean;
}) {
  if (!member.restricted) return <span className="whitespace-nowrap text-muted-foreground">Full access</span>;
  const label = memberRestrictionStateLabel(mode, forcedOff);
  const plugins = member.restrictedPluginKeys?.length ?? 0;
  const agents = member.restrictedAgentIds?.length ?? 0;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Badge variant={label === "restricted" ? "default" : "outline"} className="w-fit whitespace-nowrap">{label}</Badge>
      <span className="whitespace-nowrap text-xs text-muted-foreground">
        {plugins} plugin{plugins === 1 ? "" : "s"}, {agents} agent{agents === 1 ? "" : "s"}
      </span>
    </div>
  );
}
