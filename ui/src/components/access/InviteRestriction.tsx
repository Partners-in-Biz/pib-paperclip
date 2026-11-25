import { useQuery } from "@tanstack/react-query";
import type { Agent, InviteMemberRestriction } from "@paperclipai/shared";
import { describeError } from "@/api/errors";
import { pluginsApi } from "@/api/plugins";
import { Badge } from "@/components/ui/badge";
import { queryKeys } from "@/lib/queryKeys";
import { ChoiceList, agentRestrictionMarks, type ChoiceRow } from "./MemberRestriction";

/**
 * The restriction mark on an invite (PAR-12608 4.2a): the explicit choice on the invite form, and
 * the mark shown on the invite list, the join-request list and the approval screens.
 */

export type InviteRestrictionChoiceValue = "full" | "restricted";

export const INVITE_RESTRICTION_PER_COMPANY_NOTE =
  "This applies to this company only. A person restricted elsewhere joins here as you choose.";

/** True for a role an invite cannot mark restricted (the server answers 422). */
export function isProtectedInviteRole(role: string | null | undefined) {
  return role === "owner" || role === "admin";
}

/** The two lists in words; agent ids resolve to names when the agents are loaded. */
function listText(values: string[], label: (value: string) => string) {
  return values.length === 0 ? "none" : values.map(label).join(", ");
}

export function InviteRestrictionMark({
  restriction,
  isDefault,
  agents,
  emptyLabel,
}: {
  restriction: InviteMemberRestriction | null | undefined;
  /** C1b-3: the mark is the server's restricted default because no choice was recorded. */
  isDefault?: boolean;
  agents?: Agent[];
  /** Shown for an unmarked invite; nothing is rendered when omitted. */
  emptyLabel?: string;
}) {
  if (!restriction?.restricted) {
    return emptyLabel ? <span className="text-muted-foreground">{emptyLabel}</span> : null;
  }
  const agentName = (id: string) => agents?.find((agent) => agent.id === id)?.name ?? id;
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="invite-restriction-mark">
      <Badge variant="outline" className="w-fit whitespace-nowrap">restricted</Badge>
      {isDefault ? <span className="text-xs text-muted-foreground">Joins restricted: no choice was made</span> : null}
      <span className="wrap-anywhere text-xs text-muted-foreground">
        Plugins: {listText(restriction.pluginKeys, (key) => key)}
      </span>
      <span className="wrap-anywhere text-xs text-muted-foreground">
        Agents: {listText(restriction.agentIds, agentName)}
      </span>
    </div>
  );
}

const CHOICES: { value: InviteRestrictionChoiceValue; label: string; description: string }[] = [
  { value: "full", label: "Full access", description: "Joins as a normal member of this company." },
  {
    value: "restricted",
    label: "Restricted",
    description: "Works only on tasks given to them, with the plugins and agents you list.",
  },
];

/**
 * The explicit choice on the invite form. There is no default: `value` null means nothing is chosen.
 * Lists are offered only to someone who manages member permissions (the server refuses lists from
 * anyone else); everyone else marks restricted with both lists empty.
 */
export function InviteRestrictionChoice({
  companyId,
  value,
  onChange,
  required,
  humanRole,
  canSetLists,
  agents,
  pluginKeys,
  agentIds,
  onPluginKeysChange,
  onAgentIdsChange,
}: {
  companyId: string;
  value: InviteRestrictionChoiceValue | null;
  onChange: (value: InviteRestrictionChoiceValue) => void;
  required: boolean;
  humanRole: string;
  canSetLists: boolean;
  agents: Agent[];
  pluginKeys: string[];
  agentIds: string[];
  onPluginKeysChange: (keys: string[]) => void;
  onAgentIdsChange: (ids: string[]) => void;
}) {
  const roleBlocksRestriction = isProtectedInviteRole(humanRole);
  const showLists = value === "restricted" && canSetLists;
  const pluginsQuery = useQuery({
    queryKey: queryKeys.plugins.all,
    queryFn: () => pluginsApi.list(),
    enabled: showLists,
  });
  const toggle = (list: string[], set: (next: string[]) => void) => (id: string) =>
    set(list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id]);
  const pluginRows: ChoiceRow[] = (pluginsQuery.data ?? [])
    .filter((plugin) => plugin.status !== "uninstalled")
    .map((plugin) => ({
      id: plugin.pluginKey,
      label: plugin.manifestJson?.displayName ?? plugin.pluginKey,
      marks: [],
      warn: false,
      stale: false,
    }));
  const companyAgents = agents.filter((agent) => agent.companyId === companyId);
  const agentRows: ChoiceRow[] = companyAgents.map((agent) => {
    const { usable, risky, marks } = agentRestrictionMarks(agent, companyAgents);
    return { id: agent.id, label: agent.name, marks, warn: risky || !usable, stale: false };
  });

  return (
    <fieldset className="space-y-3" aria-required={required}>
      <legend className="text-sm font-medium">
        Restriction{required ? "" : " (optional while the restriction switch is off)"}
      </legend>
      <div role="radiogroup" aria-label="Restriction choice" className="rounded-xl border border-border">
        {CHOICES.map((choice, index) => {
          const disabled = choice.value === "restricted" && roleBlocksRestriction;
          return (
            <label
              key={choice.value}
              className={`flex gap-3 px-4 py-3 ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"} ${index > 0 ? "border-t border-border" : ""}`}
            >
              <input
                type="radio"
                name="invite-restriction"
                value={choice.value}
                checked={value === choice.value}
                disabled={disabled}
                onChange={() => onChange(choice.value)}
                className="mt-1 h-4 w-4 border-border text-foreground"
              />
              <span className="min-w-0 space-y-1">
                <span className="block text-sm font-medium">{choice.label}</span>
                <span className="block text-sm text-muted-foreground">
                  {disabled ? `An ${humanRole} cannot be restricted. Choose another role to restrict.` : choice.description}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      <p className="text-sm text-muted-foreground">{INVITE_RESTRICTION_PER_COMPANY_NOTE}</p>
      {required && value === null ? (
        <p role="status" className="text-sm text-destructive">
          Choose full access or restricted to create the invite.
        </p>
      ) : null}
      {value === "restricted" && !canSetLists ? (
        <p className="text-sm text-muted-foreground">
          The person joins with no plugins and no agents. Someone who manages member permissions can add them later.
        </p>
      ) : null}
      {showLists ? (
        <div className="grid gap-4 rounded-lg border border-border px-4 py-3 md:grid-cols-2">
          {pluginsQuery.isLoading ? <p className="text-sm text-muted-foreground">Loading plugins…</p> : null}
          {pluginsQuery.isError ? (
            <p className="text-sm text-destructive">Could not load plugins: {describeError(pluginsQuery.error).body}</p>
          ) : null}
          {pluginsQuery.isSuccess ? (
            <ChoiceList
              legend="Plugins open to this person"
              rows={pluginRows}
              selected={pluginKeys}
              onToggle={toggle(pluginKeys, onPluginKeysChange)}
              empty="No plugins installed."
            />
          ) : null}
          <ChoiceList
            legend="Agents this person may instruct"
            rows={agentRows}
            selected={agentIds}
            onToggle={toggle(agentIds, onAgentIdsChange)}
            empty="This company has no agents."
          />
        </div>
      ) : null}
    </fieldset>
  );
}
